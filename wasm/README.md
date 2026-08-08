# WebAssembly backends

The WebAssembly build is headless and exposes small C ABIs for loading NES, SNES, or Mega Drive ROMs, running one frame at a time, and reading video, audio, and error buffers.

## Build

Cross-builds need the native `sourcery` resource compiler first:

```sh
cmake -S . -B build_native -DARES_BUILD_DESKTOP=OFF -DARES_CORES=sfc -DARES_ENABLE_CHD=OFF
cmake --build build_native --target sourcery

emcmake cmake -S . -B build_wasm -DCMAKE_BUILD_TYPE=Release -Dsourcery_DIR="$PWD/build_native"
cmake --build build_wasm --target ares-fc-wasm ares-sfc-wasm ares-md-wasm
```

The outputs are `build_wasm/wasm/ares-fc.mjs`, `ares-sfc.mjs`, and `ares-md.mjs` plus their `.wasm` and, where packaged resources are needed, `.data` companions. Pass a `locateFile` callback when those files are not served from the importing script's directory.

## Verify

```sh
cmake --build build_wasm --target libco-wasm-smoke
node build_wasm/wasm/libco-wasm-smoke.js
node wasm/fc-smoke.mjs build_wasm/wasm/ares-fc.mjs
node wasm/smoke.mjs build_wasm/wasm/ares-sfc.mjs
node wasm/md-smoke.mjs build_wasm/wasm/ares-md.mjs
```

The smoke tests create minimal iNES, LoROM, and Mega Drive images in memory and require one video frame and one frame's worth of stereo audio from each core. They check liveness, not fidelity; see the APU sync section for the SNES audio comparison harness.

## APU sync granularity (SNES)

The SMP advances two APU clocks per cycle and the DSP advances twenty-four per tick, an exact 1:1
ratio, so every SPC700 cycle forces a cothread switch — roughly 34,000 per frame. Native builds pay
a few nanoseconds each; under Emscripten every switch is an Asyncify unwind and rewind through the
whole SPC700 interpreter, which cost about half of all frame time.

The web build can therefore catch the DSP up in batches. DSP register reads and writes still
synchronize exactly, so only direct APU RAM sharing observes the lag — but that covers sample, echo,
and streaming memory ordering, so the core default stays cycle-exact and a frontend opts in
explicitly. `ares_sfc_set_dsp_sync_granularity` sets how many SMP cycles may pass between catch-ups:
`1` is the default and is cycle-exact, `8` is about 3.9 µs of DSP lag. The SNES preview page requests
`8` and exposes a selector so the setting can be A/B'd while a game runs.

The build is unchanged off the web: the batching, the counter reset, and the tunable are all behind
`PLATFORM_WEB`, and the batch phase reuses the already-serialized `io.dspCounter` rather than adding
a platform-specific save-state field.

Measured with `wasm/smoke.mjs` under Node 24, headless, on an idle ROM:

| granularity     | ms/frame | fps  | switches/frame |
|-----------------|----------|------|----------------|
| 1 (default)     | 15.8     | 63   | 35,170         |
| 4               | 8.7      | 115  | 10,528         |
| 8 (preview)     | 6.0      | 168  | 5,789          |
| 16              | 5.1      | 197  | 3,419          |
| 32              | 4.4      | 229  | 2,235          |

That ROM parks the 65816 in a branch-to-self and never touches the APU, so it says nothing about
fidelity: its "audio" is denormal silence at an RMS of 1e-25, and any two granularities agree on it
trivially. `wasm/dsp-sweep.mjs` exists for the fidelity question instead. It boots
`wasm/dsp-stress-rom.mjs`, which uploads an SPC700 program over the IPL protocol, keys on four BRR
voices at different pitches, and enables the echo unit so the DSP writes back into APU RAM. It then
compares the whole concatenated sample stream against cycle-exact — not per-frame hashes, because
batching shifts where a frame boundary falls and a per-frame hash flags that as a difference even
when the waveform is identical.

```sh
node wasm/dsp-sweep.mjs build_wasm/wasm/ares-sfc.mjs
```

`static` is a normal workload: voices plus echo, sample data left alone. `streaming` additionally
rewrites a BRR data byte from the SMP as fast as the SPC700 can, so both processors race on one APU
RAM byte — a deliberate worst case, not something a real game does.

| granularity | static                | streaming            |
|-------------|-----------------------|----------------------|
| 4           | identical             | 30.6% differ, 25.8 dB SNR |
| 8           | identical             | 47.3% differ, 23.9 dB SNR |
| 16          | 89.0 dB SNR           | 60.0% differ, 21.6 dB SNR |
| 32          | 89.0 dB SNR           | 81.2% differ, 19.4 dB SNR |
| 128         | 83.8 dB SNR           | 86.5% differ, 18.3 dB SNR |

Video is identical at every granularity in both modes. Two things follow. Granularity 8 is
bit-identical on a realistic APU workload, which is what justifies it as the preview default — and
the streaming column shows that is a real negative result rather than a blind test, because the
sweep does detect the hazard when it is present. And the hazard is genuine: a title that rewrites
sample data underneath a playing voice will diverge audibly, so keep the core default at 1 and treat
anything above 8 as unvalidated.

## SNES browser preview

Serve the repository root after building, then open `/wasm/sfc-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## NES browser preview

Serve the repository root after building, then open `/wasm/fc-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## Mega Drive browser preview

Serve the repository root after building, then open `/wasm/md-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## ABI

- `ares_fc_*`, `ares_sfc_*`, and `ares_md_*` expose the same lifecycle, frame, video, audio, input, allocation, and error operations for NES, SNES, and Mega Drive respectively.
- `*_run_frame` returns at the next video frame; its return type is intentionally `void` because it crosses Asyncify Fiber switches.
- Video is tightly packed 32-bit ares pixels; audio is interleaved stereo `float` samples for the last frame.
- `*_set_audio_frequency` resamples audio to the host output rate and may be called before or after loading a cartridge.
- `ares_sfc_set_dsp_sync_granularity` and `ares_sfc_dsp_sync_granularity` control APU sync batching; see the section above.
- `*_set_input` sets a controller mask for player `0` or `1`; `*_error` returns the last load error as UTF-8.

NES input bits are Up, Down, Left, Right, B, A, Select, and Start from bit 0 through bit 7. SNES adds Y, X, L, and R before Select and Start, using bits 0 through 11. Mega Drive input bits are Up, Down, Left, Right, A, B, C, Start, X, Y, Z, and Mode from bit 0 through bit 11.
