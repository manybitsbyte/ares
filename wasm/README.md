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

The smoke tests create minimal iNES, LoROM, and Mega Drive images in memory and require one video frame and one frame's worth of stereo audio from each core. They check liveness, not fidelity.

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
- `*_set_input` sets a controller mask for player `0` or `1`; `*_error` returns the last load error as UTF-8.

NES input bits are Up, Down, Left, Right, B, A, Select, and Start from bit 0 through bit 7. SNES adds Y, X, L, and R before Select and Start, using bits 0 through 11. Mega Drive input bits are Up, Down, Left, Right, A, B, C, Start, X, Y, Z, and Mode from bit 0 through bit 11.
