# WebAssembly backends

The WebAssembly build is headless and exposes small C ABIs for loading NES, SNES, Master System, Mega Drive, Game Boy or Game Boy Advance ROMs, running one frame at a time, and reading video, audio, and error buffers.

For what the port changes *outside* this directory — the 16 native-affecting changes, why each hook
sits where it does, the alternatives that were measured and rejected, and the rationale still
missing from the record — see [DECISIONS.md](DECISIONS.md).

## Build

Cross-builds need the native `sourcery` resource compiler first:

```sh
cmake -S . -B build_native -DARES_CORES=sfc -DARES_ENABLE_CHD=OFF
cmake --build build_native --target sourcery

emcmake cmake -S . -B build_wasm -DCMAKE_BUILD_TYPE=Release -Dsourcery_DIR="$PWD/build_native"
cmake --build build_wasm --target ares-fc-wasm ares-sfc-wasm ares-ms-wasm ares-md-wasm ares-gb-wasm ares-gba-wasm
```

The outputs are `build_wasm/wasm/ares-fc.mjs`, `ares-sfc.mjs`, `ares-ms.mjs`, `ares-md.mjs`, `ares-gb.mjs` and `ares-gba.mjs` plus their `.wasm` and, where packaged resources are needed, `.data` companions. Pass a `locateFile` callback when those files are not served from the importing script's directory.

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
node wasm/gb-smoke.mjs build_wasm/wasm/ares-gb.mjs
node wasm/gba-smoke.mjs build_wasm/wasm/ares-gba.mjs
node wasm/state-smoke.mjs build_wasm/wasm          # all six cores; takes a directory, not a module
node wasm/state-smoke.mjs build_wasm/wasm sfc     # naming cores limits the run, for -DARES_CORES builds
node wasm/save-smoke.mjs build_wasm/wasm          # persistent cartridge memory; same argument shape
```

The smoke tests create minimal iNES, LoROM, Master System, and Mega Drive images in memory and require one video frame and one frame's worth of stereo audio from each core. The Game Boy cannot use a minimal image -- its boot ROM verifies the cartridge header and locks up on a bad one -- so `gb-smoke.mjs` builds the same cartridge the sweep uses, and additionally checks the input map, which has no controller port to disambiguate it. `gba-smoke.mjs` does the same for the same reason, and additionally supplies a BIOS: ares cannot start that machine without one, which the test also checks by requiring a load with no BIOS to be refused. They check liveness, not fidelity; the per-core sections below describe the fidelity harnesses.

`state-smoke.mjs` covers the save-state ABI for every core at once: it round-trips both state kinds
through the instance that produced them, hands a persistable state to a fresh instance that never saw
the replayed frames, and checks that garbage, an empty buffer, and a save with no cartridge loaded are
all refused without taking the machine down. Its discriminating checks are `restoreExact` — restoring
and immediately re-serializing must reproduce the blob byte for byte — and `advanced`, which fails a
machine that never moved and would otherwise match everything for free. Values under `reported` are
printed rather than asserted; see the save-state section for why.

`save-smoke.mjs` covers the persistent-memory ABI for every core at once: it boots a cartridge that
declares battery-backed memory, gathers it, writes a pattern over every byte from outside the machine,
restores that, and requires the core to hand the pattern back — from the same instance, after twenty
more frames, and from a fresh instance that never saw it written. It also requires a bad magic, an
unknown version, a truncated blob, an empty buffer, a blob naming a memory the cartridge does not
have, and a save with no cartridge loaded to be refused with a working machine left behind, and it
boots each cartridge a second time without its battery flag to check that a cartridge with no
persistent memory reports none. Writing the pattern from outside is the discriminating half: a restore
that reached the pak but never reached the board is overwritten by the flush that precedes the next
gather and comes back as the `0xff` mia filled the memory with. Removing the cartridge re-seat from
one core fails `restoreExact`, `survivesFrames`, `survivesRefusals` and `crossInstance`.

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

## Device synchronization (Game Boy)

The Game Boy is the most switch-bound machine here. Its PPU and APU both end their entry points in
`Thread::step(1); Thread::synchronize(cpu);` — a cothread switch on **every master clock**, where the
Master System's VDP switches once a scanline and the Mega Drive's YM2612 once a sample. Under
Asyncify each of those is a full unwind and rewind. Removing them is worth more here than anywhere
else on the branch: the cothread reference build runs the stress ROM at 19.5 fps and the web build
at 269, a factor of nearly fourteen.

The recipe is the NES's. `CPU::step` advances both chips by plain calls — `catchUpPPU()` drives
`PPU::runCycle()`, `catchUpAPU()` calls `APU::main()` directly, since one call there is already
exactly one APU clock and needs no flat twin — and then hands the rest to
`Thread::synchronizeExcept(ppu, apu)`. **The cartridge stays a real cothread**, reached by that
call: `Interface::main()` steps a whole emulated second per visit, so it costs almost nothing, and
MBC3, MBC7 and TAMA keep real-time-clock and EEPROM state on it.

Where gb departs from the NES is the flat stepper itself. `PPU::finishScanline()` on the NES is
`while(io.lx) runCycle();` — the position is a counter and nothing else is needed. gb cannot do
that for two reasons. `PPU::main()` picks between four arms from state a mid-unit register write can
change, so the arm has to be latched at the start of a unit rather than re-derived each clock. And
the display-off arm runs `456 * 154` clocks through an `n9` counter, wrapping it 137 times, so
`status.lx` cannot say where inside that arm the PPU stands. `runCycle()` therefore carries a
latched `unit.arm` and, for that one arm, `unit.counter`.

Both fields are serialized only under `if(!scheduler.getSynchronize())`, so they reach run-ahead
states and never persistable ones, and the persistable layout stays byte-for-byte what native
writes. What makes that sound is the retire hook: `CPU::main()` ends with
`if(scheduler.synchronizingPrimary()) ppu.finishUnit();`, which runs the PPU to the unit boundary
native's `main()` would have returned at — and never *starts* a unit, because starting one would
make the PPU's position depend on how many times the scheduler had visited it.

One placement has no counterpart in the other cores. Writing LCDC bit 7 re-derives the PPU cothread
(`ares/gb/ppu/io.cpp`), and that is *how* the native build throws away the unit in flight. The flat
stepper keeps that position in a member instead of a suspended stack, so it resets `unit` there
explicitly. It is the only runtime thread re-derivation in `ares/gb/`.

The catch-ups are in `CPU::step` rather than in `Bus::read`/`Bus::write`, which would look like the
tighter placement. `PPU::step` reads the bus itself to service OAM DMA, so a hook there would
re-enter `catchUpPPU()` from inside `runCycle()`.

### Verifying

`wasm/gb-sweep.mjs` runs a cartridge built by `wasm/gb-stress-rom.mjs` in five configurations —
`dmg`, `cgb`, `cgb-double` (KEY1 armed, then `STOP`), `lcd-off` (LCDC bit 7 dropped and restored
twice a frame) and `cgb-auto` (no model named, so the `$0143` header flag chooses) — against the
cothread reference build, and all five are identical on audio, video and stream length. The sweep
also asserts the web build is several times faster than the reference: were `-DARES_GB_COTHREAD` to
stop taking effect, every comparison would pass trivially by measuring one build against itself.

Two paths are **not** covered by the shipped cartridge and are worth knowing about: it never writes
`$FF46`, so OAM DMA — the `bus.read` reached from inside `PPU::step` inside `runCycle()` — is never
exercised, and it never enables the window, so the `lx == 80` latch ordering is not discriminated by
any golden here. Both were checked once, by hand, with an extended cartridge that drives them: web
and cothread stayed bit-identical across five further configurations. Making that permanent means
adding window and OAM-DMA options to `gb-stress-rom.mjs` and rerecording the goldens. With that, native and wasm produce byte-identical 17774-byte persistable states
on the sweep ROM, each build reporting the same 2-byte `stateDriftBytes`.

Two properties of that harness are load-bearing rather than decorative. The cartridge header is
real: the boot ROM checks the Nintendo logo at `$0104`-`$0133` and the `$014D` checksum and locks up
on either mismatch, and a locked-up machine renders a stable picture and a stable silence that every
hash comparison would pass. The sweep therefore also asserts that no configuration's picture is
constant across the run. And `settleFrames` is 240 rather than the 20-30 the other harnesses use,
because the boot ROM's logo animation outlasts them — measuring sooner measures the boot ROM.

`wasm/gb-smoke.mjs` covers liveness and the input map. Because the Game Boy has no controller ports,
`wasm/gb.cpp` resolves the eight buttons by name with no port to disambiguate them, so the harness
holds each one alone and checks all eight produce different pictures and none matches holding
nothing. Each probe restores the same saved state first: the ROM scrolls every frame, so without
that anchor eight windows would differ no matter what `ares_gb_set_input` did.

## Device synchronization (Game Boy Advance)

The advance was the first core here that was already faster than the machine it emulates: 75 fps
headless on the stress cartridge below, against a 59.7 Hz console. That is why the measurement came
before the port rather than after it. A profile said the core was compute-bound -- `PPU::main()` at
29% of self time, the Asyncify machinery under 5% -- and the profile was wrong about what that
meant. Removing 1,018 switches per frame by widening the cpu's periodic full sync bought 1.2 ms of a
13.3 ms frame, which puts a switch at about **1.2 microseconds**; at 5,901 switches per frame that
is more than half the frame. The cost is spread across every function on the suspended stack rather
than sitting in one, which is why it does not show up under its own name.

Where those 5,901 came from, counted per source and target thread: 2,006 cpu<->display, 1,980
cpu<->ppu, 1,880 cpu<->apu, 34 cpu<->player. The cpu drives all of them, so the recipe is the one
the other five cores use -- advance every chip by plain function calls on the cpu's cothread -- and
the result is **2 switches per frame** (the frame-boundary scheduler exits) at 107 fps against the
cothread build's 43.

What is new here is how the call sites were changed: **they were not.** The advance synchronizes its
chips from nine places -- `CPU::step`, the periodic full sync, VRAM/PRAM/OAM access in
`cpu/memory.cpp`, the timer's FIFO path, and the ppu and apu register handlers -- and rewriting each
of them would have been nine guarded edits in a core that is meant to stay mergeable. Instead
`Thread::synchronize` gained one web-only hook, `Thread::webAdvance`, which a flat-advanced chip
overrides to run itself up to the caller in place of the cothread switch. Every existing call site
then works unchanged, and the hook is only reached when the chip is actually behind -- that is, only
where a switch would have happened anyway. It is the same shape as the `active()` guard already
sitting three lines above it.

The flat steppers themselves are ordinary, and three details carry the fidelity.

**Where a chip is suspended is part of its state.** Each chip's entry point suspends *inside* a
`step()`, so the statements after that step belong to the next visit, not this one. `Display::main()`
ends with `io.hblank = 0; if(++io.vcounter == 228) io.vcounter = 0;` after its last `step(223)`, so
the flat twin carries an eighth phase that runs those two lines with no step of its own. Without it
the vcounter ran a whole scanline early, `PPU::beginUnit()` read it, and one visible line in every
few frames was skipped and another drawn twice. `APU::main()` splits the same way, around the
`step(8)` its sample emission follows -- and that one is not cosmetic either, because
`APU::readIO`/`writeIO` catch the apu up before touching a register, so emitting the pending sample
after that write rather than before it would use state the cothread build had not seen.

**The bus release is part of it too.** `PPU::step()` puts its `Thread::synchronize()` between
`Thread::step(1)` and `objReleaseBus()`, so a cpu that resumes there still sees the ppu's access
flags set and pays contention for them. Clearing them before returning quietly handed the cpu faster
memory than the hardware gives it. That is invisible in the default renderer, where
`Objects::step()` sets nothing, and audible in the pixel-accurate one, where it sets a flag on most
clocks of the scanline -- it was the last difference between the two builds' audio.

**The ppu drives the display, and only outside a retire.** `PPU::step()` synchronizes the display on
every ppu clock, and it has to: `Thread::synchronize()` walks the threads in append order, which puts
the ppu before the display, so without that link the ppu reads last scanline's counter. But native
reaches its line boundary during the scheduler's *auxiliary* walk, where every `Thread::synchronize`
breaks before switching -- so it gets there without carrying the display along. The retire hook runs
on the primary instead, where that guard is not in force, so `PPU::finishUnit()` suppresses the link
explicitly.

Native builds are untouched, and not by argument: all nine native translation units of this core --
plus `ares/ares/ares.cpp`, which carries the shared scheduler change -- **preprocess to byte-identical
text** with and without this port, so the compiler cannot see a difference to act on. Every hunk in
`ares/gba/` sits inside `#if defined(PLATFORM_WEB)`, and so does `Thread::webAdvance`.

The flat steppers' positions -- the ppu's clock-within-scanline, its latched scanline number and its
two bus-release flags, the display's phase, the apu's pending sample -- are serialized under
`if(!scheduler.getSynchronize())`, the same condition `Thread::serialize()` uses for the cothread
stack. They reach run-ahead states and never persistable ones, so the persistable layout stays
byte-for-byte native's and `SerializerVersion` is unbumped.

### Verifying

`wasm/gba-stress-rom.mjs` builds an ARM7 cartridge that drives everything at once: a scrolling mode-0
background, 128 sixteen-pixel objects filling every line, window 0 clipping the display, an hblank
interrupt rewriting the backdrop and the scroll from the line counter, a vblank interrupt sliding a
shadow object table into OAM by DMA and re-arming the sound DMA, all four PSG channels, and timer 0
clocking sound FIFO A. `wasm/gba-sweep.mjs` runs it in six configurations against the cothread
reference build, hashing every framebuffer and the whole concatenated audio stream.

```sh
node wasm/gba-sweep.mjs build_wasm/wasm/ares-gba.mjs                                       # golden hashes only
node wasm/gba-sweep.mjs build_wasm/wasm/ares-gba.mjs build_wasm_gba_cothread/wasm/ares-gba.mjs
```

All six -- `full`, `accurate`, `no-raster`, `no-dma`, `rtc` and `player` -- are **identical** to the
cothread build on audio, video, stream length and the bytes of a synchronized save state over 300
frames, at roughly 2.4x to 2.7x the throughput -- that last figure is wall-clock and moves with host
load, unlike everything else in this paragraph.

Three of those rows exist for reasons the others do not cover. `accurate` is not a variation:
`PPU::main()` has two entirely separate arms and pixel accuracy chooses between them, so without it
the per-cycle renderer is never executed at all. The sweep asserts the two arms render differently,
which the cartridge earns with a palette write in its main loop -- it lands wherever the loop happens
to be, which is to say mid-scanline, and only the per-cycle renderer can see it. `rtc` declares a
cartridge clock, which is the only thing that brings that thread up, and without it one of the core's
six `webAdvance` overrides is never executed. `player` runs `System::run()`'s second arm.

The state comparison is what makes the `rtc` row worth having: nothing that cartridge draws depends on
the clock, so picture and sound cannot see it either way. Picture and sound only reach the chips that
draw or sound; a synchronized state reaches all of them. A final `after-a-save-state` row then saves on
both builds and keeps comparing for 300 more frames, taking four further states along the way -- that
is the row that bounds the `stateDriftBytes` residual described under save states.

**The BIOS is a stub, and it has to be.** ares starts the ARM7 at `0x00000000`, inside the BIOS, so a
machine without one runs 16 KiB of zeroes -- which decode as a valid no-op -- forever, and
`mia/system/game-boy-advance.cpp` refuses an empty read outright. Nintendo's BIOS is not in this
repository, so `gba-stress-rom.mjs` writes its own: the eight exception vectors, the three stack
pointers the real one installs, the IRQ dispatch through `[0x03FFFFFC]`, and a jump to the cartridge.
It costs the fidelity comparison nothing, because both sides of that comparison run the same stub and
the BIOS is just program bytes to each. It is not a substitute for running a real game, and the
browser page asks you for the real thing.

The retire hook was checked by mutation rather than by assertion: removing it takes the residual
between two runs from one state from 18 bytes to 624, and `state-smoke` fails outright.

**One fixture bug is worth recording, because of what it was hiding.** An RTC cartridge answers reads
and writes at ROM offsets `0xc4`, `0xc6` and `0xc8` from its GPIO port rather than from the ROM, and
the stress cartridge's first two instructions after the 192-byte header sat exactly there, so the
`rtc` row did not run at all when it was first added. The reference build agreed with it precisely,
which is the useful part: the comparison was working and the fixture was not. Real RTC cartridges
leave that window alone; this one now starts past it.

## Cothread reference builds

The Master System, Mega Drive, Game Boy and Game Boy Advance cores have no batching granularity to
sweep, so their fidelity reference is a second wasm build of the same sources with the web fast paths
compiled out:

```sh
emcmake cmake -S . -B build_wasm_cothread -DCMAKE_BUILD_TYPE=Release \
  -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=ms -DCMAKE_CXX_FLAGS=-DARES_MS_COTHREAD
cmake --build build_wasm_cothread --target ares-ms-wasm

emcmake cmake -S . -B build_wasm_md_cothread -DCMAKE_BUILD_TYPE=Release \
  -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=md -DCMAKE_CXX_FLAGS=-DARES_MD_COTHREAD
cmake --build build_wasm_md_cothread --target ares-md-wasm

# -DARES_CORES=gb is required, not incidental: ares/sfc/sfc.hpp includes <gb/gb.hpp> at file
# scope when CORE_GB is defined, so a core list containing sfc would carry gb.hpp's #undef into
# every Super Famicom translation unit and compile out sfc's web paths as well.
emcmake cmake -S . -B build_wasm_gb_cothread -DCMAKE_BUILD_TYPE=Release \
  -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=gb -DCMAKE_CXX_FLAGS=-DARES_GB_COTHREAD
cmake --build build_wasm_gb_cothread --target ares-gb-wasm

emcmake cmake -S . -B build_wasm_gba_cothread -DCMAKE_BUILD_TYPE=Release \
  -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=gba -DCMAKE_CXX_FLAGS=-DARES_GBA_COTHREAD
cmake --build build_wasm_gba_cothread --target ares-gba-wasm
```

Add `-DARES_WASM_DEBUG=ON` to both sides if the switch counts are wanted; the comparison itself does
not need them.

`ARES_MS_COTHREAD`, `ARES_MD_COTHREAD` and `ARES_GBA_COTHREAD` undefine `PLATFORM_WEB` for one core
each. The `#undef` sits in `ares/ms/ms.hpp`, `ares/md/md.hpp` and `ares/gba/gba.hpp` after
`<ares/ares.hpp>`, so nall and the scheduler still see a web build and only the core's own fast paths
revert. Nothing outside `ares/gba/` includes `gba.hpp`, so unlike `gb.hpp` it carries no risk of the
`#undef` reaching another core.

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
fetch latch, the SNES DSP's `phase`, the Mega Drive's `CPU::sinceWaitClock`, VDP slot state and
YM2612 `pending` flag, and the Game Boy PPU's `unit.arm` and `unit.counter`. Each holds what the native build keeps in a cothread's program counter, so a
state taken mid-cycle resumes from stale data without it. All of them are gated on
`!scheduler.getSynchronize()` — the same condition `Thread::serialize()` uses for the cothread stack —
so they appear only in run-ahead states, where the stack is being carried anyway.

Gating keeps the *layout* byte-identical to native, which is what lets these cores keep the upstream
`SerializerVersion` unbumped. But layout compatibility is not the same as correctness. A gate is only
sound if the field it drops is genuinely dead at a synchronized safe point; where it is not, the state
loads and silently loses data.

All six cores are sound: each restructures its safe point so the dropped field is provably retired.
Four of them have states checked byte-for-byte against a native build. The Game Boy's evidence is a
step weaker and is worth stating as such: its persistable state is byte-identical between the web
build and the `ARES_GB_COTHREAD` reference -- same 17774 bytes, same 2-byte drift -- and that
reference compiles the core's web paths out, so it *is* the native layout. A direct `cmp` against a
desktop-ui state remains a manual check, because no headless native save path exists in this tree.

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
  comparison is the honest audio measurement, and it is asserted for every core but the Game Boy.
  gb settles 240 frames rather than 30 -- its boot ROM animation has to finish first -- and past
  roughly a hundred frames the two instances sit at different resampler phases, so for gb that
  comparison is reported too, behind the per-core `audioPhaseSensitive` flag. What places it outside
  the save state: the `ARES_GB_COTHREAD` build reports it identically, dropping gb's settle to 30
  makes it pass with the same 17774 bytes and the same drift, and `audioSampleDelta` stays 0. The
  trade is deliberate -- a settle of 30 would keep the assertion but would measure the boot ROM
  instead of the cartridge.
- **`stateDriftBytes`.** Two runs from the same blob, rendering the same frames, that do not arrive
  at the same blob. Nonzero means live machine state sits outside the save state — the same defect
  class as the losses above, and a useful thermometer for it. It read 9 on the SNES before the DSP
  phase was retired at the safe point, and reads 0 now. It read 37 on the Mega Drive and reads 2:
  those two bytes are the cartridge thread's clock, and a native build measures exactly the same two
  bytes with the same values, so they are not a porting artifact.

  **The Game Boy Advance reads 27 where its own cothread build reads 0.** What that number is: taking
  a synchronized state runs the machine to a safe point, and the two schedulers reach that point along
  different routes. The web build's frame boundary is reached inside the *cpu's* cothread, because
  `PPU::frame()` runs there; the cothread build's is reached inside the *ppu's*. Before the save the
  two machines are byte-identical; after it they are not, by 18 to 30 bytes depending on where the
  save fell.

  What it costs is nothing, and that is measured rather than assumed. `gba-sweep`'s
  `after-a-save-state` row saves a state on both builds and then runs 300 frames, taking four more
  states along the way to keep perturbing both machines, and compares every frame of video and every
  audio sample: identical throughout, and asserted, so a regression fails the sweep. The rest holds
  too — `restoreExact` is exact, a state restored into either build produces the same machine to the
  byte, and that stays true 120 frames later. The residual is bookkeeping no later frame reads.

## Persistent cartridge memory

The cartridge's own memory — battery-backed save RAM, EEPROM, flash, and real-time clocks. This is
not the save state above: it is what the console itself would have kept when the power went off, it
survives an ares version bump where a save state does not, and it says nothing about where the game
had got to.

**These files do not interchange with desktop ares, and save states do.** That asymmetry is
deliberate, so do not read the save-state guarantee onto this one. Desktop writes one raw file per
memory — `<game>.ram`, `<game>.eeprom`, `<game>.flash`, `<game>.rtc`, each just the bytes with no
header (`mia/pak/pak.cpp:114-165`). This ABI hands back a single byte range, and a board can carry
more than one memory at once — a Mega Drive with SRAM and an EEPROM, a Super Famicom with save RAM
and a clock — so it packs them into one named container instead. The bytes inside each entry are
exactly what desktop would have written; only the packaging differs, and converting either way is
a matter of splitting or joining. Making the single-memory case emit a bare `<game>.ram` was
considered and declined: one format that always says what it holds beats two that mostly do.

```c
void      ares_<core>_save_ram_save(void);
u32       ares_<core>_save_ram_size(void);
const u8* ares_<core>_save_ram_data(void);
int       ares_<core>_save_ram_load(const u8* data, u32 size);
```

`ares_<core>_save_ram_save` asks the system to flush its memory and packs the result into a buffer
that `*_save_ram_size` and `*_save_ram_data` delimit, held exactly like the video, audio and state
buffers and valid until the next save or unload. A cartridge with no persistent memory gathers a size
of `0`, which is the answer rather than a failure. Nothing here enters the scheduler, so unlike
`*_state_save` these could have returned the size directly; the split is kept so the two triads read
the same way.

`ares_<core>_save_ram_load` restores a blob and returns nonzero on success, leaving the reason in
`*_error` otherwise and, like a failed state load, leaving a working machine behind.

**Restoring power cycles the machine.** ares keeps a cartridge's memory in two places: the pak holds
the file a front end loaded, and the board holds the copy the machine reads and writes. The board
fills its copy from the pak once, when the cartridge is seated, and writes it back only when the
system is asked to save. Writing the pak alone would leave the running machine on the bytes it
already had, so a restore re-seats the cartridge and powers the system, which is what a boot with the
battery already in it does anyway. Call it after `*_load` and before running a frame.

### The blob

More than one persistent memory can sit on one cartridge — a Mega Drive board with both SRAM and an
EEPROM, a Super Famicom board with save RAM and a real-time clock — so the ABI hands over one blob
holding all of them rather than an anonymous byte range the caller would have to split without being
told how.

```
magic    4 bytes  "ARSV"
version  u32      1
count    u32      number of entries
entry    u32 name size, name bytes, u32 data size, data bytes   (repeated count times)
```

Integers are little endian. Names are the pak's own file names — `save.ram`, `save.eeprom`,
`time.rtc` — so a blob says what it holds. An entry naming a memory the cartridge does not have is
skipped rather than applied to whatever sits at the same index, and an entry naming a memory outside
the cartridge's persistent set is skipped rather than allowed to overwrite the ROM; a blob in which
nothing matches is refused. A shorter entry than the memory it names leaves the tail at whatever mia
filled it with, which is what a cartridge whose save file predates a larger battery would have seen.

Unlike a save state, a blob is not tagged with the core that produced it and does not need to be: the
names are matched against the cartridge in the machine, so a Mega Drive save handed to the NES core
matches nothing and is refused. Two cartridges on the same console with the same memory layout will
happily accept each other's saves, exactly as swapping the batteries would.

### What each core persists

Each core carries the list mia's own `Medium::save()` persists for that console, and only that list.
The lists differ, and a memory mia does not save is not persistent even when its type suggests it is
— the NES writes character RAM every frame and mia has never saved a byte of it.

| Core | Manifest memories |
|---|---|
| `fc` | `RAM/Save`, `EEPROM/Save`, `Flash/Program` |
| `sfc` | `RAM/Save`, `RAM/Internal`, `RAM/Download`, `RTC/Time`, `RAM/Data` |
| `ms` | `RAM/Save` |
| `md` | `RAM/Save`, `EEPROM/Save` — a 32X image persists the same two |
| `gb` | `RAM/Save`, `EEPROM/Save`, `Flash/Download`, `RTC/Time` — Game Boy Color inherits it unchanged |
| `gba` | `RAM/Save`, `EEPROM/Save`, `Flash/Save`, `RTC/Time` — flash is `content=Save` here, where the Game Boy's is `content=Download`, so the two consoles name that entry differently |

Two consequences of matching mia rather than second-guessing it. A manifest can mark a memory
`volatile`, and neither mia nor ares acts on that flag, so a cartridge whose work RAM has no battery
behind it still gathers a size — the desktop build writes the same file. And mia gives *every* Master
System cartridge 32 KiB of save RAM, because the header carries no size and only the database knows
the real one, so `ms` never reports a cartridge without persistent memory.

### Flushing

There is no dirty signal, and adding one would mean tracking writes inside the cores. A host that
wants the parity behaviour — flush while dirty, and on every exit path — gathers on a timer and
compares against what it last stored; gathering is a memory copy, and the largest of these blobs is a
few tens of kilobytes.

A save state carries the cartridge's memory too, because the board serializes it along with the rest
of itself. Loading a state therefore overwrites the battery, which is the same thing loading a state
on hardware-accurate terms would do, and a host that flushes after a state load stores the state's
copy rather than the one it had.

## Overscan

A console that drove a television rendered more than the television showed. The bezel hid a border,
and games left it full of the backdrop colour, partial tiles and scroll seams. ares renders the whole
frame and lets a front end decide how much of it to hand over.

`ares_fc_set_overscan`, `ares_sfc_set_overscan`, `ares_ms_set_overscan` and `ares_md_set_overscan`
take that decision. Non-zero hands over the full frame; zero crops to the picture a set showed. **All
four default to cropped**, which is not ares' own default — `ares::Node::Video::Screen` starts
`_overscan` at `true`, and each shim overrides it at load. A browser canvas has no bezel, so the
border is just a margin of noise around the game.

The Game Boy and the Game Boy Advance have no such call, and adding one would be meaningless: each is
an LCD panel wired to the picture its ppu draws. `ares/gb/ppu/ppu.cpp:26-27` sets the viewport to the
full 160×144 and `ares/gba/ppu/ppu.cpp:35-38` to the full 240×160. There is no border to crop.

The cores re-read the setting at the end of every frame, so a change takes effect on the next one and
`*_video_width` and `*_video_height` change with it. A caller that caches the dimensions must re-read
them after toggling. For the NES that is 256×240 cropped against 283×242 full, on NTSC.

`ares_fc_set_overscan` landed after the other three. Until it did, the NES was the one browser build
still handing out the uncropped frame while the rest handed out the picture; the NES sweep records no
golden hashes — it compares two runs of the same build against each other — so unlike the Master
System, Mega Drive and SNES sweeps, nothing had to be rerecorded when it landed.

## Browser previews

Each core has a preview page: `/wasm/fc-preview.html`, `sfc-`, `ms-`, `md-`, `gb-` and `gba-`. Serve
the repository root after building and open one. Choose a local ROM and use the on-page keyboard
guide; ROM contents stay in the browser.

**The Game Boy Advance page asks for a BIOS as well as a ROM, and will not start without one.** It is
Nintendo's code and is not shipped here; desktop ares asks for the same 16 KiB file. Once chosen it
stays loaded for every ROM after it. That page also carries a *Pixel accuracy* checkbox — upstream's
own setting, off by default as it is on the desktop — which chooses between the per-cycle renderer
and the whole-scanline one, and takes effect on the next load.

All six carry the same three controls beyond load and run.

**Save state.** `Save state` keeps a state in the page, `Restore state` puts it back, and
`Download state` writes it to a file. The file is named `<rom>.bs1` on purpose. The page takes a
synchronized state, and `desktop-ui/program/states.cpp:11-12` writes exactly what
`root->serialize()` returns to `<game>.bs<slot>` with no wrapper of its own —
`ares/ares/node/system.hpp:10` defaults that call to `synchronize = true`. So the downloaded file is
a desktop slot file: put it beside the game in ares' saves directory and slot 1 loads it. `Load
state` accepts one back, which is the same path in reverse. (The end-to-end check against a running
desktop ares is still a manual gate; what is verified here is that both sides serialize the same way.)

**Battery.** `Download battery` writes the cartridge's persistent memory to `<rom>.sav`. The
extension is the familiar one, but the contents are the `ARSV` container described above, not a raw
memory dump — a board can carry several memories at once, and an anonymous byte range could not say
which was which. **It is not interchangeable with another emulator's `.sav`, or with desktop ares**,
which splits the same bytes across `<game>.ram`, `<game>.eeprom` and friends; the file names itself
`ARSV` in its first four bytes, and `Restore battery` refuses anything that does not. `Restore
battery` reads one back; because the board holds its own copy, restoring re-seats the cartridge and
power cycles, so the machine returns to the boot screen with the battery already in it. A cartridge
with no battery downloads nothing and says so; that is an answer, not a failure.

**Overscan.** A checkbox on the four cores that have a border, unchecked by default. See above. The
Game Boy and Game Boy Advance pages do not have one.

The status line reports two numbers that answer different questions. `fps` is the paced rate, so on
any machine that keeps up it sits at the console's own refresh rate and says nothing about headroom.
`core N ms` is the emulator's cost per frame with pacing and canvas drawing taken out; `1000 / N` is
the frame rate the build could sustain unthrottled. The `*-smoke.mjs` harnesses measure the same
figure without a browser in the way.

Three pages have a Model selector. The Master System's `Auto` follows the cartridge's region header,
and the Mark III and NTSC-J entries add the YM2413 FM sound unit. The Game Boy's `Auto` reads the
cartridge's own `$0143` colour flag, which is what the hardware does, so a Game Boy Color cartridge
boots as a Game Boy Color without being told to; Super Game Boy is not offered, for the reason given
under `ares_gb_set_model` below. The Game Boy Advance offers Game Boy Player, which is the same
silicon in the GameCube adapter — a game that never performs the Player serial handshake behaves
identically either way, and the sweep asserts exactly that.

## ABI

- `ares_fc_*`, `ares_sfc_*`, `ares_ms_*`, `ares_md_*`, `ares_gb_*` and `ares_gba_*` expose the same lifecycle, frame, video, audio, input, allocation, and error operations for NES, SNES, Master System, Mega Drive, Game Boy, and Game Boy Advance respectively.
- `*_run_frame` returns at the next video frame; its return type is intentionally `void` because it crosses Asyncify Fiber switches.
- Video is tightly packed 32-bit ares pixels; audio is interleaved stereo `float` samples for the last frame.
- `*_set_audio_frequency` resamples audio to the host output rate and may be called before or after loading a cartridge.
- `*_state_save`, `*_state_size`, `*_state_data`, and `*_state_load` save and restore machine state; see the save-state section above for the persistable/run-ahead distinction, the size split, and the versioning caveat.
- `*_save_ram_save`, `*_save_ram_size`, `*_save_ram_data`, and `*_save_ram_load` save and restore the cartridge's own persistent memory, which is a different thing from machine state; see the persistent-memory section above for the blob format, the per-core memory lists, and why restoring power cycles the machine.
- `ares_fc_set_overscan`, `ares_sfc_set_overscan`, `ares_ms_set_overscan` and `ares_md_set_overscan` choose how much of the rendered frame is handed over; all four default to the cropped picture, and neither the Game Boy nor the Game Boy Advance has an equivalent because neither has a border. See the overscan section above for the defaults, the reported dimensions, and when a change takes effect.
- `ares_md_load_32x` loads a 32X image; it is `ares_md_load` with the mia medium and ares system names changed to `Mega 32X`, and everything after the load is shared.
- `ares_ms_set_model` selects the console model by ares node name, for example `[Sega] Mark III (NTSC-J)`; an empty string follows the cartridge's region header. Only the Mark III and NTSC-J models carry the YM2413.
- `ares_gba_set_bios` hands the core a Game Boy Advance BIOS image, which it keeps until it is replaced. It is **required**: `ares_gba_load` refuses a cartridge without one, because ares starts the ARM7 inside the BIOS and a machine with none never reaches the cartridge at all. The image is not shipped with this build and cannot be — desktop ares asks for the same file.
- `ares_gba_set_model` selects `[Nintendo] Game Boy Advance` or `[Nintendo] Game Boy Player`; an empty string is the plain advance. mia has one medium and one system pak for both, so only the ares device name changes.
- `ares_gba_set_pixel_accuracy` chooses between `PPU::main()`'s two arms — the per-cycle renderer that reproduces a mid-scanline register write, and the whole-scanline renderer that does not. It is upstream's own "Pixel Accuracy" option and defaults off, as it does on the desktop; it takes effect on the next `ares_gba_load`.
- `ares_gb_set_model` selects `[Nintendo] Game Boy` or `[Nintendo] Game Boy Color`; an empty string reads the cartridge's own `$0143` colour flag and picks for itself. The same name selects the mia system pak, so it is what decides which boot ROM runs. `[Nintendo] Super Game Boy` is not a valid argument here: it is the SNES core's coprocessor rather than a machine this module can bring up, and it is out of scope for the browser build.
- `*_switch_count` returns the process-wide cothread switch count. It exists for the fidelity harnesses and is present only in an `-DARES_WASM_DEBUG=ON` build.
- `*_set_input` sets a controller mask for player `0` or `1`; `*_error` returns the last load error as UTF-8.

NES input bits are Up, Down, Left, Right, B, A, Select, and Start from bit 0 through bit 7. SNES adds Y, X, L, and R before Select and Start, using bits 0 through 11. Master System input bits are Up, Down, Left, Right, 1, 2, Pause, Reset, and Rapid from bit 0 through bit 8. Mega Drive input bits are Up, Down, Left, Right, A, B, C, Start, X, Y, Z, and Mode from bit 0 through bit 11. Game Boy input bits are Up, Down, Left, Right, B, A, Select, and Start from bit 0 through bit 7; the Game Boy has no controller ports, so only player `0` exists and `ares_gb_set_input` ignores any other player. Game Boy Advance input bits are Up, Down, Left, Right, B, A, L, R, Select, and Start from bit 0 through bit 9, with the same one-controller rule.
