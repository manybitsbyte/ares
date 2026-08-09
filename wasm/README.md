# WebAssembly backends

The WebAssembly build is headless and exposes small C ABIs for loading NES, SNES, Master System, or Mega Drive ROMs, running one frame at a time, and reading video, audio, and error buffers.

## Build

Cross-builds need the native `sourcery` resource compiler first:

```sh
cmake -S . -B build_native -DARES_BUILD_DESKTOP=OFF -DARES_CORES=sfc -DARES_ENABLE_CHD=OFF
cmake --build build_native --target sourcery

emcmake cmake -S . -B build_wasm -DCMAKE_BUILD_TYPE=Release -Dsourcery_DIR="$PWD/build_native"
cmake --build build_wasm --target ares-fc-wasm ares-sfc-wasm ares-ms-wasm ares-md-wasm
```

Configure with `-DARES_WASM_PROFILE=ON` to link with `--profiling-funcs`, which keeps function names
in the wasm so `node --cpu-prof` reports `ares::Famicom::CPU::main` rather than
`wasm-function[1212]`. Turn it back off for anything you intend to measure.

The outputs are `build_wasm/wasm/ares-fc.mjs`, `ares-sfc.mjs`, `ares-ms.mjs`, and `ares-md.mjs` plus their `.wasm` and, where packaged resources are needed, `.data` companions. Pass a `locateFile` callback when those files are not served from the importing script's directory.

## Verify

```sh
cmake --build build_wasm --target libco-wasm-smoke
node build_wasm/wasm/libco-wasm-smoke.js
node wasm/fc-smoke.mjs build_wasm/wasm/ares-fc.mjs
node wasm/smoke.mjs build_wasm/wasm/ares-sfc.mjs
node wasm/ms-smoke.mjs build_wasm/wasm/ares-ms.mjs
node wasm/md-smoke.mjs build_wasm/wasm/ares-md.mjs
```

The smoke tests create minimal iNES, LoROM, Master System, and Mega Drive images in memory and require one video frame and one frame's worth of stereo audio from each core. They check liveness, not fidelity; see the APU sync section for the SNES audio comparison harness.

## APU sync granularity (SNES)

The SMP advances two APU clocks per cycle and the DSP advances twenty-four per tick, an exact 1:1
ratio, so every SPC700 cycle used to force a cothread switch — roughly 35,000 per frame. Native
builds pay a few nanoseconds each; under Emscripten every switch is an Asyncify unwind and rewind
through the whole SPC700 interpreter, which cost about half of all frame time and held cycle-exact
to ~63 fps headless.

The web build now sidesteps the tax the same way the NES core does: it never enters the DSP
cothread while running. The S-DSP holds no essential state in its cothread's program counter — its
`main()` is one 32-tick sample cycle — so it gained `runCycle()`, a tick-at-a-time twin that
dispatches on a transient phase counter, and `SMP::catchUpDSP()` runs it as plain function calls on
the SMP's own cothread. `DSP::tick()` notices it is not on its own cothread and simply returns
instead of switching back. Only ~1,050 switches per frame remain (the per-scanline CPU↔SMP and
CPU↔PPU round-trips plus frame boundaries), and cycle-exact runs at ~270 fps headless on the idle
ROM, ~330 fps on the DSP stress workload. The full concatenated sample stream and every framebuffer
at granularity 1 hash identically to the unmodified cothread build on both the static and streaming
stress workloads.

The catch-up can additionally be batched. DSP register reads and writes still synchronize exactly,
so only direct APU RAM sharing observes the lag — but that covers sample, echo, and streaming
memory ordering, so the core default stays cycle-exact and a frontend opts in explicitly.
`ares_sfc_set_dsp_sync_granularity` sets how many SMP cycles may pass between catch-ups: `1` is the
default and is cycle-exact, `8` is about 3.9 µs of DSP lag. With the cothread ping-pong gone the
batching no longer buys measurable throughput (g=1 and g=8 are within noise), but the tunable and
its semantics are kept. The SNES preview page exposes a selector so the setting can be A/B'd while
a game runs.

The build is unchanged off the web: the flat stepper, the batching, the counter reset, and the
tunable are all behind `PLATFORM_WEB`. The phase counter is purely transient scheduling state and
is deliberately not serialized; the batch phase reuses the already-serialized `io.dspCounter`, so
the save-state layout is identical everywhere.

Measured with `wasm/smoke.mjs` under Node 24, headless, on an idle ROM:

| granularity     | ms/frame | fps  | switches/frame |
|-----------------|----------|------|----------------|
| 1 (default)     | 3.7      | 270  | 1,050          |
| 8               | 3.7      | 270  | 1,050          |

(before the synchronous DSP: granularity 1 was 15.8 ms/frame, 63 fps, 35,170 switches/frame, and
granularity 8 was 6.0 ms/frame, 168 fps, 5,789 switches/frame)

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
bit-identical on a realistic APU workload — and the streaming column shows that is a real negative
result rather than a blind test, because the sweep does detect the hazard when it is present.
The preview page defaults to cycle-exact now that it is full speed. And the hazard is genuine: a title that rewrites
sample data underneath a playing voice will diverge audibly, so keep the core default at 1 and treat
anything above 8 as unvalidated.

## Sync granularity (NES)

The NES paid the same tax as the SNES, worse. Its PPU and APU both run off the CPU clock, so the
CPU's `Thread::synchronize()` at the end of every cycle switched to each of them and back — about
119,000 switches per frame, exactly four per CPU cycle, against the SNES's 35,000. Profiling the
headless build put `CPU::main` (the whole inlined 6502 interpreter) at 30% of self time and the
Asyncify and fiber machinery around it at another 37%. The preview ran at 13 fps.

The web build now sidesteps the tax entirely: it never enters the APU or PPU cothreads while
running. Neither chip holds any state in its cothread's program counter — the APU's `main()` was
already one cycle per call, and the PPU gained `runCycle()`, a dot-at-a-time twin of
`renderScanline()` that derives everything from `io.lx` plus a small transient fetch struct — so
`CPU::catchUpAPU()` and `CPU::catchUpPPU()` run them as plain function calls on the CPU's own
cothread. Timing is unchanged: the full audio stream and every framebuffer at cycle-exact hash
identically to the unmodified cothread build, with and without the DMC. Only the 17 host↔CPU
frame-boundary switches remain, and cycle-exact runs at ~265 fps headless — batching now buys
about 5%.

The granularity tunables remain, from before the direct catch-up landed, and still control how
many CPU cycles may pass between catch-ups. `ares_fc_set_ppu_sync_granularity` and
`ares_fc_set_apu_sync_granularity` set how many CPU cycles may pass before that component is caught
up; `1` is the default everywhere and is cycle-exact. The preview page defaults to `1` and exposes
a selector so the setting can be A/B'd while a game runs.

The two are not equally safe, and they are separated for that reason.

**The PPU is exact at any granularity.** Everything the CPU pulls from it — every `$2000-$3fff`
access — catches it up first, and the one thing the PPU pushes, the NMI line, is only ever *acted
on* at an instruction boundary, so `CPU::lastCycle()` catches it up there too. A 6502 latches its
interrupt inputs at that single point and nowhere else, which makes NMI delivery cycle-exact no
matter how far `CPU::step` batched. What batching does change is what a cartridge board sees of the
PPU between those points — the A12 line an MMC3-style scanline counter watches — which is why it is
still opt-in.

**The APU is exact up to 8.** Its two IRQ lines can arrive up to the granularity late, which is
harmless through 8 and starts moving a mid-frame scroll write at 12. The DMC is different in kind:
its DMA request steals a CPU cycle, so deferring it moves every subsequent bus access. But that
request is rare — `dmc.cpp` raises it only when the bit counter wraps, which even at the fastest
rate is once per 432 CPU cycles, plus a two-or-three cycle delay at sample start. So rather than
leave it to the frontend, `CPU::step` holds the APU cycle-exact across just the window the request
can land in. Pinning it for whole samples instead would be simpler and would cost the batching win
outright on any game with continuous DMC drums — half the frame rate, for one cycle in four hundred.

### Verifying

`wasm/fc-stress-rom.mjs` builds an NROM image that drives every affected path at once: rendering on
with an NMI handler doing OAM DMA and scroll writes, a sprite-zero split polled from the main loop,
four APU channels, the frame counter in IRQ mode, and — in `dmc` mode — a sample looping at the
fastest rate so a DMA request is nearly always outstanding. `wasm/fc-sweep.mjs` boots it and compares
whole concatenated sample streams and every video frame against cycle-exact.

```sh
node wasm/fc-sweep.mjs build_wasm/wasm/ares-fc.mjs both dmc
node wasm/fc-sweep.mjs build_wasm/wasm/ares-fc.mjs both nodmc
node wasm/fc-sweep.mjs build_wasm/wasm/ares-fc.mjs bench nodmc 8   # one config, clean timing
```

The sweep runs cycle-exact twice and reports the second as a control, so a difference is known to be
granularity and not run-to-run noise. Frame times inside a sweep are not worth quoting — each
granularity brings up a fresh module instance and the later ones run under the GC pressure of the
retained buffers — so the table below is from `bench`, one configuration per process, Node 24,
headless.

The two columns are the same ROM with the DMC off and with it looping at its fastest rate.

| granularity | fps (no DMC) | fps (DMC looping) | switches/frame | audio     | video     |
|-------------|--------------|-------------------|----------------|-----------|-----------|
| 1 (default) | 265.2        | 264.1             | 17             | identical | identical |
| 8 (preview) | 280.7        | 276.0             | 17             | identical | identical |
| 32          | 279.6        | 277.1             | 17             | identical | 180/180 frames differ |

Cycle-exact hashes identically to the unmodified cothread build, and the divergence at 16 and
above is a real negative result rather than a blind test: the sweep does detect a shifted scroll
split when one is present. Before the direct catch-up landed, cycle-exact ran at 25 fps and
granularity 8 at 116 — batching was the difference between unusable and comfortable; now it is a
~5% trim, kept because it costs nothing and carries the DMC guard. Treat anything above 8 as
unvalidated.

Native builds are untouched. The direct catch-up, the batching, the tunables, the counter resets,
and the DMC guard are all behind `PLATFORM_WEB`; the batch phases are plain `CPU` members rather
than serialized `IO` fields, and the PPU's transient fetch struct is likewise not serialized, so
the save-state layout is identical everywhere.

`ares_fc_switch_count` returns the process-wide cothread switch count. It exists for this harness.

## Device synchronization (Master System)

The Master System CPU, VDP, PSG, and optional YM2413 normally exchange cothreads at device-clock
boundaries. Under Asyncify that produced about 40,400 switches per frame and ran the generated VDP
and PSG stress ROM at 23.8 fps. The web build keeps the same clock comparisons but advances the VDP,
PSG, and YM2413 with plain calls from `CPU::step()`. The VDP's flat cycle path derives its phase from
the existing horizontal and vertical counters, so it adds no state and preserves register-access
timing. Native builds continue to use the original cothread path.

The optimized path produces two switches per frame and ran the same workload at about 389 fps. Its
complete 120-frame video and audio sequences matched the original scheduler exactly:
`86dbc7ab` and `f35130e9`.

The web frontend can additionally batch direct device catch-ups by a bounded number of Z80 clocks.
`ares_ms_set_sync_granularity` accepts `1` through `256`; `1` is the cycle-exact default. Every VDP,
PSG, and YM2413 I/O access catches the chips up first, and the VDP is caught up before the Z80 samples
interrupts between instructions. Higher values remain explicit performance levels because they can
delay other cross-device effects by the selected bound. The stress ROM's complete 120-frame video
and audio hashes matched PL1 at PL4, PL8, PL16, and PL32; batching improved this already-fast direct
path only slightly (about 343 fps at PL1 and 357 fps at PL8 in one Node 24 run).

## Device synchronization (Mega Drive)

The Mega Drive was the worst case of all: a 68000 whose every bus wait synchronized the VDP, the
Z80, the YM2612, the PSG, and two controller threads — 178,092 cothread switches per frame at
cycle-exact, 25 fps headless. The web build now advances every chip except the 68000 with plain
function calls on the caller's cothread, the same recipe as the NES and SNES cores; a web-only
early-return in `Thread::synchronize` makes a flat-advanced chip's own synchronize call a no-op, so
one generic guard covers all of them.

The YM2612 and PSG produce one sample per `main()` and the controllers advance one timer cycle per
`main()`, so they are called directly. The Z80 keeps its cothread — its interpreter is not
re-entrant-friendly to flatten — but holds no state in the cothread's program counter between
instructions, so `CPU::catchUpAPU()` steps it instruction-at-a-time by plain `APU::main()` calls;
the only semantic delta is that an instruction that overshoots the 68000's clock completes
atomically instead of yielding mid-instruction, which the audio hashes show is not observable. The
VDP gained `runCycle()`, a slot-at-a-time twin of `mainH32()`/`mainH40()`. It is two-phase because
the cothread build returns control to the CPU from *inside* a slot's `step()`, before the
`htick()`/IRQ-poll/fifo tail of that slot runs: each call first finishes the previous slot's tail
and fetch/render action, then performs the next slot's prologue, DMA, and step, leaving the VDP in
exactly the mid-tick position the cothread build is observable in.

Three details carry the fidelity. First, the 68000 samples interrupts between instructions with the
VDP where the last *wait* left it — an instruction's trailing internal cycles never synchronize —
so the CPU records how far it has stepped since its last wait and clamps the instruction-boundary
VDP catch-up to that point; the value is a delta rather than an absolute clock because
`Scheduler::exit` rebases every thread's clock at the frame boundary, mid-catch-up, and an absolute
clock goes stale across that rebase (this was a real one-scanline-skew bug). Second, with chips
running on the CPU's cothread, cothread identity no longer identifies the bus master, so
`busActive()` (natively identical to `active()`) attributes fifo stalls, refresh waits, and 32X
accesses correctly, and the bus hooks skip 68000-clock catch-ups while the Z80 is the master.
Third, when the Z80 is the master, nothing else can drain a full VDP fifo or fill the prefetch
slot, so those stall loops drain the VDP to the Z80's clock.

Two switches per frame remain (the frame-boundary scheduler exits). Cycle-exact runs at ~195 fps
headless on the idle smoke ROM (was 25) and ~89 fps on the stress ROM. Fidelity against the
unmodified cothread build at cycle-exact: the idle smoke ROM's video and audio hashes are
identical, and over 300 frames of the stress ROM the full video stream (`7d4325d5`) and the full
concatenated audio stream (`0cf944f5`) are bit-identical, as are all four stress variants over a
per-frame 60-frame comparison.

### Verifying

`wasm/md-stress-rom.mjs` builds a 68000+Z80 image that drives everything at once: H40 display with
an animated plane, HINT raster CRAM writes every four lines, VINT-driven 68k→VRAM DMA and VSRAM
scroll, four PSG channels, the Z80 hammering the YM2612 DAC at full speed with status polls and a
vblank interrupt handler, and TH-multiplexed pad polling. `wasm/md-sweep.mjs` boots it, hashes
every framebuffer and the whole audio stream, and reports switches per frame and fps.

```sh
node wasm/md-sweep.mjs build_wasm/wasm/ares-md.mjs 1 300
```

Node 24, headless, medians of three runs:

| granularity | idle ROM fps | stress ROM fps | switches/frame | stress video | stress audio |
|-------------|--------------|----------------|----------------|--------------|--------------|
| 1 (default) | 194.8        | 89.1           | 2              | identical    | identical    |
| 8           | 211.7        | 93.4           | 2              | identical    | identical    |
| 32          | 229.6        | 97.1           | 2              | identical    | identical    |

(before the direct catch-up: granularity 1 was 178,092 switches/frame at 25.1 fps, and 32 was
56,245 at 66.7 — batching was the only lever; now it trims loop overhead by ~10% and no longer
changes what this workload observes, because every direct device access still catches the affected
chip up first. That is a measurement on one brutal workload, not a broad compatibility claim, so
the default stays cycle-exact and higher values remain opt-in.)

Native builds are untouched: the catch-ups, the flat VDP stepper, the guards, and the tunables are
all behind `PLATFORM_WEB`; the VDP's slot phase and the CPU's catch-up flags are transient
scheduling state and deliberately not serialized, so the save-state layout is identical everywhere.

`ares_md_switch_count` returns the process-wide cothread switch count. It exists for this harness.

## SNES browser preview

Serve the repository root after building, then open `/wasm/sfc-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## NES browser preview

Serve the repository root after building, then open `/wasm/fc-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## Master System browser preview

Serve the repository root after building, then open `/wasm/ms-preview.html`. Choose a local ROM and
use the on-page keyboard guide; ROM contents stay in the browser. The PL selector controls the real
web-core sync granularity and defaults to cycle-exact PL1. PL4, PL8, PL16, and PL32 are opt-in A/B
settings that apply immediately, including while a game is running.

## Mega Drive browser preview

Serve the repository root after building, then open `/wasm/md-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.
The Sync selector controls the web core's real device catch-up granularity and defaults to
cycle-exact `1`, which is now also the fast setting (see the Mega Drive synchronization section
above). `4` through `32` allow that many 68000 cycles between APU, VDP, and auxiliary-device
catch-ups; direct device accesses and interrupt recognition remain exact either way, and the higher
values are kept as opt-in A/B settings that apply immediately, including while a game is running.

## ABI

- `ares_fc_*`, `ares_sfc_*`, `ares_ms_*`, and `ares_md_*` expose the same lifecycle, frame, video, audio, input, allocation, and error operations for NES, SNES, Master System, and Mega Drive respectively.
- `*_run_frame` returns at the next video frame; its return type is intentionally `void` because it crosses Asyncify Fiber switches.
- Video is tightly packed 32-bit ares pixels; audio is interleaved stereo `float` samples for the last frame.
- `*_set_audio_frequency` resamples audio to the host output rate and may be called before or after loading a cartridge.
- `ares_ms_set_sync_granularity` and `ares_ms_sync_granularity` control Master System device catch-up batching; see the section above.
- `ares_md_set_sync_granularity` and `ares_md_sync_granularity` control Mega Drive device catch-up batching; see the section above.
- `ares_sfc_set_dsp_sync_granularity` and `ares_sfc_dsp_sync_granularity` control APU sync batching; see the section above.
- `ares_fc_set_ppu_sync_granularity` and `ares_fc_set_apu_sync_granularity`, with matching getters, do the same for the NES; see the section above.
- `*_set_input` sets a controller mask for player `0` or `1`; `*_error` returns the last load error as UTF-8.

NES input bits are Up, Down, Left, Right, B, A, Select, and Start from bit 0 through bit 7. SNES adds Y, X, L, and R before Select and Start, using bits 0 through 11. Master System input bits are Up, Down, Left, Right, 1, 2, Pause, Reset, and Rapid from bit 0 through bit 8. Mega Drive input bits are Up, Down, Left, Right, A, B, C, Start, X, Y, Z, and Mode from bit 0 through bit 11.
