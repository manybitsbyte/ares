# WebAssembly backends

The WebAssembly build is headless and exposes small C ABIs for loading NES, SNES, Master System, or Mega Drive ROMs, running one frame at a time, and reading video, audio, and error buffers.

For what the port changes *outside* this directory — the 16 native-affecting changes, why each hook
sits where it does, the alternatives that were measured and rejected, and the rationale still
missing from the record — see [DECISIONS.md](DECISIONS.md).

## Build

Cross-builds need the native `sourcery` resource compiler first:

```sh
cmake -S . -B build_native -DARES_BUILD_DESKTOP=OFF -DARES_CORES=sfc -DARES_ENABLE_CHD=OFF
cmake --build build_native --target sourcery

emcmake cmake -S . -B build_wasm -DCMAKE_BUILD_TYPE=Release -Dsourcery_DIR="$PWD/build_native"
cmake --build build_wasm --target ares-fc-wasm ares-sfc-wasm ares-ms-wasm ares-md-wasm
```

The outputs are `build_wasm/wasm/ares-fc.mjs`, `ares-sfc.mjs`, `ares-ms.mjs`, and `ares-md.mjs` plus their `.wasm` and, where packaged resources are needed, `.data` companions. Pass a `locateFile` callback when those files are not served from the importing script's directory.

### Profiling and debug builds

Configure with `-DARES_WASM_PROFILE=ON` to link with `--profiling-funcs`, which keeps function names
in the wasm so `node --cpu-prof` reports `ares::Famicom::CPU::main` rather than
`wasm-function[1212]`. Turn it back off for anything you intend to measure.

Configure with `-DARES_WASM_DEBUG=ON` (default `OFF`) to build the instrumentation the fidelity
harnesses read. It gates `ares_<core>_switch_count`, the process-wide cothread switch counter: both
the export and the `co_switch_count++` inside `libco`'s `co_switch` disappear from a default build.
There is no native ares counterpart to that counter and it sits on the emulator's hottest path, so a
shipping build should not carry it. Every script probes for the export and reports the count as
unavailable rather than as zero when it is missing, so switch counts specifically need a debug build;
everything else the scripts check works either way.

## Verify

```sh
cmake --build build_wasm --target libco-wasm-smoke
node build_wasm/wasm/libco-wasm-smoke.js
node wasm/fc-smoke.mjs build_wasm/wasm/ares-fc.mjs
node wasm/sfc-smoke.mjs build_wasm/wasm/ares-sfc.mjs
node wasm/ms-smoke.mjs build_wasm/wasm/ares-ms.mjs
node wasm/md-smoke.mjs build_wasm/wasm/ares-md.mjs
node wasm/state-smoke.mjs build_wasm/wasm          # all four cores; takes a directory, not a module
node wasm/state-smoke.mjs build_wasm/wasm sfc     # naming cores limits the run, for -DARES_CORES builds
```

The smoke tests create minimal iNES, LoROM, Master System, and Mega Drive images in memory and require one video frame and one frame's worth of stereo audio from each core. They check liveness, not fidelity; the per-core sections below describe the fidelity harnesses.

`state-smoke.mjs` covers the save-state ABI for every core at once: it round-trips both state kinds
through the instance that produced them, hands a persistable state to a fresh instance that never saw
the replayed frames, and checks that garbage, an empty buffer, and a save with no cartridge loaded are
all refused without taking the machine down. Its discriminating checks are `restoreExact` — restoring
and immediately re-serializing must reproduce the blob byte for byte — and `advanced`, which fails a
machine that never moved and would otherwise match everything for free. Values under `reported` are
printed rather than asserted; see the save-state section for why.

## Device synchronization (SNES)

The SMP advances two APU clocks per cycle and the DSP advances twenty-four per tick, an exact 1:1
ratio, so every SPC700 cycle used to force a cothread switch — roughly 35,000 per frame. Native
builds pay a few nanoseconds each; under Emscripten every switch is an Asyncify unwind and rewind
through the whole SPC700 interpreter, which cost about half of all frame time and held cycle-exact
to ~63 fps headless.

The web build sidesteps the tax the same way the NES core does: it never enters the DSP cothread
while running. The S-DSP holds no essential state in its cothread's program counter — its `main()`
is one 32-tick sample cycle — so it gained `runCycle()`, a tick-at-a-time twin that dispatches on a
5-bit phase counter, and `SMP::catchUpDSP()` runs it as plain function calls on the SMP's own
cothread. `DSP::tick()` notices it is not on its own cothread and simply returns instead of
switching back. Under `PLATFORM_WEB`, `DSP::main()` runs `finishSample()` — `while(phase)
runCycle();` — rather than a single tick, so entering the cothread, which only the scheduler's
synchronization protocol still does, completes the sample cycle in progress and no more, exactly as
resuming the coroutine body part-way through did.

`SMP::step` catches the DSP up on every cycle. An earlier revision made that batchable through
`ares_sfc_set_dsp_sync_granularity`, and it is gone: measured across the stress workloads,
granularities 4 through 128 all landed at ~290-310 fps against a cycle-exact reference of ~315, so
the batching was slower than the thing it was meant to accelerate once the cothread ping-pong was
gone. The tunable, its counter, and its preview selector are removed, and `io.dspCounter` is back to
the unused state it has had since the v111 import — the field and its serialization stay, so the
state layout is untouched.

Only ~1,050 switches per frame remain: the per-scanline CPU↔SMP and CPU↔PPU round-trips plus frame
boundaries. Measured with `wasm/sfc-smoke.mjs` under Node 24, headless, on an idle ROM: 1,049
switches per frame at 260 fps, against 35,170 switches and 63 fps before the synchronous DSP landed.

The build is unchanged off the web: the flat stepper, the guard, and the phase counter are all behind
`PLATFORM_WEB`. The phase counter is serialized on exactly the condition `Thread::serialize()` uses
for the cothread stack — that is, on run-ahead states only — so the persistable state layout is
identical to native and no `SerializerVersion` bump is needed.

That gate is sound only because the phase is retired before a synchronized state is written, and the
DSP cannot retire it itself. `Thread::Enter` answers the scheduler's first synchronization *before*
running the entry point, so a cothread that has never run reports ready without having executed
anything — and the web DSP's cothread is entered by nothing but that protocol, so after every power,
reset, or state load the first synchronized save found it parked mid-cycle. `SMP::main()` therefore
ends with `if(scheduler.synchronizing()) dsp.finishSample();`, on the cothread the DSP is actually
advanced from; the DSP is walked after the SMP, so its own `main()` then finds nothing left to
finish. Driving the loop from the DSP's own cothread does not work — that thread never runs — and
running a whole sample cycle per visit is worse, because the DSP's position would then depend on how
many times the cothread had been entered.

With that, native and wasm produce byte-identical 265953-byte states on the smoke ROM, each build
loads the other's and lands on the same blob five frames later, and the residual drift between two
runs from one state is zero.

### Verifying

That idle ROM parks the 65816 in a branch-to-self and never touches the APU, so it says nothing about
fidelity: its "audio" is denormal silence at an RMS of 1e-25. `wasm/dsp-sweep.mjs` exists for the
fidelity question instead. It boots `wasm/dsp-stress-rom.mjs`, which uploads an SPC700 program over
the IPL protocol, keys on four BRR voices at different pitches, and enables the echo unit so the DSP
writes back into APU RAM. It then hashes the whole concatenated sample stream and every framebuffer
and checks both against literal golden hashes recorded from the cothread reference build.

```sh
node wasm/dsp-sweep.mjs build_wasm/wasm/ares-sfc.mjs
```

`static` is a normal workload: voices plus echo, sample data left alone. `streaming` additionally
rewrites a BRR data byte from the SMP as fast as the SPC700 can, so both processors race on one APU
RAM byte. The hashes are literals rather than a comparison against a second run of the same build,
because a self-referential comparison is blind to a regression in the code under test — here
`DSP::runCycle()`, the part most likely to rot. A run of that command reports 291.0 fps on `static`
and 279.5 fps on `streaming`, both hashes matching.

## Device synchronization (NES)

The NES paid the same tax as the SNES, worse. Its PPU and APU both run off the CPU clock, so the
CPU's `Thread::synchronize()` at the end of every cycle switched to each of them and back — about
119,000 switches per frame, exactly four per CPU cycle, against the SNES's 35,000. Profiling the
headless build put `CPU::main` (the whole inlined 6502 interpreter) at 30% of self time and the
Asyncify and fiber machinery around it at another 37%. The preview ran at 13 fps.

The web build sidesteps the tax entirely: it never enters the APU or PPU cothreads while running.
Neither chip holds any state in its cothread's program counter — the APU's `main()` was already one
cycle per call, and the PPU gained `runCycle()`, a dot-at-a-time twin of `renderScanline()` that
derives everything from `io.lx` plus a small fetch struct holding the locals `renderScanline()`
carries across `step()` calls — so `CPU::catchUpAPU()` and `CPU::catchUpPPU()` run them as plain
function calls on the CPU's own cothread, unconditionally, every cycle.

There was briefly a granularity tunable here too, and it bought nothing at all: the NES core measures
17 switches per frame at every granularity, because the synchronous catch-up had already eliminated
the switches the batching was meant to avoid. It shipped a four-function public ABI, a preview
selector, and a documented cartridge-timing hazard — what an MMC3-style scanline counter sees of the
A12 line between catch-ups — for no throughput, so it is removed.

Timing is unchanged against the cothread build: the full audio stream and every framebuffer hash
identically, with and without the DMC. Only the 17 host↔CPU frame-boundary switches remain, and the
stress ROM runs at ~262 fps headless under Node 24, from 25.

Writing the flat stepper surfaced one real bug in it, fixed here. `runCycle()`'s `lx == 0` case fell
through into the 257-320 arm, where `u32 sprite = (lx - 257) >> 3` underflowed; it was harmless only
because `(0 - 257) & 7` happens to match no case in the switch. The native `renderScanline()` handles
dot 0 with an explicit `step(1)` before its tile loop, so this was introduced by the twin rather than
inherited. Every arm now states both of its bounds.

Native builds are behaviorally identical: everything is behind `PLATFORM_WEB` except the extraction
of `PPU::step`'s loop body into `PPU::cycle()`, which is semantics-preserving. The PPU's `dot` fetch
struct is serialized under `PLATFORM_WEB` — it holds the in-flight fetch that the native build keeps
in its cothread's program counter, so without it a state taken mid-scanline resumed from stale tile
data.

That fetch is now retired before every synchronized state rather than serialized into one.
`renderScanline()` returns at the end of a scanline, so that is where a synchronized state finds the
native PPU, with its in-flight fetch already dead. `CPU::main()` ends with
`if(scheduler.synchronizingPrimary()) ppu.finishScanline();`, which runs the flat stepper to the same
point — on the CPU's cothread, the one the PPU is actually advanced on. The PPU's own `main()` and the
APU's now early-return under `scheduler.synchronizing()`: reaching them means the scheduler is walking
auxiliary threads to their safe points, and both chips are already there, so running a cycle would put
them one ahead of native. With that, `dot` is gated on `!scheduler.getSynchronize()` like the cothread
stack, and NES persistable states are byte-interchangeable with a native build in both directions,
with no residual drift.

`Scheduler::synchronizingPrimary()` was added for this and is used by the Master System the same way.
It is the primary-thread counterpart of the existing `synchronizing()`: true while the primary runs to
the safe point that will define the machine's. A chip advanced by plain calls never suspends inside
its own entry point, so the scheduler cannot bring it to its safe point and the caller must.

### Verifying

`wasm/fc-stress-rom.mjs` builds an NROM image that drives every affected path at once: rendering on
with an NMI handler doing OAM DMA and scroll writes, a sprite-zero split polled from the main loop,
four APU channels, the frame counter in IRQ mode, and — in `dmc` mode — a sample looping at the
fastest rate so a DMA request is nearly always outstanding.

```sh
node wasm/fc-sweep.mjs build_wasm/wasm/ares-fc.mjs both        # dmc | nodmc | both
node wasm/fc-sweep.mjs build_wasm/wasm/ares-fc.mjs nodmc 300   # one variant, 300 frames
```

Each variant runs twice in fresh module instances and run two is compared against run one, which
catches nondeterminism in the core itself. The printed hashes are what a comparison across builds is
made from: record them before a change and diff them after. Audio is hashed as one concatenated
stream rather than per frame, because a shift in where a frame boundary falls would otherwise read as
a difference even when the waveform is identical; video is hashed frame by frame, which is exact
regardless. Frame times are only worth quoting from a run of a single variant — a later instance runs
under the GC pressure of every retained buffer before it.

## Device synchronization (Master System)

The Master System CPU, VDP, PSG, and optional YM2413 normally exchange cothreads at device-clock
boundaries: 42,551 switches per frame on the stress ROM below, at 20.6 fps headless. The web build
keeps the same clock comparisons but advances the VDP, PSG, and YM2413 with plain calls from
`CPU::step()`, on every cycle. The VDP's flat cycle path derives its phase from the existing
horizontal and vertical counters, so it adds no state and preserves register-access timing. Native
builds continue to use the original cothread path.

`Thread::synchronizeExcept(vdp, psg, opll)` is kept rather than dropped as a no-op. A Paddle, Sports
Pad, Mega Mouse, or Mega Drive Fighting Pad in a controller port is a real cothread, and only that
call advances it.

Two details are worth naming. `synchronizeWeb()` carries the `scheduler.synchronizing()` bail the
other catch-up paths already had. And the OPLL guard tests `opll.node` rather than `opll.handle()`:
`OPLL::unload()` clears the node but never calls `Thread::destroy()`, so the handle outlives the
device.

The VDP's per-line visibility test lives in a transient `lineVisible` flag set once in `beginLine()`
and consumed by both `main()` and `runCycle()`, so a mid-line register write cannot retarget the line
in progress in one build but not the other. It sits outside the serialized `Latch` struct, so the
state layout is unchanged.

For save states the VDP has to be at a line boundary, because that is where the native build's
`main()` leaves it. It cannot bring itself there: `Thread::Enter` answers the scheduler's first
synchronization *before* running the entry point, so a cothread that has never run reports ready
without having executed anything — and the VDP's cothread is never entered by the web build at all.
`CPU::main()` therefore ends with
`if(scheduler.synchronizingPrimary()) while(vdp.hcounter()) vdp.runCycle();`, on the cothread the VDP
is actually advanced from, so `endLine()` can exit normally. The web VDP's `main()` is the same loop,
for the cothread reference build's benefit. `PSG::main()` and `OPLL::main()` become empty under
`PLATFORM_WEB`: `runCycle()` emits a whole sample, so those chips are already at a safe point wherever
their counters stand.

Driving it from the VDP's own cothread does not work and driving a whole line per visit is worse: the
first walks a thread that never runs, and the second advances the VDP arbitrarily far ahead of the
CPU. With the loop in `CPU::main()`, native and wasm produce byte-identical 58231-byte states, each
build loads the other's, and the residual drift between two runs from one state is zero — the lowest
of the four cores.

`ares_ms_set_model` was added along with the harness; without it the Mark III and FM paths were
unreachable from the web build, and they are exactly the paths a VDP revision difference shows up in.

### Verifying

`wasm/ms-stress-rom.mjs` builds a Z80 image exercising line and frame IRQs, mid-line `vlines()`
changes driven from both handlers, sprite overflow and collision, hcounter and vcounter polling,
three PSG tones plus noise, and an OPLL custom instrument. `wasm/ms-sweep.mjs` runs it in four
configurations — NTSC-U, PAL, Mark III with FM, and Japanese Master System with FM — against a
cothread reference build (see *Cothread reference builds* below), hashing every framebuffer and the
whole concatenated audio stream.

```sh
node wasm/ms-sweep.mjs build_wasm/wasm/ares-ms.mjs                                  # golden hashes only
node wasm/ms-sweep.mjs build_wasm/wasm/ares-ms.mjs build_wasm_cothread/wasm/ares-ms.mjs
```

All four configurations are bit-identical to the cothread build over 300 frames, video and audio, at
2 cothread switches per frame. Measured under Node 24, headless, on the NTSC-U configuration: 386 fps
against the cothread build's 20.6.

## Device synchronization (Mega Drive)

The Mega Drive was the worst case of all: a 68000 whose every bus wait synchronized the VDP, the
Z80, the YM2612, the PSG, and two controller threads — 178,092 cothread switches per frame at
cycle-exact, 25 fps headless. The web build advances every chip except the 68000 with plain
function calls on the caller's cothread, the same recipe as the NES and SNES cores; a web-only
early-return in `Thread::synchronize` makes a flat-advanced chip's own synchronize call a no-op, so
one generic guard covers all of them.

The YM2612 and PSG produce one sample per `main()` and the controllers advance one timer cycle per
`main()`, so they are called directly. The Z80 keeps its cothread — its interpreter is not
re-entrant-friendly to flatten — but holds no state in the cothread's program counter between
instructions, so `CPU::catchUpAPU()` steps it instruction-at-a-time by plain `APU::main()` calls.
The VDP gained `runCycle()`, a slot-at-a-time twin of `mainH32()`/`mainH40()`. It is two-phase
because the cothread build returns control to the CPU from *inside* a slot's `step()`, before the
`htick()`/IRQ-poll/fifo tail of that slot runs: each call first finishes the previous slot's tail
and fetch/render action, then performs the next slot's prologue, DMA, and step, leaving the VDP in
exactly the mid-tick position the cothread build is observable in.

The full synchronize is not made unconditional. `minCyclesBetweenSyncs` is upstream state that paces
synchronization per system — 0 for plain Mega Drive, 14 for 32X, 10 for Mega CD 32X, 4 for
LaserActive — and an earlier sync-granularity tunable was overwriting it. The web path now mirrors
the native structure instead, so plain Mega Drive is identical to cycle-exact behaviour and 32X and
Mega CD keep the throttle the batching had discarded.

Four details carry the fidelity. First, the 68000 samples interrupts between instructions with the
VDP where the last *wait* left it — an instruction's trailing internal cycles never synchronize —
so the CPU records how far it has stepped since its last wait and clamps the instruction-boundary
VDP catch-up to that point; the value is a delta rather than an absolute clock because
`Scheduler::exit` rebases every thread's clock at the frame boundary, mid-catch-up, and an absolute
clock goes stale across that rebase (this was a real one-scanline-skew bug). The same rebase made
`Controller::catchUp`'s caller-supplied absolute clock stale, so the Fighting Pad and Mega Mouse
overrides read `cpu.Thread::clock()` live instead, as every other catch-up in the tree does.

Second, with chips running on the CPU's cothread, cothread identity no longer identifies the bus
master, so `busActive()` (natively identical to `active()`) attributes fifo stalls, refresh waits,
and 32X accesses correctly. A single `busActive()` test replaced a set of per-flag re-entry guards
in the three catch-ups and the six bus hooks: a coprocessor bus access no longer drives CPU-clock
catch-ups from a foreign cothread, and a VDP DMA fetch no longer advances the Z80 to the 68000's
clock. Both move toward native behaviour, and both are reachable in practice — a DMA fill reading
`0xa10000` through `Bus::read` reached `synchronizeExcept` from inside a nested VDP catch-up.

Third, when the Z80 is the master, nothing else can drain a full VDP fifo or fill the prefetch
slot, so those stall loops drain the VDP to the Z80's clock.

Fourth, `_refresh` is a template parameter of `tickTail()` rather than a runtime bool. Demoting it
changed native codegen for a web-only reason; the sole runtime dispatch now sits inside the
`PLATFORM_WEB` block in `finishSlot()`, so every native instantiation constant-folds as before.

Two switches per frame remain (the frame-boundary scheduler exits). Cycle-exact runs at ~192 fps
headless on the idle smoke ROM, from 25.

Native builds are untouched: the catch-ups, the flat VDP stepper, and the guards are all behind
`PLATFORM_WEB`. `CPU::sinceWaitClock` and the VDP's web slot state are serialized on run-ahead states
only, gated exactly as `Thread::serialize()` gates the cothread stack, so the persistable layout stays
byte-identical to native. The VDP struct had previously been neither reset nor restored on that path
and resumed from whichever slot the live machine happened to be on.

Those gates are sound only because the dropped fields are retired before a synchronized state is
written, and the chips cannot retire them themselves. `Thread::Enter` answers the scheduler's first
synchronization *before* running the entry point, so a cothread that has never run reports ready
without having executed anything — and under `PLATFORM_WEB` the VDP, YM2612, PSG, and controller
cothreads are entered by nothing but that protocol. `CPU::main()` therefore ends with
`if(scheduler.synchronizingPrimary()) { vdp.finishScanline(); opn2.finishSample(); }`, on the
cothread those chips are actually advanced from; `finishScanline()` drives `stepSlot()`/`finishSlot()`
directly, because `runCycle()` always ends by stepping the next slot and so can never reach a line
boundary. Both chips are auxiliary threads and are walked after the primary, so their own `main()`
then finds nothing left to finish — and their web `main()` bodies are exactly those finishers, never
a fresh unit of work, because advancing per visit would make a chip's position depend on how many
times its cothread had been entered.

`APU::main()`, `VDP::PSG::main()`, `FightingPad::main()`, and `MegaMouse::main()` early-return under
`scheduler.synchronizing()` for the same reason from the other direction: each of those chips is
advanced a whole unit at a time by plain calls, so it is already on a unit boundary when the walk
arrives, exactly where the native build's suspended `step()` unwinds to. Running a unit there put the
Z80, PSG, and pads one ahead on every save. That was worth 15 of the 37 drift bytes on its own.

With all of it, native and wasm produce byte-identical 212031-byte persistable states on the smoke
ROM, each build loads the other's, and five frames on from each other's state they land on the same
blob again.

### Verifying

`wasm/md-stress-rom.mjs` builds a 68000+Z80 image that drives everything at once: H40 display with
an animated plane, HINT raster CRAM writes every four lines, VINT-driven 68k→VRAM DMA and VSRAM
scroll, four PSG channels, the Z80 hammering the YM2612 DAC at full speed with status polls and a
vblank interrupt handler, and TH-multiplexed pad polling. `wasm/md-sweep.mjs` runs four variants of
it — full, no-Z80, no-HINT, no-DMA — against a cothread reference build, hashing every framebuffer
and the whole concatenated audio stream.

```sh
node wasm/md-sweep.mjs build_wasm/wasm/ares-md.mjs                                     # golden hashes only
node wasm/md-sweep.mjs build_wasm/wasm/ares-md.mjs build_wasm_md_cothread/wasm/ares-md.mjs
```

That ROM used to deadlock, and the fidelity numbers taken from it before were meaningless. It
asserted Z80 reset low before waiting for bus grant, and `busgrantedCPU()` is `resLine &
busreqLatch`, so the wait never completed and the 68000 never enabled interrupts: neither interrupt
handler, the DMA, the scroll, the PSG sweep, nor the Z80 and YM2612 program had ever run. NOP-ing
each handler in turn produced byte-identical output, which is how it was proven. It now grants the
bus before releasing reset, and all four variants discriminate.

Video is bit-identical to the cothread build over 300 frames in all four variants, at 2 switches per
frame against ~174,000 and ~155 fps against ~11.5.

**Audio is bit-identical only while the Z80 is halted.** With the YM2612 DAC loop running the streams
differ, but at **38.5 dB SNR**, up from 18.7 dB. Two defects accounted for the gap between them.

The first was write timing. `CPU::catchUpAPU()` advances the Z80 an instruction at a time, so the
instruction that overshoots the 68000's clock completes atomically and its YM2612 writes landed up to
one instruction early. `APU::read`/`APU::write` now call a web-only `CPU::catchUpOPN2()` on the
YM2612 branch, which runs the chip up to the Z80's clock before the access is applied.

The second was a permanent three-sample offset between the two streams, and it is a native artifact
the web build now reproduces on purpose. `Thread::restart` calls `co_derive`, which discards whatever
the cothread was holding — so on every Z80 reset the native `OPN2::main()` loses the sample it had
just clocked. Under `PLATFORM_WEB` `OPN2::main()` holds its sample behind a `pending` flag that
`restart()` clears, dropping the same sample at the same moment. The flag is serialized under
`!scheduler.getSynchronize()`, so it costs nothing in a persistable state.

That is a genuine upstream bug, not a porting artifact: a native Mega Drive drops one YM2612 sample
per Z80 reset. It is preserved here because bit-equality with the cothread build is the thing being
measured, and it is worth reporting upstream on its own.

What is left is a sub-wait quantization the flat catch-up cannot resolve. Natively `APU::step` ends in
`Thread::synchronize(cpu)`, so a Z80 bus access happens only once the 68000 has run past it and the
YM2612 stands at the last 68000 bus wait below the Z80's clock; about 1.6% of accesses land in the
window where that wait has not yet crossed a sample boundary. Reproducing the tail means running the
68000 from inside the Z80's catch-up, which is the cothread ping-pong the port exists to remove. The
error is bounded and does not drift: stream lengths stay equal and video stays exact over 300 frames.
The sweep gates the three DAC variants on a **34 dB** floor and demands bit-equality from `no-z80`.

None of this costs throughput: still 2 switches per frame at ~160 fps, with video identical.

### 32X

`wasm/md32x-sweep.mjs` runs `wasm/md32x-stress-rom.mjs` in five configurations — full, SH2-driven,
DMA-from-I/O, no-32X-palette, and no-32X-layer — against the same cothread reference build. All five
are bit-identical in video *and* audio over 300 frames.

```sh
node wasm/md32x-sweep.mjs build_wasm/wasm/ares-md.mjs build_wasm_md_cothread/wasm/ares-md.mjs
```

The test was proven to discriminate by mutating the `minCyclesBetweenSyncs` throttle out of the 32X
path, which drops it to 10.6 dB. That throttle plus the `busActive()` guard is worth 2× throughput on
32X: 89.6 → 177.9 fps at identical output.

Loading a 32X image needs `ares_md_load_32x`, which is `ares_md_load` with the mia medium and ares
system names changed to `Mega 32X`; everything after the load is shared. Mega CD is deliberately out
of scope for the web build and is not covered here.

## Cothread reference builds

The Master System and Mega Drive cores have no batching granularity to sweep, so their fidelity
reference is a second wasm build of the same sources with the web fast paths compiled out:

```sh
emcmake cmake -S . -B build_wasm_cothread -DCMAKE_BUILD_TYPE=Release \
  -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=ms -DCMAKE_CXX_FLAGS=-DARES_MS_COTHREAD
cmake --build build_wasm_cothread --target ares-ms-wasm

emcmake cmake -S . -B build_wasm_md_cothread -DCMAKE_BUILD_TYPE=Release \
  -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=md -DCMAKE_CXX_FLAGS=-DARES_MD_COTHREAD
cmake --build build_wasm_md_cothread --target ares-md-wasm
```

Add `-DARES_WASM_DEBUG=ON` to both sides if the switch counts are wanted; the comparison itself does
not need them.

`ARES_MS_COTHREAD` and `ARES_MD_COTHREAD` undefine `PLATFORM_WEB` for one core each. The `#undef`
sits in `ares/ms/ms.hpp` and `ares/md/md.hpp` after `<ares/ares.hpp>`, so nall and the scheduler
still see a web build and only the core's own fast paths revert.

This is the strongest verification the port has. Every other check compares the web build against
itself or against hashes recorded from it; this one runs the cothread scheduler that the flat
steppers replace, in the same wasm toolchain, on the same ROM, and compares whole output streams.
A divergence is therefore attributable to the flat stepper rather than to the compiler, the host, or
run-to-run noise — and the sweeps additionally run the web build against itself as a control, so a
reported difference is known to be a divergence and not nondeterminism.

The same technique is what turned the Mega Drive audio result above from an assumption into a
measurement, in both directions: it proved video exact and it proved audio not exact.

## Save states

Save-state support is upstream ares, implemented per core; the wasm bridge only exposes it. It is
storage-agnostic — the ABI knows nothing about paths, slots, or naming conventions, and hands the
caller a byte range to do as it likes with.

```c
void      ares_<core>_state_save(int synchronize);
u32       ares_<core>_state_size(void);
const u8* ares_<core>_state_data(void);
int       ares_<core>_state_load(const u8* data, u32 size);
```

`ares_<core>_state_save` serializes the machine into a buffer that `*_state_size` and `*_state_data`
then delimit; the bytes are held by the core exactly like the video and audio buffers and stay valid
until the next save or unload. `ares_<core>_state_load` restores a blob and returns nonzero on
success. A failure leaves the reason in `*_error` and, unlike a failed `*_load` of a cartridge,
leaves a working machine behind rather than tearing the core down — a failed save is visible as a
size of `0`.

The size is read back rather than returned for the same reason `*_run_frame` returns `void`: a
synchronized save runs the scheduler to a safe point, so the call crosses an Asyncify fiber switch,
and what JavaScript observes is the value produced by the unwind rather than by the completed call.
Measured against an earlier build that did return the size, a synchronized save reported `0` on all
four cores while the state itself was taken correctly. Splitting the size out into its own export —
the same split `*_audio_frames` and `*_audio_data` already use, and for the same underlying reason —
removes the hazard rather than documenting around it.

`synchronize != 0` runs the scheduler to a synchronized safe point first and yields a *persistable*
state: every thread is at a boundary, no cothread stack is captured, and the blob is meaningful on
any machine that can load it. `synchronize == 0` yields a *run-ahead* state, taken wherever the
machine happens to be, which additionally embeds a raw copy of every thread's cothread stack — 128
KiB apiece on the web build. Those stacks hold host pointers. A run-ahead state is valid only inside
the process that produced it, for as long as that process lives, and must never be written to disk or
handed to another instance.

Each core carries its own `SerializerVersion` and validates it against a shared
`SerializerSignature`, so a state from a different ares version is rejected. The signature is shared
across *all* cores, and the versions are not unique: `fc` and `n64` are both at v153 today, which
means an `fc` state passes both of `n64`'s checks and is then misparsed as if it were an `n64` state.
Tagging a blob with the core that produced it is the caller's responsibility; the ABI does not do it
and cannot be made to without diverging from upstream.

Several fields gained serialization during the web port, all under `PLATFORM_WEB`: the NES PPU's `dot`
fetch latch, the SNES DSP's `phase`, the Mega Drive's `CPU::sinceWaitClock`, VDP slot state, and
YM2612 `pending` flag. Each holds what the native build keeps in a cothread's program counter, so a
state taken mid-cycle resumes from stale data without it. All of them are gated on
`!scheduler.getSynchronize()` — the same condition `Thread::serialize()` uses for the cothread stack —
so they appear only in run-ahead states, where the stack is being carried anyway.

Gating keeps the *layout* byte-identical to native, which is what lets these cores keep the upstream
`SerializerVersion` unbumped. But layout compatibility is not the same as correctness. A gate is only
sound if the field it drops is genuinely dead at a synchronized safe point; where it is not, the state
loads and silently loses data.

All four cores are sound: each restructures its safe point so the dropped field is provably retired,
and all four have states byte-interchangeable against a native build.

The cause in every case was `Thread::Enter`, which offers the synchronization point *before* the
entry point runs, so a chip that has not yet reached the end of its cycle still reports ready. The
Mega Drive was the last to be fixed: measured with a printf in `VDP::serialize`, `pending` read 1 at
every synchronized save, with `slot` at 1 or 3, and `OPN2::pending` read 1 at every one as well.
`CPU::sinceWaitClock` measured 0 at all of them. `CPU::main()` now ends a synchronized safe point
with `vdp.finishScanline()` and `opn2.finishSample()`, on the cothread those chips are actually
advanced from; see the Mega Drive device synchronization section.

Three things `state-smoke.mjs` reports rather than asserts, because none of them is the bridge's to
fix and all three would fail on a correct build:

- **`firstFrameMatch`.** No ares save state carries the framebuffer, so anything the source had
  already painted before the save point cannot be reproduced. On the Master System that is one
  scanline of frame 0, painted after the frame is emitted — unpassable by any ares build, native or
  web. Every later frame is drawn from scratch and *is* asserted.
- **`audioMatch` on a same-instance round trip.** Replaying frames into a resampler that already saw
  them shifts its phase; the resampler is host-side and is not serialized. The cross-instance
  comparison is the honest audio measurement, and that one is asserted.
- **`stateDriftBytes`.** Two runs from the same blob, rendering the same frames, that do not arrive
  at the same blob. Nonzero means live machine state sits outside the save state — the same defect
  class as the losses above, and a useful thermometer for it. It read 9 on the SNES before the DSP
  phase was retired at the safe point, and reads 0 now. It read 37 on the Mega Drive and reads 2:
  those two bytes are the cartridge thread's clock, and a native build measures exactly the same two
  bytes with the same values, so they are not a porting artifact.

## SNES browser preview

Serve the repository root after building, then open `/wasm/sfc-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## NES browser preview

Serve the repository root after building, then open `/wasm/fc-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## Master System browser preview

Serve the repository root after building, then open `/wasm/ms-preview.html`. Choose a local ROM and
use the on-page keyboard guide; ROM contents stay in the browser. The Model selector picks the
console: `Auto` follows the cartridge's region header, and the Mark III and NTSC-J entries add the
YM2413 FM sound unit.

## Mega Drive browser preview

Serve the repository root after building, then open `/wasm/md-preview.html`. Choose a local ROM and use the on-page keyboard guide; ROM contents stay in the browser.

## ABI

- `ares_fc_*`, `ares_sfc_*`, `ares_ms_*`, and `ares_md_*` expose the same lifecycle, frame, video, audio, input, allocation, and error operations for NES, SNES, Master System, and Mega Drive respectively.
- `*_run_frame` returns at the next video frame; its return type is intentionally `void` because it crosses Asyncify Fiber switches.
- Video is tightly packed 32-bit ares pixels; audio is interleaved stereo `float` samples for the last frame.
- `*_set_audio_frequency` resamples audio to the host output rate and may be called before or after loading a cartridge.
- `*_state_save`, `*_state_size`, `*_state_data`, and `*_state_load` save and restore machine state; see the save-state section above for the persistable/run-ahead distinction, the size split, and the versioning caveat.
- `ares_md_load_32x` loads a 32X image; it is `ares_md_load` with the mia medium and ares system names changed to `Mega 32X`, and everything after the load is shared.
- `ares_ms_set_model` selects the console model by ares node name, for example `[Sega] Mark III (NTSC-J)`; an empty string follows the cartridge's region header. Only the Mark III and NTSC-J models carry the YM2413.
- `*_switch_count` returns the process-wide cothread switch count. It exists for the fidelity harnesses and is present only in an `-DARES_WASM_DEBUG=ON` build.
- `*_set_input` sets a controller mask for player `0` or `1`; `*_error` returns the last load error as UTF-8.

NES input bits are Up, Down, Left, Right, B, A, Select, and Start from bit 0 through bit 7. SNES adds Y, X, L, and R before Select and Start, using bits 0 through 11. Master System input bits are Up, Down, Left, Right, 1, 2, Pause, Reset, and Rapid from bit 0 through bit 8. Mega Drive input bits are Up, Down, Left, Right, A, B, C, Start, X, Y, Z, and Mode from bit 0 through bit 11.
