# Decision log — what the WebAssembly port changes outside `wasm/`

The web target itself lives in `wasm/` and is nobody else's problem. This file is about the other
111 files: what the port had to change in shared code and in the cores, why each change is where it
is, and what was deliberately not done.

It exists because "the tests pass" is not a reason to accept a change into code you maintain. Every
entry below tries to answer one question: **why is this line here, rather than somewhere else?**
Where no answer was on record, the hunk was reverted and the build was run to find out rather than
to recall — §8 gives each experiment and its outcome, including the three changes that turned out
not to be needed at all.

Base for every count and claim here: `b80f67d38` → the branch tip, 111 files outside `wasm/`,
+2321/−118. Recompute it with
`git diff --shortstat b80f67d38 -- . ':(exclude)wasm'`.

| | count | what it means |
|---|---|---|
| Behind a web guard | 26 | the native preprocessor, or a `NOT OS_EMSCRIPTEN` branch, never lets it through. Counts entries in §4, not hunks; gb's whole port is the 21st, gba's the 22nd, `Thread::webAdvance` the 23rd, the `EntryPoints()` retirement the 24th (three hunks, one entry), ps1's whole port the 25th (two hunks) and `nall::vfs::cdrom`'s synchronous load the 26th |
| Shared, compiled, never used natively | 3 | native emits nothing, but you own the source |
| Affects the native build | 13 | 1 build system, 3 portability casts, 9 source refactors |
| **Changes emulated behaviour, on purpose** | **6** | ares defect fixes, not port changes: `UPSTREAM.md` entries 15, 17, 18, 22, 23 and 24. §2d |

**gba added no native-affecting change at all, and that is measured rather than asserted:** all nine
native translation units of `ares/gba/`, plus `ares/ares/ares.cpp` which carries the shared scheduler
hook, **preprocess to byte-identical text** with and without this port. §8.8 gives the command.

**Every one of the 9 native source refactors is semantics-preserving.** None changes emulated
behaviour. §2c gives the evidence for each, and §9 says how to re-check it yourself.

**The last row is the one exception to all of the above, and it is deliberate.** Three PlayStation
defects were fixed in place rather than guarded, because they are ares' bugs and a guard would be
wrong: a `#if defined(PLATFORM_WEB)` around a bug fix would say the bug is correct natively. They are
written to be lifted out as upstream patches, not to be merged with the port. §2d states them, and
`UPSTREAM.md` 15, 17 and 18 carry the evidence. **Anyone auditing this branch's "native is untouched"
claim should read §2d first** — the claim holds for the port, and these three are not the port.

---

## 1. The design fact behind most of the placements

Nearly every awkward-looking hook in this branch traces to one property of the scheduler:

```cpp
// ares/ares/scheduler/thread.cpp
auto Thread::Enter() -> void {
  while(true) { scheduler.synchronize(); entryPoint(); }
}
```

The safe point is offered **before** the entry point runs.

Natively that is invisible: every chip has a cothread, so when the scheduler walks it to a safe
point it resumes a suspended `step()` part-way through `main()` and runs it to the end. The chip
stops where `main()` returns, which is a meaningful boundary — a scanline end, a sample end.

The web build advances most chips by plain function calls from a driving cothread instead, because
each `co_switch` under Asyncify is a full unwind and rewind (~234–300 ns against 5.94 ns native).
A chip advanced that way **never enters its own cothread while running**. So when the scheduler
walks it, `Thread::Enter` answers the synchronization before executing anything, and the chip
reports ready wherever the last plain call happened to leave it — mid-scanline, mid-sample. A save
state taken there is missing the position, and `System::unserialize`'s `power(false)` then clears
it.

Hence the shape repeated in seven cores: the **driving** cothread finishes the unit of work on the
driven chip's behalf, immediately before the safe point.

```cpp
// ares/md/cpu/cpu.cpp, end of CPU::main()
if(scheduler.synchronizingPrimary()) { vdp.finishScanline(); opn2.finishSample(); }
```

**Why there and not somewhere better.** The honest answer is that the model fix is in
`Thread::Enter` — offer the safe point *after* the entry point, once, for everyone. That was not
done because it changes native behaviour, and this branch's governing constraint is that native is
bit-identical to what it always was. That constraint is self-imposed. A maintainer is free to
change native, and may well prefer one scheduler fix to a `finish*()` hook per chip. If so, these
hooks should be read as a workaround this branch chose, not as a design it is defending.

Two alternatives were tried and measured, and both fail:

- Driving the finish loop from the flat-advanced chip's own cothread. That thread never runs.
- Running a whole unit of work per scheduler visit. The chip's position then depends on how many
  times its cothread has been entered, so two machines in the same state but with different
  histories serialize differently.

---

## 2. Changes that affect the native build

### 2a. Build system (1)

A native configure produces exactly the upstream target set, and every root-level gate the port adds
is an `OS_EMSCRIPTEN` branch that native takes exactly as before. One hunk is left that native can
reach:

| id | change | native effect |
|---|---|---|
| B8 | `sourcery_DIR` defaulted only when unset; imported target promoted `IMPORTED_GLOBAL` | inside the cross-compiling branch, so ordinary native builds skip it — but **every native cross-build takes it.** Without it a cross-compile fails at build time with `sourcery: command not found` — §8.4 |

This started as four. The commit that introduced them explained libco, nall detection, the SLJIT
stub and the 32-bit fixes, and said nothing about the build restructure, so each was reverted and
re-run to find out what it was for. Three turned out not to be needed and are gone: a new
`ARES_BUILD_DESKTOP` option, a `nall-headers` `PUBLIC`→`INTERFACE` change, and a rewrite of the
shared `add_sourcery_command` rule. §8 records what was run, what happened, and what was removed as
a result. B8 is what remains, and it fixes a cross-compilation path that was already broken.

### 2b. Portability (3)

All three come from Emscripten's 32-bit `size_t` making braced initializers ill-formed.

- **S3 — `ares/ares/memory/{readable,writable}.hpp`.** `(size_t)` cast hoisted into a local, four
  call sites. Included by every core. A no-op wherever `size_t` is 64-bit.
- **S2 — `mia/pak/pak.cpp`.** Same, one site. No-op on 64-bit.
- **S1 — `mia/medium/famicom.cpp`.** *Not* a no-op. This one hoists `u32 size = node["size"].natural();`
  rather than casting to `size_t`, so on a 64-bit native build the expression's type changes from
  `u64` to `u32`. A chunk ≥ 4 GiB would truncate. No Famicom board can produce one, so this is
  unreachable rather than harmless — and the commit's blanket claim that the 32-bit fixes are
  "no-ops where size_t is already 64-bit" does not cover it. Casting to `size_t` here, as S2 and S3
  do, would have been type-neutral and is the better form.

### 2c. Core source refactors (9)

Each exists because the web build needs to reuse a body that upstream had inlined into a loop or an
early-return chain. Duplicating those bodies behind a guard was the alternative; it was taken in
`fc`/`sfc`/`md` for the *large* loops (`PPU::renderScanline`, `DSP::main`, `VDP::mainH32/H40` all
keep their native form verbatim behind `#else`) and rejected for these smaller ones, where two
copies of the same few lines would drift.

| id | change | evidence it is semantics-preserving |
|---|---|---|
| X2 | sfc `SMP::main()` early returns → if/else | byte-identical `-O2` assembly; `return f();` on `void` ≡ `f(); return;` |
| D4 | md `CPU::main()` early returns → if/else + `interrupted` | byte-identical `-O2` assembly; `lower()`'s side effect is reached identically in both forms |
| D2 | md `VDP::tick()` → `tick()` + `tickTail()` | byte-identical `-O2` assembly; pure code move. `_refresh` stays a template parameter so native instantiations still constant-fold |
| D5 | md `OPN2::main()` body → `sample()` | byte-identical `-O2` assembly; pure extraction |
| D3 | md `Thread::active()` → `busActive()` at 15 sites | natively `busActive()` is exactly `Thread::active()`; only the web override differs |
| F2 | fc `PPU::step()` loop body → `PPU::cycle()` | `vlines()` is a pure region test, so hoisting it into the loop yields the same value every iteration |
| M2 | **ms VDP → `beginLine()`/`tick()`/`endLine()` + `lineVisible`** | upstream evaluated all three `vlines()` calls before its first `step()`, so all three saw one value; `beginLine()` computes it once, in the same order of side effects |
| M3 | ms `PSG`/`OPLL` `main()` → `runCycle()` | upstream ended in `step(1)`; the split moves `Thread::step(1)` into `runCycle()` and `Thread::synchronize(cpu)` into `main()`, same order |
| N5 | `#pragma once` added to `nall/decode/mmi.hpp` | changes behaviour only for a TU that includes it twice; none does |

**M2 is the largest unguarded native change on the branch** and the one to review first. It is also
the only core refactor without a byte-identical-assembly claim behind it — `ms` was verified as
behaviourally identical and bit-identical against an `ARES_MS_COTHREAD` reference build, not at the
codegen level. If one thing here deserves an independent read, it is this.

### 2d. Deliberate ares defect fixes (6)

These are the **only** changes on the branch that alter what the emulator computes, and they are not
port changes at all. All six are ares defects with independent evidence in `UPSTREAM.md`, all six
were found while porting, and all six are written to be lifted straight out as upstream patches.
They are unguarded on purpose: wrapping a bug fix in `#if defined(PLATFORM_WEB)` would assert that the
bug is correct behaviour natively, which is the opposite of true.

| | change | what it fixes | native effect |
|---|---|---|---|
| **D1** | `ares/ps1/disc/cdxa.cpp` — `decodeADPCM` repeats the *frame*, not the *sample* | `UPSTREAM.md` 15. Half-rate **stereo** CD-XA played as static: `L,L,R,R` reaching a consumer that pops pairs | intended. Half-rate stereo XA audio now plays as stereo music. Mono and full-rate are untouched — `Step` is 1 and `Repeats` is 1 respectively |
| **D2** | `ares/ps1/peripheral/io.cpp` + `peripheral.hpp` — `SIO1_BAUD` at `1f80105e` becomes a stored, readable register | `UPSTREAM.md` 17. `Agile Warrior F-111X` writes it, reads it back, divides by the 0 it got, traps, and spends the rest of the run in the BIOS error handler | intended. One disc in a 126-disc sweep touches this register at all; for every other title the arm is unreachable and the accesses were already falling through to a `debug` line |
| **D3** | `ares/ps1/disc/drive.cpp` + `io.cpp` + `disc.hpp` — a sector clocked behind a deferred INT1 is staged in `fifo.deferred.sector` and promoted when the host drains `fifo.data`, instead of flushing the FIFO the outstanding INT1 still refers to | `UPSTREAM.md` 18. `Crash Bandicoot (USA)` loses one streamed sector, its LZ77 decompressor desyncs, steps its remaining-output count past its exact-zero exit test, writes 447 KB past the end of its buffer, destroys the exception vector at `0x80` and loops there forever | intended. Only a title that falls a sector behind its own INT1 reaches the new path at all; three of the four control discs never stage a sector, and the fourth stages eleven and is fixed by it |
| **D4** | `ares/ps1/dma/channel.cpp` — a SyncMode 2 walk that stops on its word bound with the channel still enabled hands the bus back for `0x1000` clocks while `state` is `Idle` | `UPSTREAM.md` 21 and 22. A GPU ordering table whose node points at itself keeps `dma.active()` true forever, so `CPU::waitDMA()` never returns and the whole machine stops — `Syphon Filter (v1.0)` freezes at frame 3,241, and `Tekken 2`, `Deadheat Road`, `Hot Wheels Turbo Racing` and `World Cup Golf` are documented elsewhere as needing the same yield | intended. Only a list longer than 4,096 words reaches the new path; two of the four control discs never do and are byte-identical, the two that do keep identical distinct-frame counts and lit fractions |

| **D5** | `ares/ps1/mdec/decoder.cpp` — a block costs 448 clocks, not 1,000, so a colour macroblock costs 2,688 | `UPSTREAM.md` 23, which closes Open A. At 1,000 a 320x240 frame took 53 ms, three NTSC frames; `Syphon Filter (v1.0)`'s FMV player then entered a **hard-coded 1,000,000-iteration delay** on every video frame, ran the stream at 5 fps against the authored 15, declined 47 of 148 CD sectors while it sat there, fed the MDEC a short bitstream, and never reached its title screen | intended, and visible: every FMV frame now decodes 300 macroblocks instead of 68, the four control discs are unchanged on dumped images, and every MDEC-heavy title checked plays its video |

| **D6** | `ares/ps1/disc/cdxa.cpp` — `clockSector()` refuses a sector while the sample queue is still ahead, instead of queueing it behind eight sectors of backlog | `UPSTREAM.md` 24. The CD-XA queue holds 4032*8 samples = **0.853 s**, nothing bounds or flushes it, and the write side drops the *newest* samples when full. `Syphon Filter (v1.0)` streams its speech as 16 interleaved channels of mono 18900 Hz XA read at double speed — twice the rate that format's 1/32 interleave calls for — so the queue pinned full: **749,952 decoded samples dropped mid-sector, and everything that survived was heard 0.75 s late**, with a stream the game had already left still playing | intended. Only a stream that delivers its selected channel faster than 37800 Hz drains it reaches the new line; on all nine control discs it drops **nothing** (`xaDropped` 0 both arms, `xaMaxDepth` unchanged) and audio hash and save state are bit-identical |

**D6's measurement, and why it is not an aggregate.** Both arms were built from one tree minutes
apart and driven by one headless native harness (`ARES_CORES=ps1`, RelWithDebInfo). The fix gate is a
named event: at frame 1,504 of the Washington Park demo, seeded from a state this branch wrote at
frame 11,400, voice 19 keys on SPU-RAM sample `0x5a2e0` at per-voice volume 17,236/17,802 — an order
of magnitude above the ambience around it, and the only key-on of that sample in the whole run. Six
frames later the HUD prints **"SHOTGUN TAKEN"** and the ammunition readout changes from 08/30 to 10.
That key-on lands at the identical SPU sample (1,109,059) in both arms, which is what says the change
moves *when the audio is heard* and not what the game does. The nine controls' distinct-frame counts
move by up to 28 between arms — and by the same amount between two runs of the **same** arm, because
`GPU::Threaded` makes the rendered framebuffer vary while the machine does not. The audio hash and the
4,019,632-byte save-state hash are bit-identical on all nine, which is the check that carries weight.

**D5's measurement is separate again, and is stated after D6's.**

**D5 replaces a constant upstream marked `FIXME`, with the only hardware-derived figure that
exists.** psx-spx's *DMA Transfer Rates* says outright that "MDEC decompression time is still
unknown (may vary on RLE and color/mono)", so there is no nocash number; DuckStation charges
`TICKS_PER_BLOCK * 6` = 2,688 clocks per macroblock (`src/core/mdec.cpp:32`, `:584`, `:647`) and 448
per block reproduces that exactly for the six-block colour macroblock that every FMV uses. A
monochrome macroblock is one block and so stays cheaper than DuckStation's flat charge; only 4bpp
and 8bpp output reaches it, which DuckStation's own source calls "basically never used".

**Both arms built from the same tree minutes apart, and scored on dumped images rather than
aggregates.** `Crash Bandicoot`, `Raiden Project`, `Asteroids (USA)` and `WipEout (USA)` were each
run 3,600 frames with a frame dumped every 150 and every image looked at: identical progressions in
both arms — Crash reaches its title screen at 3,150 in both, Raiden its menu at 2,100 in both,
WipEout its Designers Republic FMV and attract in both. Asteroids' intro FMV runs at a different
*phase* between the arms, because it is MDEC video and that is the whole point of the change; the
content is correct in both. Save state stayed **4,019,632 bytes** and round-tripped on all four, and
on all four of the MDEC-heavy controls added for this change — `Wing Commander III (Disc 1)`,
`Metal Gear Solid (Disc 1)`, `Xenogears (Disc 1)` and `Novastorm (Disc 1)`, each run 4,200 frames.
Novastorm is the strongest of those: it is a full-motion-video game, and its Psygnosis logo, its
title sequence and its live-action cutscene all decode cleanly.

**The `-DARES_PS1_COTHREAD` reference cross-check, which `UPSTREAM.md` recorded as never run on this
cluster, was run here.** `wasm/ps1-sweep.mjs` on `Syphon Filter (v1.0)`, seeded at frame 8,800 and
measured over 600, reports the web build and the cothread reference **identical** — same per-frame
video sequence hash `4cd70c37`, same audio hash `b650c202` at 802.4 samples/frame, same 4,019,632-byte
state hash `4f4424f1`, same 262,208-byte memory cards, 151/600 distinct frames in both. The web build
runs it at 9.41 ms/frame. A frame dumped straight out of the wasm module shows the same 989 Studios
logo, the same cinematic and the same title screen as native. **There is no browser-side defect
here**; the earlier report of the browser "not responding" was the pre-fix machine, which never had a
title screen to respond from.

**What D5 is not.** It is not an MDEC timing model. It is one constant, replacing a constant whose
own comment says it is wrong, with the figure a reference emulator uses. It does not touch the DMA0
or DMA1 rates, the input-FIFO starvation wait, or the copy-out shape, and it adds no state — the save
state is byte-identical in size and layout, so unlike D2 and D3 it carries **no compromise** and the
hunk here is the hunk that should go upstream.

**D4's measurement is separate from D1-D3's** and is stated after them, because it was taken later
and on a different set of discs.

**Measured, module before vs module after, same discs back to back.**

| | before | after |
|---|---|---|
| `Agile Warrior F-111X`, 3000 frames | 640x480 throughout, lit 0.1263 | reaches 512x240, lit 0.5891, 267 distinct frames |
| `Asteroids (USA)` video, 4500 frames | 864 distinct, lit 0.5526 | **864 distinct, lit 0.5526** — unchanged |
| `Asteroids (USA)` audio | hash `436a32d6` | hash `63cb22c1` — D1 landed |
| `Raiden Project` control, 3000 frames | 739 distinct, lit 0.5336, audio `cc855b8c` | **identical on every column** |
| save state size | 4,019,632 | **4,019,632** |

Asteroids changing in audio and not in video is the shape that says D1 is confined to the audio path.
Raiden being identical on every column is the shape that says neither fix reaches a title that does
not need it.

**D2 carries one deliberate compromise, and it is this branch's, not upstream's.** The new
`sio1BaudrateReloadValue` is **not** added to `ares/ps1/peripheral/serialization.cpp`. Serializing it
would change the save-state layout, which §2's rule forbids — states stay byte-interchangeable with a
stock desktop build in both directions, and the measured 4,019,632 above is that rule holding. The
cost is a window two instructions wide: the game writes the register and reads it back on consecutive
instructions, so a state captured exactly between them would restore a zero. **The upstream patch
should serialize it**; `UPSTREAM.md` 17 says so explicitly, so the compromise does not travel.

**D3 is measured on its own, against a baseline built from the same tree minutes earlier.**
`Crash Bandicoot (USA)`, 30,000 frames, both input arms:

| | before | after |
|---|---|---|
| scripted input: writes past the end of RAM | 387 | **0** |
| scripted input: longest static run | 27,038 from frame 2,963 | **518 from frame 713** |
| scripted input: distinct frames | 321 | **495** |
| no input: writes past the end of RAM | 1,367 | **0** |
| no input: longest static run | 8,076 from frame 21,925 | **595 from frame 23,851** |
| no input: distinct frames | 5,674 | **7,472** |
| save state size | 4,019,632 | **4,019,632** |

**All four controls hold, 30,000 frames each.** `The Raiden Project`, `Asteroids (USA)` and
`Agile Warrior F-111X` stage no sector at all and are unchanged on every aggregate — sectors clocked,
end LBA, longest static run and its start, lit fraction, dimensions and **audio hash** — and
`Asteroids` is bit-identical to baseline down to its video sequence hash. `WipEout XL` is the one
control the fix engages, and it is the one control that had the defect: its single destroyed sector
goes to 0 and it gains three distinct frames, 3,408 → 3,411, with sectors clocked (16,689), end LBA
(34,084), audio hash and dimensions identical. That is the fix working, not a regression. The video
sequence hashes of `Raiden` and `Agile` move without any other column moving; that is `UPSTREAM.md`
20, a pre-existing ares defect where a run stops being reproducible once the binary's layout shifts,
and a control arm carrying only the new struct member and none of its logic moves them the same way.

**D3 carries the same compromise as D2, for the same reason.** The new `fifo.deferred.sector` is
**not** added to `ares/ps1/disc/serialization.cpp`. The upstream form of this patch serializes it and
moves a save state 4,019,632 → 4,021,980; §2's rule forbids that, so the field is held live and
unsaved, and the measured 4,019,632 above is the rule holding. **The upstream patch should serialize
it**; `UPSTREAM.md` 18 says so and names the line, so the compromise does not travel.

**The hole this leaves is wider than D2's, and it is worth stating plainly.** The window is one
sector-time wide — from the deferred INT1 until the host asks for the next sector — and only a title
that falls a sector behind ever opens it.

**D4 is measured on its own, both arms built from the same tree minutes apart, controls unchanged
between them.** It adds no state, changes no persistable layout, and needs no `serialization.cpp`
line — `dma.counter` is already serialized (`ares/ps1/dma/serialization.cpp:13`) and D4 only assigns
to it. So unlike D2 and D3 it carries **no compromise**: the hunk here and the hunk that should go
upstream are the same ten lines.

| 2,500 frames each | before | after |
|---|---|---|
| `Asteroids (USA)` | never reaches the word bound | **trace and entire save state byte-identical** |
| `WipEout (USA)` | never reaches the word bound | **trace and entire save state byte-identical** |
| `Crash Bandicoot` | reaches it 442 times; distinct 85/63/3/21/68, lit 98.11/36.09/5.64/4.22/18.41 | **identical distinct counts, identical lit fractions**; audio energy differs in the 4th decimal, 28 pad polls in one window |
| `The Raiden Project` | reaches it 2,636 times; distinct 85/63/2/18/354, lit 98.11/36.10/4.72/4.44/94.89 | **identical distinct counts, identical lit fractions**; audio energy differs in the 4th decimal |
| `Syphon Filter (v1.0)`, 7,200 frames | frozen from frame 3,241: 0 CPU instructions per frame, screen black for the rest of the run | recovers by frame 3,486; windows at 4,800-6,000 report **101 distinct frames at 100% lit** with audio, and a dumped frame shows the attract demo in-game |
| save state size, all five | 4,019,632 | **4,019,632** |

The two discs that never reach the bound coming out byte-identical is the shape that says D4 is
confined to lists that do not terminate inside one call. The two that do reach it keeping every
distinct-frame count and every lit fraction is the shape that says the difference is bus-interleave
phase, not behaviour.

**What D4 is not.** It is not a GPU draw-time model and not a general DMA timing model. ares reports
GPUSTAT bits 26 and 28 from `io.pcounter` alone (`ares/ps1/gpu/gp1.cpp:24-26`) and has no
per-primitive cost anywhere, where DuckStation and mednafen both accrue real rasterizer ticks; that
is a genuine and much larger gap, and several titles are documented as needing it. D4 does not
address it and does not claim to. The `0x1000` window is one CPU clock per word walked, chosen to be
invisible to the control discs, not a measured hardware ratio.

A **normal save/load** passes `synchronize == true` to `ares/ps1/system/serialization.cpp:34`, so
`power(/* reset = */ false)` runs and clears all of `fifo.deferred`, the new staging slot included.
The serialized fields then restore the deferred INT1 without the bytes it announces, so a state
captured inside the window loses exactly the one sector the fix would have saved. That is the
pre-fix outcome, confined to states saved in the window; the machine is otherwise consistent.

**Run-ahead** (`desktop-ui/program/program.cpp:105`) and **rewind**
(`desktop-ui/program/rewind.cpp:23`) both serialize with `synchronize == false`, so `power(false)`
never runs and they neither clear the hold nor restore it — the restored machine inherits whatever the
live instance is holding. Neither feature exists in the web build, and both are branch-local exposure
the upstream patch does not have: with the `serialization.cpp` line in place the slot travels with the
state and none of this arises.

---

## 3. Shared code native compiles but never uses (3)

Nothing is emitted into a native binary. The source is still yours to maintain.

- **T2 — `Thread::synchronizeExcept()`** (`thread.hpp`, `thread.cpp`, unguarded). A variadic
  template that synchronizes every thread except the named ones. All four call sites — `fc`, `ms`, `gb`,
  `md` CPUs — are inside `PLATFORM_WEB`, so it is never instantiated natively. It exists because a
  CPU that advances some chips by plain calls must still let the scheduler handle the rest. It is
  not the no-op it looks like: a Paddle, Sports Pad, Mega Mouse or Fighting Pad in a controller port
  is a real cothread, and only this call advances it.
- **T3 — `Scheduler::synchronizingPrimary()`** (one-line `inline` accessor). The primary-thread
  counterpart of the existing `synchronizing()`; see §1 for what calls it and why.
- **N2 — `Platform::Web` / `Architecture::wasm32` constants.** `static constexpr bool … = 0;` added
  to five `Platform` and eight `Architecture` structs, matching the existing idiom where each struct
  enumerates every value.

---

## 4. What is behind a web guard (26)

Summarized, since native never sees it: the Emscripten CMake platform detection and its three
module files; the libco Emscripten fiber backend and its 128 KiB stacks; `PLATFORM_WEB` /
`ARCHITECTURE_WASM32` detection in nall; the SH2 recompiler wrapped in `#if defined(SLJIT)` with a
stub for wasm; `Path::program()`, `thread::setName()` and `Video::Threaded` web branches; the
scheduler's `active()` stand-down, `webAdvance` hook, `_resume` restore and dead-stack zeroing; and
the eight cores' synchronous catch-up recipes with their flat `runCycle()` twins.

**gb and gba are the two cores whose ports are guarded end to end.** Every hunk in `ares/gb/` sits inside
`#if defined(PLATFORM_WEB)`, so unlike `fc` (F2) and `ms` (M2) it contributes nothing to §2c. Its
flat stepper needs a latched arm where fc's needs none: `PPU::main()` chooses between four arms
from state a mid-unit register write can change, and its display-off arm runs 456 × 154 clocks
through an `n9` counter that wraps 137 times, so `status.lx` alone cannot locate a position inside
it. `PPU::runCycle()` therefore carries `unit.arm` and `unit.counter`, both serialized only under
`if(!scheduler.getSynchronize())` — the persistable layout stays byte-for-byte native's.

One placement in gb has no counterpart in the other four: `ares/gb/ppu/io.cpp` resets `unit` when
LCDC bit 7 is toggled. That write is the only place in `ares/gb/` that re-derives a thread at
runtime, and re-deriving is *how* the native build discards the unit `main()` was part-way through.
The flat stepper holds that position in a member rather than in a suspended stack, so it has to be
dropped explicitly or the next `runCycle()` resumes an arm native abandoned.

**gba's port is guarded end to end as well, and it is the only one that changed no call site.** The
advance synchronizes its chips from nine places, and rewriting each would have been nine guarded
edits in core code. Instead `Thread::synchronize` gained one web-only virtual, `Thread::webAdvance`
(`thread.hpp`, `thread.cpp`), which a flat-advanced chip overrides to run itself up to the caller in
place of the cothread switch; every existing call site then works unchanged. It is reached only
inside the `while(thread.clock() < clock())` loop, so it costs a virtual call exactly where a
cothread switch would have happened — the other five cores take about two of those per frame — and
it takes the caller rather than a clock because `Scheduler::exit` rebases every thread's clock at a
frame boundary, which a chip can reach from inside the call. The hook is declared inside
`#if defined(PLATFORM_WEB)`, so native has no such virtual and no vtable slot for one.

**pce is the first core to be ported with no new mechanism at all**, which is the return on that
hook. Three chips override `webAdvance` and the cpu keeps its cothread. The port itself needed
nothing from `ares/ares/scheduler/`; the one edit there since — T6 below — is a consequence of the
empty entry points it introduced, not a mechanism the port required. Like gb, gba and ng it is
guarded end to end and contributes nothing to §2c. See §8.15 and §8.16.

**ps1 is the first core ported with no synchronization work at all**, which is a different claim
again: it overrides `webAdvance` nowhere, keeps all five of its cothreads, and clears the frame
budget on upstream's own CPU throttles. Its entire footprint in `ares/ps1/` is the
`ARES_PS1_COTHREAD` hook in `ps1.hpp` and one `Threaded` flag in `accuracy.hpp`, the second keyed on
`__EMSCRIPTEN__` rather than `PLATFORM_WEB` because the reference build undefines the latter before
that header is reached. It too contributes nothing to §2c. See §8.17.

Four of these are worth knowing about even though they are guarded, because they touch shared files:

- **T5 — dead C stack zeroed out of run-ahead states** (`Thread::serialize`). The weakest placement
  on the branch, and worth saying so plainly. `Thread::serialize` copies `Thread::Size` bytes from
  the cothread handle, dead memory included. Because the web build advances sound chips by plain
  calls on the CPU's cothread, the *host* audio resampler's temporaries spill onto that stack and
  get serialized, so two runs from one state diverge on bytes no machine register can observe. The
  fix zeroes below the suspended stack pointer. It is symptom-level: the real oddity is that host
  temporaries land on a serialized stack at all. It is confined to the run-ahead path — persistable
  states never reach the code, which is inside `if(!scheduler._synchronize)`.
- **T4 — `_resume` restored to the primary** (`Scheduler::enter`). See §6; the defect is shared, the
  fix is not.
- **T6 — a handle's pending entry point retired with the handle** (`Thread::create`,
  `Thread::restart`, `Thread::destroy`). Three one-line `std::erase_if`s enforcing one invariant:
  at most one pending `EntryPoints()` entry per live handle. The `create`/`restart` two are this
  branch's own leak; the `destroy` one is an upstream use-after-free that native can reach, gated
  here only to honour the no-native-change rule. §8.16 gives both halves and the measurements.
- **N6 — `nall::vfs::cdrom::loadCue` loads the disc on the calling thread** (`nall/vfs/cdrom.hpp`,
  +27/−4). `thread::create` is `pthread_create`, which the web build has none of, so natively the
  decode runs on a worker and on the web it never runs at all — `_loadOffset` stays 0 and the first
  data-sector read spins forever. The web arm calls the same body immediately instead, duplicating
  none of its 71 lines, and neither `wait()` nor `~cdrom()` needed changing. Native's text is
  verbatim in the `#else`. §8.17 gives the mechanism and why the two "missing" arms are not missing.

---

## 5. Rejected alternatives, on record

- **Sync-granularity batching** (fc, sfc, ms, md). Shipped, measured, and removed. On the SNES,
  granularities 4 through 128 all landed at ~290–310 fps against a cycle-exact reference of ~315 —
  the batching was slower than the thing it was meant to accelerate. It had cost a four-function
  public ABI, a preview selector and a documented fidelity hazard.
- **Pinning the NES APU exact for whole DMC samples.** Simpler, tried first; halves the frame rate
  on any game with continuous DMC drums, to protect one cycle in four hundred.
- **Widening the serializer gate** instead of retiring live state before the safe point. Changes the
  persistable layout and forces a `SerializerVersion` bump, which breaks interchange with desktop.
- **Looping `runCycle()` to reach a Mega Drive line boundary.** `runCycle()` always ends by stepping
  the next slot, so it can never land on the boundary; `finishScanline()` drives
  `stepSlot()`/`finishSlot()` directly.
- **Reproducing the last 1.6% of YM2612 write timing.** Requires running the 68000 from inside the
  Z80's catch-up — the cothread ping-pong the port exists to remove.
- **Also zeroing the Asyncify stack's unused tail** (T5). Dead by the same argument, but nothing
  measured shows it carrying residue, and the smallest change that fixes what was measured is the
  one that can be checked.

---

## 6. Bugs found, and what was done about each

Three commits are named "fix". **None of them fixes a native defect** — each repairs web-only code
this branch introduced. Stated plainly so the branch is not read as claiming more than it did:

- `a3848b937` "fix PPU dot-zero rendering" — the bug was in `PPU::runCycle()`, introduced two
  commits earlier. The native `renderScanline()` was never wrong.
- `7ce473807` "fix stale controller clocks, restore the refresh template" — `Controller::catchUp()`
  is a `PLATFORM_WEB` virtual this branch added. "Restore the refresh template" reverts a native
  codegen regression the branch itself introduced by demoting `_refresh` to a runtime `bool`.
- `c5b9de4d5` "fix YM2612 write timing and the Z80-reset sample offset" — both fixes are web-side.

A fourth was found later, by playing a commercial cartridge rather than by any test here: the Z80's
wait for the 68000 bus in `APU::readExternal` could never end on this platform, so a Mega Drive game
whose sound driver streams from ROM froze the tab outright. §8.13 gives it, the shape that was
measured and rejected first, and the sweep configuration that now fails without the fix.

Three genuine defects in shared or native code were found and **not** fixed. These, the PC Engine's
four in §8.15, the three compact-disc ones and the PlayStation's memory-card one in §8.17, and the
two build-system ones in §8.2 and §8.4 are collected in **`UPSTREAM.md`** with
their evidence and a reproduction each — that file is the one to work from if any of them is ever
sent back to upstream, since none of them needs this branch to reproduce:

1. **A native Mega Drive loses one YM2612 sample per Z80 reset.** `Thread::restart` calls
   `co_derive`, discarding whatever the cothread held, including the sample `OPN2::main()` had just
   clocked. The web build reproduces this deliberately, because bit-equality with the cothread build
   is what is being measured. Worth reporting and fixing upstream on its own, independently of this
   branch.
2. **`Scheduler::_resume` is left pointing at the last auxiliary thread** after a synchronization
   pass; it was only reset in `power()`. Native never notices because every chip has a cothread to
   be resumed on. The fix here is `PLATFORM_WEB`-only, so **native keeps the latent behaviour** — a
   deliberate scoping choice that the commit does not state as one.
3. **`OPLL::unload()` clears the node but never calls `Thread::destroy()`**, so the handle outlives
   the device. The web guard tests `opll.node` instead of `opll.handle()` to work around it; native
   is untouched.

A fourth, introduced by this branch rather than found in it, and recorded here as unfixed:
**`Thread::EntryPoints()` grows without bound in the web build.** An entry is pushed by every
`Thread::create` and erased only when that cothread is first entered. Natively the gb PPU's cothread
is entered continuously, so the LCDC display-enable toggle's re-derivation (`ares/gb/ppu/io.cpp`)
consumes its entry immediately. Under the web build that cothread is entered only during a
synchronized save, so a game toggling the LCD leaks one entry per toggle.

**That paragraph is now out of date in two ways, and both are corrections rather than additions.**
The leak is not confined to a toggle: on the PC Engine it is three entries *per load*, measured, for
the ordinary case of loading one game after another. And "benign" was an assumption, not a
measurement — the vector is walked on thread entry and `Thread::Enter` takes the **first** handle
match, so a stale entry sitting earlier is precisely what gets run. It is fixed as of §8.16, gated,
in the three places that know a handle's pending entry has become unreachable. The half of it that
lives in `Thread::destroy()` turned out to be upstream's rather than ours and is `UPSTREAM.md`
entry 8; the half in `Thread::create`/`Thread::restart` is still ours, and the evidence for that
split is a measurement rather than an argument.

---

## 7. Corrections to the commit record

Found by auditing the commit messages against the code. Recorded here rather than quietly left:

1. `e5a9e7926` says "two 32-bit-target fixes"; there are **three** narrowing sites — the two `mia`
   files and `ares/ares/memory/{readable,writable}.hpp`, which is not named.
2. The same commit's "the 32-bit fixes are no-ops where `size_t` is already 64-bit" is **not true of
   `mia/medium/famicom.cpp`**, which narrows to `u32` rather than casting. See S1 in §2b.
3. The same commit's "Native builds are unaffected" is accurate as scoped to the cores, but not to
   the build system (B2, B5, B7, B8) or the two memory headers (S3).
4. `15013b6a4` describes the `_resume` defect as a property of the shared scheduler but fixes it
   web-only, without saying that narrowing is deliberate.
5. `036e29768`'s `lineVisible` rationale **understates itself**: upstream already evaluated all
   three `vlines()` calls before any `step()`, so no native retargeting was ever possible. The
   change is a stricter no-op for native than the message claims.

---

## 8. Rationale gaps, closed by experiment

The five build-system gaps were settled by reverting each hunk and running a configure or a build,
not by recalling intent. Every result below is a command anyone can repeat; §9 lists them. Host:
macOS 15, CMake 4.3.2, Emscripten from `~/emsdk`. Upstream baseline is `e5a9e7926^`.

### 8.1 B2 — `ARES_BUILD_DESKTOP` was not load-bearing; removed

A stock native configure with the desktop frontend enabled builds `sourcery` on its own in about
five seconds (`cmake -S . -B out -DARES_CORES=sfc` then `cmake --build out --target sourcery`), and
writes the `sourceryConfig.cmake` that the cross-build imports. So the option is not needed to
produce the cross-compilation helper.

It is also not needed by the web build itself: `CMakeLists.txt:15` already forces it `OFF` under
`OS_EMSCRIPTEN`, so no web user ever passes it.

What it does buy is a native configure that skips `ruby`/`hiro`/`desktop-ui` entirely. On macOS
those resolve against system frameworks and cost nothing, so the measurement here cannot show a
benefit. On a Linux machine without GTK3/ALSA development packages a stock configure fails outright,
and `-DARES_BUILD_DESKTOP=OFF` is what would make the helper build possible there. **That case was
not measured** — no Linux host was available — and it was the only argument for keeping the option.

**Removed.** A brand-new, default-`ON`, project-wide option that wrapped five upstream call sites —
including `.github` and `cmake`, which have nothing to do with either the desktop frontend or the
web build — is a large structural edit to the root build file to buy something no measurement here
needed. The three subdirectories the web build must skip are now skipped by `if(NOT OS_EMSCRIPTEN)`
directly. `.github` and `cmake` turned out to need no guard at all: an Emscripten configure adds
them without complaint. Linux contributors who want a frontend-free native configure should get
that upstream on its own merits, not as a side effect of a WebAssembly port.

### 8.2 B5 — repairs an upstream bug that has nothing to do with the web build

Upstream master, native, no Emscripten involved:

```
cmake -S . -B out -DARES_TREAT_NALL_AS_SYSTEM=OFF
CMake Error at nall/nall/CMakeLists.txt:67 (target_include_directories):
  target_include_directories may only set INTERFACE properties on INTERFACE targets
```

`nall-headers` is `add_library(nall-headers INTERFACE)`, so `PUBLIC` is rejected outright. The line
sits in the `else()` branch of an option that defaults `ON`, which is why nobody has hit it: at the
default the `SYSTEM INTERFACE` line runs instead and the broken line is never evaluated.

The port hit it because `CMakeLists.txt:17` forces that option `OFF` for Emscripten. **That force
turns out to be unnecessary.** Built with the upstream default `ON`, the `sfc` core compiles with
zero warnings and zero errors, and the only object file that differs from the `OFF` build is
`ares.cpp.o` — whose sole source difference is the git version stamp (`8201d1ee0` versus
`8201d1ee0-modified`, an artefact of the test tree being dirty). No other object differs; the
`-I` → `-isystem` change produces no codegen difference at all.

**Both removed.** The `ARES_TREAT_NALL_AS_SYSTEM` force is gone from `CMakeLists.txt` and
`nall/nall/CMakeLists.txt:67` is back to upstream's text, unreachable at the default exactly as it
is upstream. The web build now runs on the upstream default. The upstream defect is real and worth
reporting on its own; it does not need to ride on this branch.

### 8.3 B7 — not required; removed

With B8 applied and `cmake/common/helpers_common.cmake` reverted to upstream's `COMMAND sourcery`
and implicit `DEPENDS`, the Emscripten cross-build configures, builds `ares-resource` and
`mia-resource`, and produces `resource.cpp` byte-identical to the branch's output
(`2718276b676fa3fd90613eb58f7103893dba8373`, `f9a98f9fc256898e8758776e792a65491c4cd75b`).

Applied *without* B8 it is strictly worse than upstream — the configure fails:

```
CMake Error at cmake/common/helpers_common.cmake:6 (add_custom_command):
  Error evaluating generator expression: $<TARGET_FILE:sourcery>  No target "sourcery"
```

B7 only ever worked because B8 made the target visible. **Removed** — `cmake/common/helpers_common.cmake`
is now byte-identical to upstream, so the branch no longer edits a helper every ares build uses.

### 8.4 B8 — required, and the reason is scope

Revert it and the cross-build configures fine but fails at build time:

```
[100%] Generating .../ares/resource/resource.cpp
/bin/sh: sourcery: command not found
```

`tools/sourcery` is added at `CMakeLists.txt:69`, but `add_sourcery_command` is called from
`ares/CMakeLists.txt:18` and `mia/CMakeLists.txt:4` — directories added at lines 41 and 42. Under
cross-compilation `sourcery` is an *imported* target from `find_package`, and imported targets are
directory-scoped: they are not visible in sibling directories, still less in ones processed
earlier. So `sourcery` never resolves to a target in those scopes and CMake emits it as a literal
program name to be found on `PATH`. `IMPORTED_GLOBAL` makes it visible everywhere, after which
upstream's own rule text resolves correctly.

This is a pre-existing cross-compilation defect that the web build is simply the first thing to
exercise. It is worth saying plainly in any upstream discussion: the hunk touches a native path,
but the path was already broken.

### 8.5 B4 — inert; removed

`find_package(Threads REQUIRED)` **succeeds** under Emscripten (`-- Found Threads: TRUE`, via
`CMAKE_HAVE_LIBC_PTHREAD`), and `Threads::Threads` contributes nothing: no `-pthread` appears
anywhere in the generated build files, count zero. Removing the guard changed neither the configure
nor any command line. **Removed** — it was defensive code guarding against nothing.

### 8.6 What the removals cost, and the evidence they cost nothing

Four changes are gone: B2 with its option, B5 with the `ARES_TREAT_NALL_AS_SYSTEM` force that made
it reachable, B7, and B4. `cmake/common/helpers_common.cmake` is back to upstream byte-for-byte,
and `nall/nall/CMakeLists.txt` is now entirely `OS_EMSCRIPTEN`-conditioned, with nothing in it a
native build can reach. **B8 is the only build change outside `wasm/` that native can reach at all.**

The whole suite was re-run afterwards, from a wiped `build_native` and `build_wasm` and freshly
rebuilt `ARES_MS_COTHREAD` / `ARES_MD_COTHREAD` reference trees:

- `state-smoke` — all four cores round-trip. Persistable sizes unchanged at 5325 / 265953 / 58231 /
  212031 bytes; `stateDriftBytes` 0, 0, 0, 2, the last being the cartridge-clock floor a native
  build measures identically.
- `fc-sweep` — both DMC modes identical. `dsp-sweep` — goldens match.
- `ms-sweep` — 4/4 goldens, and bit-identical to the cothread reference on audio and video.
- `md-sweep` — 4/4 goldens; screens identical, audio 38.5–38.7 dB SNR against its documented 34 dB
  floor. `md32x-sweep` — 5/5 goldens, audio and video identical.

Every number matches what the branch measured before the removals.

### 8.7 gb, added afterwards, and what it measured

`gb` was ported after the removals above and re-ran the same suite. Its own numbers:

- `gb-sweep` — 5/5 configurations (`dmg`, `cgb`, `cgb-double`, `lcd-off`, `cgb-auto`) **identical** to the
  `ARES_GB_COTHREAD` reference on audio, video and stream length. Throughput 269 fps against the
  reference build's 19.5, the largest margin of any core here, because gb switched cothreads once
  per master clock rather than once per scanline or sample.
- `state-smoke` — five cores round-trip. gb's persistable state is 17774 bytes with
  `stateDriftBytes` 2; the cothread reference reports the same 17774 and the same 2, which is what
  says the web build's persistable layout *is* the native one. **Sixteen bytes of a gb persistable
  state are not reproducible and never were:** `APU::power()` seeds `wave.pattern` from a PRNG, so
  two fresh instances of the same build differ there. Pre-existing, invisible to video and audio,
  and worth knowing before anyone runs a byte-for-byte `cmp` against a desktop state and starts
  hunting a phantom.
- The retire hook was removed and the suite re-run to check it is load-bearing: `stateDriftBytes`
  rose 2 → 10 and the persistable video hash collapsed onto the run-ahead one. **`restoreExact`
  stayed `true` throughout** — it cannot see this defect, because `unit` is absent from a
  persistable state entirely, so `stateDriftBytes` is the only signal that moves.
- Native codegen: `__text` and the symbol table are byte-identical for all six gb translation units
  against upstream, at `-O2` with `-DENABLE_IPO=NO`. Whole-object hashes do differ, in DWARF only —
  three headers gained lines, which shifts line numbers in every file that includes them. That is
  why `cartridge.cpp.o` and `system.cpp.o` differ despite never being edited.
- `dsp-sweep`, `fc-sweep`, `ms-sweep`, `md-sweep`, `md32x-sweep` all still match their goldens with
  `gb` in `ARES_CORES`, and sfc's persistable state is still 265953 bytes. This matters because
  adding gb defines `CORE_GB`, which compiles Super Game Boy into `ares-sfc-wasm` — the binary grew
  3.1 MiB → 3.3 MiB and behaved identically.

**Super Game Boy is out of scope for the browser build**, as Mega CD is. It is not gated off:
there is one `ARES_CORES` per configure, and suppressing `CORE_GB` would mean either a second
configure or a port-only project-wide option — the class of change §8.1 already removed. So the
code compiles, is unexercised by any harness here, and would run through the ICD's nested
scheduler (`ares/sfc/coprocessor/icd/icd.cpp:36-39`), which is the cothread ping-pong this branch
exists to remove. `ares/sfc/system/serialization.cpp:54` keeps a non-SGB SNES state clean either
way, which is what the unchanged 265953 confirms.

The stronger point is about SGB states rather than non-SGB ones. `ICD::serialize` passes the SNES
scheduler's `getSynchronize()` into `GameBoy::System::serialize`, which sets it on `ares/gb/`'s own
separate `Scheduler` instance. So a synchronized SNES state containing an SGB takes gb's gated path
too, and `unit` is excluded from it by the same condition that excludes it standalone — the SGB
persistable layout stays native's **by construction, not by luck**. That `ares/gb/` carries its own
scheduler is also why the flat-stepper recipe works unchanged under the ICD: it is scheduler-local.

One harness concession is recorded rather than hidden: `state-smoke`'s cross-instance audio
comparison is **reported, not asserted, for gb alone**. gb settles 240 frames because its boot ROM
animation has to finish, eight times any other core, and a save state does not carry the host-side
audio resampler — past roughly a hundred frames the two instances sit at different resampler phases
and the comparison stops being about the state. Three measurements place it outside the state: the
`ARES_GB_COTHREAD` build reports it identically, dropping gb's settle to the shared 30 makes it
pass with the same 17774 bytes and the same drift, and `audioSampleDelta` stays 0 — nothing is lost
or gained, only shifted. The other four cores keep the assertion.

### 8.8 gba, and the measurement that decided whether to port it at all

The advance was already faster than the console it emulates -- 75 fps headless against 59.7 Hz -- so
unlike the other five cores there was no obvious case for touching it. Two measurements decided it,
and they disagreed with each other:

- A CPU profile put `PPU::main()` at 29% of self time and the named Asyncify machinery
  (`Thread::Enter`, `trampoline`, `doRewind`) under 5%. Read on its own, that says the core is
  compute-bound and the port is not warranted.
- Widening the cpu's periodic full sync from 1024 to 16384 clocks removed 1,018 switches per frame
  and 1.2 ms of a 13.3 ms frame. An earlier, independent experiment -- deleting the per-step
  `Thread::synchronize(display, player)` -- removed 634 switches and 0.76 ms. Both put a switch at
  **1.2 microseconds**, and at 5,901 switches per frame that is over half the frame.

The profile was not wrong, it was misread: an Asyncify unwind is charged to every function on the
suspended stack, not to the fiber machinery, so it hides inside `PPU::main()`'s self time. **The
marginal experiment is the one to trust**, and it is the reason the port went ahead. Both mutations
were throwaway; neither is in the branch.

A third experiment failed usefully. Stripping every `Thread::synchronize` at once, to measure the
ceiling directly, deadlocks: an auxiliary chip that never synchronizes never yields, so the frame
never ends. The ceiling is not measurable that way, which is why the marginal method was used.

Where the 5,901 switches per frame went, counted by source and target with a temporary probe in
`Thread::synchronize`: 2,006 cpu<->display, 1,980 cpu<->ppu, 1,880 cpu<->apu, 34 cpu<->player. After
the port: **2 per frame**, the frame-boundary scheduler exits, at 107 fps against the cothread
build's 43.

Its own numbers:

- `gba-sweep` -- 6/6 configurations (`full`, `accurate`, `no-raster`, `no-dma`, `rtc`, `player`)
  **identical** to the `ARES_GBA_COTHREAD` reference on audio, video, stream length *and the bytes of
  a synchronized save state* over 300 frames, at roughly 2.4x-2.7x throughput -- wall-clock, so that
  one figure moves with host load where the rest do not -- plus an
  `after-a-save-state` row that keeps comparing for 300 frames once a state has been taken.
- `state-smoke` -- six cores round-trip. gba's persistable state is 398327 bytes with `restoreExact`
  true. Its `stateDriftBytes` is 27 against the cothread build's 0; that number is measured and
  bounded below, and reaches no frame of video or sample of audio.
- `save-smoke` -- six cores round-trip. gba gathers a 32 KiB SRAM battery and survives the pattern,
  the refusals and a fresh instance.
- Native codegen: not compared, because it did not need to be. All nine translation units of
  `ares/gba/` and `ares/ares/ares.cpp` **preprocess to byte-identical text** with and without the
  port -- `git stash push -- ares/`, preprocess with the commands in
  `build_native_gba/compile_commands.json`, strip `#` line markers, hash. Identical input to the
  compiler is a stronger claim than identical output from it, and a cheaper one to make.
- The other five cores were re-run with the shared `Thread::webAdvance` hook in place: every smoke
  test, every sweep's goldens, `state-smoke` and `save-smoke` all still pass, and the persistable
  sizes are unchanged at 5325 / 265953 / 58231 / 212031 / 17774 bytes.

**Three defects were found while porting it, all in this branch's own new code**, and each was found
by the cothread comparison rather than by reading:

1. `Display::main()` runs two statements *after* its last `step(223)`, so the cothread build leaves
   `++io.vcounter` pending until its next resume. The flat twin ran it immediately, the ppu read the
   counter a scanline early in `beginUnit()`, and one visible line in every few frames was skipped
   and another drawn twice. Fixed with an eighth phase that steps nothing.
2. `PPU::step()` puts its `Thread::synchronize()` between `Thread::step(1)` and `objReleaseBus()`, so
   a cpu resuming there still pays contention for the ppu's access flags. Releasing the bus before
   returning handed the cpu faster memory than the hardware gives it. Invisible in the default
   renderer and audible in the pixel-accurate one, where it was the last audio difference between
   the two builds.
3. `PPU::finishUnit()` carried the display along with it. Native reaches the same position during the
   scheduler's *auxiliary* walk, where every `Thread::synchronize` breaks before switching; the retire
   hook runs on the primary, where it does not. Suppressed explicitly.

**A fourth, in the harness rather than the core, and the coverage hole it was hiding.** The core has
six `webAdvance` overrides; five were exercised by the sweep and `Cartridge::RTC`'s was not, because
`Cartridge::load` brings that thread up only when `has.rtc`, and no cartridge in any check declared a
clock. Adding an `rtc` row surfaced why: an RTC cartridge answers reads and writes at ROM offsets
`0xc4`, `0xc6` and `0xc8` from its GPIO port instead of from the ROM
(`ares/gba/cartridge/cartridge.hpp:35-39,56-60`), and the stress cartridge's first two instructions
after the 192-byte header sat exactly there. It never ran at all — and the reference build agreed with
it precisely, which is the useful part: the comparison was working, the fixture was not. Real RTC
cartridges leave that window alone; this one now starts past it.

That row is worth keeping even though nothing it draws depends on the clock, because the state
comparison added alongside it does reach the clock. Picture and sound only ever check the chips that
draw or sound; a synchronized state checks all of them, which is what makes a chip like this one
checkable at all. Every sweep row now compares both builds' state bytes as well as their output.

**The residual, run to ground.** `stateDriftBytes` is 27 where the cothread build's is 0. It was
recorded here as unexplained and has since been measured; what follows replaces that entry.

The chain of comparisons that settles it, each one a cross-build state diff at the byte level:

1. Before any state is taken, the two builds' machines are **byte-identical** -- and so are their
   states, 398327 bytes with nothing differing, with and without a cartridge clock.
2. Restore the same blob into both and run: **byte-identical**, and still byte-identical 120 frames
   later. The restore path is exact and the run is exact.
3. Take a synchronized state and keep playing: **18 bytes differ**, immediately, and the figure does
   not grow with frames. So the divergence is neither in the state nor in the running -- it is what
   taking the state *leaves behind*.

That is a consequence of where the frame boundary falls. `PPU::frame()` calls `scheduler.exit()`, and
in the web build the ppu is advanced by plain calls on the cpu's cothread, so the machine suspends
inside the cpu's call chain; the cothread build suspends inside the ppu's. `Scheduler::enter(
Synchronize)` resumes from those two different points and walks two different routes to the same safe
point. Both arrive at the same machine -- the state proves it -- but the positions they are suspended
*at* afterwards are not the same, and the next save sees that.

The cost is nothing, and that is asserted rather than argued. `gba-sweep`'s `after-a-save-state` row
saves on both builds, runs 300 frames taking four more states along the way to keep both machines
perturbed, and compares every video frame and every audio sample: identical throughout. A regression
fails the sweep. The residual is bookkeeping no later frame reads, which is why 27 bytes sat next to
five bit-identical sweep configurations without contradiction.

### 8.9 gba, second pass: what the clean profile said once the switches were gone

The port's own profile could not be trusted -- 8.8 records why -- but with the switches down to 2 per
frame the same profile becomes honest, and it says something different: `CPU::step` at 19.4% of self
time and `PPU::runCycle` at 19.2%, neither of it rendering. Both are per-clock loops that re-decide,
280,896 times a frame, questions whose answers cannot change between decisions.

**The ppu's dead clocks.** With pixel accuracy off -- the desktop default, and the sweep's `accurate`
row covers the other arm -- a 1,232-clock scanline has exactly three clocks anything is scheduled at:
0 (`beginUnit`), `4 + renderingCycle` (the render burst, which runs to completion inside that one
clock), and the wrap. The object unit is only mid-evaluation inside the burst itself, so on every
other clock `runCycle()` is: a `!active` early return, `Thread::step(1)`, a display catch-up check,
and the pending/release toggle. `PPU::webAdvance` now takes those clocks in one stride --
`Thread::step(n)` is n `step(1)`s by arithmetic, the toggle is unobservable between clocks because
nothing in the stride sets a bus flag, and the display only writes cpu state the cpu cannot read
before the call returns. The stride never covers the three scheduled clocks. Entirely inside the
`PLATFORM_WEB` block of `ppu.cpp`; native has no such function to change. Worth 107 -> 141 fps on the
stress cartridge. The first cut of the stride had an off-by-one -- `unit.cycle == renderAt` strode
over the render burst itself -- and the smoke test's video hash caught it before any sweep ran.

**The cpu's re-decided loop.** `CPU::step(clocks)`'s per-iteration body runs `stepIRQ` and four
`Timer::run`s per clock, but `Timer::run`'s tick test reads `cpu.clock()`, which is
`Thread::clock()`, and `Thread::step()` runs *after* the loop -- so within one call a timer either
ticks on every iteration or on none. When no ticking timer's period can wrap (the only event that
raises a flag, feeds a FIFO, or steps a cascade), the loop's total effect is arithmetic: each ticking
timer's period grows by `clocks`, and the irq pipeline -- a one-stage delay whose inputs nothing in
the loop is left to change -- either takes its single verbatim step or converges to `[0] = [1]` with
the synchronizer read through it. `pending` and `timerLatched` keep the two clock-order-sensitive
latch steps on the verbatim loop. Two smaller cuts ride along: the hcounter remainder only exists in
the wrap clock of a scanline, and the DMA `waiting` counters only move while a channel is holding
one -- skipping four unconditional `i32` stores per call was alone worth ~18 fps. Together 141 -> ~165
fps. This one lives in shared `cpu.cpp`, so it follows `mainWeb`'s pattern: a second expression of
the whole function under `#if defined(PLATFORM_WEB)`, with native's kept verbatim in the `#else` --
down to the blank lines, because the byte-identity gate below reads them.

**What was not done.** The remaining profile is the machine itself -- the ARM7 interpreter's
`std::function` dispatch, `CPU::get`'s bus walk, the APU's per-sample sequencer, the object and
background renderers. Those costs are upstream's design, identical in kind to what native pays, and
rewriting any of them is emulator work, not port work.

The evidence, re-run in full on the final text: `gba-smoke` with every hash and all ten buttons
unchanged at ~165 fps (from 107); `gba-sweep` 6/6 configurations identical to the cothread reference
on audio, video, stream length and state bytes, `after-a-save-state` identical, at roughly 3.7x-4.5x
the cothread build's throughput on the five whole-scanline rows and 2.7x on `accurate`, which the
stride does not apply to (wall-clock, from 2.4x-2.7x); `state-smoke` and `save-smoke` with the
same bytes and the same 27-byte residual; 6 switches per frame unchanged on the debug build; the
native `ares` target compiled; and `cpu.cpp` and `ppu.cpp` re-preprocessed against their pre-change
text -- **byte-identical**, so the transitive claim to upstream in 8.8 stands.

### 8.10 gba, third pass: the frame the stress cartridge never measured

The user's browser reported 10 ms a frame on a commercial cartridge while every headless number in
8.9 said ~6. Two hypotheses, both wrong in instructive ways. *The browser is slower than node*: a
headless Chrome run of the same binary, same warmup, same pure-`run_frame` timing measured 5.5 ms
on the stress cartridge -- slightly faster than node. *The page's binary was stale*: it was not; the
preview resolves `../build_wasm/wasm/ares-gba.mjs` on every load. The remaining hypothesis was the
workload, and it held: the same node harness pointed at the real cartridge measured the same ~10 ms
the browser showed. The stress ROM was built to drive every unit at once, and that made it blind to
what a real game's frame mostly is.

Profiled on the real cartridge, the new mass was the idle machinery: `CPU::step` at 20.7% with 7.1%
of the total arriving via `main()`'s halt path, `mainWeb` at 11.6% self, and ~7% of scheduler shell
(`Thread::Enter`'s loop plus the `std::function` boundary) paid once per `main()` call -- 54 million
calls over a 900-frame run. A halted cpu advances one clock per call; the stress ROM never halts.

**The halt stride** (`CPU::webHaltStride`, called from `mainWeb`). While halted, the loop's whole
body is: a `runPending` with nothing pending, the `irq.enable[0] & irq.flag[0]` wake test, and
`step(1)`. Nothing inside it can move the wake condition, so N iterations have a closed form up to
the earliest clock anything outside could write `irq.flag[1]`:

- the display's and player's next writes sit at chunk/unit headers, which fire at the first cpu
  clock strictly past `display.clock()`/`player.clock()` -- so `(thread.clock() - clock()) /
  scalar() + 1` bounds the stride to just short of the next header, no event enumeration needed;
- a timer overflow is computable while no enabled non-cascade timer can wrap: every 2^24 Hz thread
  has `scalar() = 2^39 - 1`, which steps the masked clock by exactly -1 per cpu clock, so the tick
  iterations are `i = clock() & mask (mod mask+1)` -- the code asserts the scalar property per
  timer rather than assuming it, and falls back to the verbatim loop if it ever fails to hold;
- DMA completion is excluded by requiring no channel `active`, and channels only *become* active
  from those same headers and overflows;
- `pending`, `timerLatched`, and an irq already in the two-stage pipeline all fall back to
  verbatim, as in 8.9's collapse.

Within the stride: timer periods grow by the closed-form tick count, the irq pipeline converges to
`[0] = [1]` (the 8.9 proof, N >= 2 enforced), the DMA `waiting` counters drain exactly as verbatim
would -- they are serialized state, so "nothing observable" includes state bytes -- and the
full-sync counter keeps its clock cadence, so the cartridge and apu threads are synchronized at the
same moments the cothread build picks. That counter was a function-local `static` in native's
`step()`; the web arm now uses a member (`webSyncCounter`, unserialized exactly as the static was)
so the stride and `step()` share one cadence. Instrumented on the real cartridge's intro, the
stride covered 62 million clocks -- a quarter of the run's emulated time -- in 110 thousand strides.

**Batching the entry point.** `mainWeb` runs up to 64 `main()`s per entry. The shell it amortizes
is per-call overhead in Run mode; the one thing the shell does -- yielding at a safe point -- is
requested by setting `SynchronizePrimary` and resuming the primary mid-`main()`, and `mainWeb`
already tests exactly that flag after every `main()`. Returning on it reaches `Enter`'s
`scheduler.synchronize()` at the first entry-point boundary after the request, which is the same
boundary the cothread build takes. Scheduler events (`Frame`, etc.) exit through `co_switch` inside
`main()` and never wait on the loop.

**Per-access costs.** `DMAC::runPending()` runs on every non-DMA bus access; with no channel active
its verbatim body is two `stallingCPU` writes and four failed `ready()` tests, none of it
observable -- nothing that reads `stallingCPU` runs inside it. A web expression answers the common
case with one load of each `active` bit. It sits at the end of `dma.cpp` rather than beside the
native function: a skipped `#if` region swallows adjacent blank lines into its line marker, and at
end-of-file there is nothing to swallow -- the same preprocessor behaviour that shaped 8.9's
`#else` placement, learned this time as: consumed directives in active text emit blank lines;
skipped regions eat the blanks on both their edges. `cpu.hpp`'s web block had to stay exactly three
source lines for the same reason, which is why its two new declarations share `mainWeb`'s line.
And `CPU::step` now hoists the two clock comparisons in front of `Thread::synchronize(display,
player)` -- when both threads are caught up, the call was an `active()` test (a `co_active()` call)
and two failed loop conditions, ~4% of a real frame.

**The dispatch experiment, run twice and dropped twice.** The ARM7 interpreter's `std::function`
tables rewritten as plain function-pointer tables -- arm adapters decoding from the runtime opcode
through each bind site's own `arguments` macro, thumb bind-time constants packed into 16-bit lanes
of a u64 and unpacked by arity and parameter types from the handler's own signature, both
initializers verbatim copies with only the bind macro changed. It measured *neutral* on the stress
cartridge (166 fps both sides, many runs; the profile moved the same ~11% from `std::function`
frames into the adapter and body frames, so the mass was the instruction bodies all along) and ~2%
on the real cartridge. Six hundred duplicated decoder lines in a component the sfc core also
compiles, for 2% on the workload that matters, fails this port's own bar -- dropped, and recorded
here so it is not rediscovered. The working patch is preserved in the session scratchpad
(`dispatch-experiment.patch`).

The numbers: stress cartridge 166 -> ~185 fps; the real cartridge (Super Mario Advance 4, title
demo -- which busy-waits; its in-game loops halt) 10.1 -> ~8.0 ms per frame. The browser tracks
node on both, per the headless-Chrome control.

The evidence, re-run in full on the final text: `gba-smoke` with every hash and all ten buttons
unchanged at ~185 fps; `gba-sweep` 6/6 configurations identical to the cothread reference on audio,
video, stream length and state bytes, `after-a-save-state` identical over 300 frames, at 4.07x-4.6x
the cothread build's throughput (3.0x on `accurate`); `state-smoke` gba 398,327 bytes with the same
27-byte residual and hash `b9084789` as 8.9 recorded; `save-smoke` green; 6 switches per frame
unchanged on the debug build; the native `ares` target compiled; and all nine native TUs of the
core -- the eight gba TUs plus `arm7tdmi.cpp` -- preprocessed against their pre-change text
**byte-identical**, so the transitive claim to upstream in 8.8 stands.

### 8.11 gba, fourth pass: the burst's no-ops, and the probe nobody answers

Run 2026-08-10, on the same real-cartridge bench as 8.10 (Super Mario Advance 4, title demo,
node, 5 x 120 timed frames after 300 of warmup). The profile was re-derived before anything was
touched, because 8.10 proved the priorities cannot be assumed: `CPU::step` 17.6% of self time,
`CPU::get` 14.6%, `mainWeb` 12.0% (the ARM7 instruction shell inlined into it), the renderers
~21% in aggregate (`Objects::step` 6.0%, `cycleUpperLayer` 6.0%, `runCycle` 3.3%, the background
fetch/render pairs the rest), `prefetchStep` 6.6%. Baseline 8.1 ms average, 7.7 best pass.

**Accepted, in the order they were measured, each individually:**

1. **The object evaluation loop cut short** (in `runCycle()`'s burst, web-only text).
   `renderScanline()` runs a fixed 1,232 `Objects::step()` calls per line; once the unit goes
   inactive -- a few hundred calls in, usually -- `step()` returns before touching anything, not
   even `activeCycle`, so ending the loop at inactivity skips only no-ops. 8.14 -> 7.82 ms.
2. **The background loops hoisted** (same burst). `blank()` and each layer's `enable[0]` cannot
   change inside a one-clock burst, and every render path begins by returning on exactly those two
   tests -- so a disabled layer's 247 calls were no-ops, hoisted to one test per layer per line.
   Splitting the interleaved x-loop into one loop per layer reorders nothing observable: each
   background touches only its own latch and output, and the one shared write, `vramAccessedBG =
   true`, lands the same whichever order sets it. 7.82 -> 7.46 ms.
3. **The per-pixel layer select inlined and collapsed** (same burst). `dac.upperLayer()`'s
   4-priority x 6-layer double loop visits qualifying pairs largest-first and keeps the last two,
   which is "the two smallest (priority, layer) keys" -- one pass over six layers finds the same
   pair. The window-enable test is hoisted per line; the blank arm writes the same 0x7fff the
   verbatim path writes. The constraint that shaped it: `mosaicOffset` and `hmosaicOffset` are
   serialized state, so the five `outputPixel()` mosaic calls stay verbatim, and the sweep's
   machine comparison would catch a byte moved. 7.46 -> 7.29 ms.
4. **The cheat probe dropped from the read path** (`bus.cpp`). `getBus` ends every read with
   `if(auto result = platform->cheat(address))` -- a virtual whose default answers nothing, which
   the web platform never overrides, and which no code in `wasm/` can reach: an indirect call and a
   `maybe<u32>` per bus read, measured by deletion mutation at **~10% of the frame**, the largest
   single item this pass found. `bus.cpp` now expresses `getBus` twice, dma.cpp's shape: native
   verbatim inside `#if !defined(PLATFORM_WEB)` with its two blank lines supplied by the consumed
   directives, the web twin -- identical but for that one line -- at end of file. 7.29 -> 6.54 ms.

**Dropped, each with its measured reason and its patch in the session scratchpad (`pp4/`):**

- *Collapsing the prefetch fill loop* wait-at-a-time instead of clock-at-a-time. Exact by
  construction (loads at the same clocks, same order, same addresses; non-positive waits drain
  identically), gate-clean -- and neutral on both workloads, twice. The cost is per call, not per
  iteration. Reverted under the 8.10 house rule.
- *`step()`'s `bool ticking[4]` narrowed to a register bitmask* on the theory that the array forced
  a wasm shadow-stack frame. Neutral to slightly negative: LLVM already scalarizes it.
- *A per-tile rewrite of the linear background path* -- tilemap read per 8 pixels, data halves
  batched, extraction inlined. Its first cut shipped an alignment bug (`x0 = a - 8` where the first
  tile is at `-(hoffset & 7)`) that the smoke test's video hash caught before any sweep ran; fixed,
  it measured neutral on the real game and ~4% on the stress cartridge alone. Sixty re-derived
  pixel-exact lines for the workload that is not the target fails the same bar the 8.10 dispatch
  experiment failed.

One preprocessor law from 8.10 got sharper: a skipped region swallows adjacent blank lines on both
edges *even when the blank sits inside the active `#else` arm* -- which is why `bus.cpp` uses the
consumed-`#if !defined` shape around native text rather than the `#if/#else` shape `cpu.cpp` uses,
and why the twin sits at end of file.

The numbers: the real cartridge 8.1 -> **6.5 ms** average (best pass 7.7 -> 6.2); the stress
cartridge ~185 -> **~245 fps**.

The evidence, re-run in full on the final text: `gba-smoke` with every hash and all ten buttons
unchanged at ~4.1 ms; `gba-sweep` 6/6 configurations identical to the cothread reference on audio,
video, stream length and state bytes, `after-a-save-state` identical over 300 frames, at 5.5x-6.2x
the cothread build's throughput on the five whole-scanline rows and 3.1x on `accurate`;
`state-smoke` gba 398,327 bytes, `restoreExact` true, the same 27-byte residual and hash `b9084789`
as 8.9 recorded; `save-smoke` green; 6 switches per frame unchanged on the debug build; the native
`ares` target compiled; and all nine native TUs -- the eight gba TUs plus `arm7tdmi.cpp` --
preprocessed against their pre-change text **byte-identical**, so the transitive claim to upstream
in 8.8 stands.

### The question an experiment could not answer, and how it was decided

Whether `-DARES_BUILD_DESKTOP=OFF` should exist as a supported native configuration, or whether the
web build should use `if(OS_EMSCRIPTEN)` and leave native users with no new option. No experiment
settles that; it is a maintenance-policy question about who else benefits.

Decided in favour of `if(OS_EMSCRIPTEN)`. A port should not add a project-wide build option that
only it uses, and the Linux frontend-free configure — the one real argument for the option — is a
separate request that deserves to be made on its own terms rather than smuggled in here.

### 8.12 Game Gear, which needed no port at all

Run 2026-08-10. The task was "port the Game Gear"; the finding is that there was nothing to port.
`ares/ms/` already compiles it — `System::Model::GameGear` is a run-time model set from the
configuration string (`ares/ms/system/system.cpp:65-68`), read by 25 call sites across the CPU bus,
the I/O ports, the VDP, the PSG and the controls — and the flat steppers, the retire hook and the
`ARES_MS_COTHREAD` reference all landed with `ms` in the first place. `CMakeLists.txt:27` already
listed `ms`. What did not exist was a shim that could reach any of it.

**The defect, which had shipped.** `wasm/ms.cpp` hardcoded the string `"Master System"` in four
places. Setting a Game Gear model makes `System::load` rename the system node to `"Game Gear"`
(`ares/ms/system/system.cpp:66,82`), which renames the cartridge slot's family and the cartridge
peripheral with it; `Backend::pak` then matched neither name, returned `{}`, `Object::setPak`
returned false, and `System::load` bailed at `system.cpp:92` reporting *"Could not initialize the
Master System core"*. `wasm/ms-preview.html:142` has offered a **Game Gear option since the preview
landed, and it has never worked.** One resolved name on the backend now drives the mia medium, the
mia system, `Backend::pak`'s node match and the MEMFS path together, because they are one fact and
four literals were four places to get it wrong.

**The extension is not cosmetic.** `mia/medium/game-gear.cpp:57` sets the cartridge's
Master-System-compatibility strap from `location.endsWith(".sms")`, and that strap feeds
`Mode::GameGear()` (`ares/ms/system/system.hpp:96`), which gates the 12-bit CRAM path, the
160x144 viewport and the whole port `0x00`-`0x06` block. A Game Gear image written to the shared
`.sms` path boots silently as a Master System: SMS palette, SMS CRAM format, 248x200 picture. The
image is written to `/ares-game.gg` under a Game Gear model for that reason alone. The same fact
kills the `game-gear-sms-mode` sweep row that looked obvious on paper: this ABI resolves the path
from the model, so the strap is unreachable through it, and a configuration for it would have been
a row that could never fail.

**`ARES_CORES` needed no change, and the experiment says why.** Adding `gg` to `CMakeLists.txt:27`
and configuring a throwaway directory produces a `CORE_GG` define — `ares/CMakeLists.txt:284-285`
emits one per core with a blanket `foreach` — and **nothing else**: no target, no subdirectory, no
source, and no consumer of the define anywhere in the tree. A dead token that would tell the next
reader it had configured something. Reverted; `:27` stays `fc sfc ms md gb gba`. There is no
`wasm/gg.cpp` and no `ares-gg-wasm` for the same reason `gb` has one module for DMG and CGB: Game
Gear ships inside `ares-ms.mjs`, selected by `ares_ms_set_model`, and a second target would have
linked a byte-for-byte second copy of the same core.

**Optimization.** Bench: `Ecco the Dolphin.gg`, node, 5 x 120 timed frames after 3,600 of warmup
with Start tapped through it so the measured frames are past the title screen, only
`ares_ms_run_frame` inside the timer. Builds were compared **paired and alternating** rather than
one after the other, because the whole delta here is smaller than an hour of machine drift.
Baseline 2.4796 ms/frame.

**Accepted, each measured individually:**

1. **The cheat probe dropped from the Z80 read path** (`ares/ms/cpu/memory.cpp`). `CPU::read` opened
   with `if(auto result = platform->cheat(address))` — the same virtual 8.11 found on the GBA, whose
   default answers nothing, which the web platform never overrides, and which no code in `wasm/` can
   reach. `memory.cpp` now expresses `CPU::read` twice, `bus.cpp`'s shape: native verbatim inside
   `#if !defined(PLATFORM_WEB)` with its blank lines supplied by the consumed directives, the web
   twin at end of file. 2.4690 -> 2.4326 ms, **1.5%**, complete separation over six pairs.
   **8.11 measured this same removal at ~10% of a GBA frame; here it is 1.5%**, and the gap is the
   point: the ARM7 pays a bus read on nearly every cycle of a frame whose renderer is comparatively
   cheap, while this core's frame is dominated by a per-dot VDP that the Z80 barely interrupts. A
   prior's magnitude does not transfer across cores; only its shape does.
2. **The backdrop colour computed lazily** (`ares/ms/vdp/dac.cpp`). `DAC::run` opened every dot with
   `palette(16 | io.backdropColor)` and then overwrote it on any dot the display actually draws, so
   a visible dot paid two `palette()` calls where one would do — and `palette()` is not a table
   read: on a Game Gear it runs three model predicates and a `videoMode()` before it reaches CRAM.
   Reordering is safe because `palette()` is pure. 2.4225 -> 2.2882 ms, **5.5%**, complete
   separation over five pairs. This is the item the pass turned on, and nothing in the GBA passes
   predicted it.

**Dropped, with its measured reason and its patch in the session scratchpad
(`reverted/c3-drop-modulo.patch`):**

- *The `% 284` dropped from the web twin's `output[(x + 13) % 284]`.* Provably identity — `x` is an
  `n8`, so `x + 13` never exceeds 268 — and it removes a division from every dot. Measured **+0.48%
  over thirteen paired runs**, with 11 of 13 pairs favouring it: probably a real effect, and still
  under the bench's own 1-4% run-to-run spread. A delta that does not clear the spread has not been
  measured. Reverted under the 8.10 house rule, which does not have a "but the code is obviously
  better" clause.

The halt stride 8.10 and 8.11 suggested was **not attempted**, and that is a gap rather than a
finding: the profile was not re-derived deeply enough to establish whether these titles halt at all,
and a closed form written against an unmeasured idle path would have been reasoning, not
measurement.

**The numbers.** `Ecco the Dolphin.gg` 2.4796 -> **2.3053 ms/frame** (403.3 -> **433.8 fps**),
**7.0%**, complete separation over eight pairs. `Tails' Adventures.gg` 2.4772 -> 2.3421 (5.5%);
`Super Off Road (USA, Europe).gg` 2.6299 -> 2.4172 (8.1%). The stress cartridge moves ~368/387 ->
~409/418 fps — **a larger gain than any of the three real games**, which is 8.10's lesson arriving
again from the other direction: a cartridge with the display always on and no idle path flatters a
renderer optimization, and had it been the only workload the pass would have reported ~10%.

**Two traps this pass paid for, both worth stating.**

- *The end-of-file shape is about the translation unit, not the file.* 8.11's twin sits at the end
  of `bus.cpp`, which is the end of what the preprocessor sees. `dac.cpp` is `#include`d into
  `vdp.cpp` (`ares/ms/vdp/vdp.cpp:6-13`), so its "end of file" has the rest of `vdp.cpp` after it.
  That much still worked; what did not was leaving the original blank lines in place around the new
  `#if`/`#endif`. A consumed directive **emits** a blank line, so a directive placed on its own line
  next to an existing blank produces two, and the gate caught exactly that — two spurious blank
  lines in `vdp.cpp`'s preprocessed text. The directive must sit flush against the neighbouring `}`
  and *replace* the blank, which is what `bus.cpp` does and what the phrase "its blank lines
  supplied by the consumed directives" in 8.11 actually means.
- *A stress ROM can make a working button look dead.* `gg-smoke`'s first run reported Start as not
  reaching the machine. Start is bit 6, which the test ROM folded into the horizontal scroll — a
  64-pixel shift — and the ROM filled VRAM with a plain `L` ramp, whose tile patterns repeat every
  256 bytes, which is every eight 32-byte tiles, which is exactly 64 pixels. The button worked; the
  picture aliased. The fill is `L xor H` now. A harness that cannot see a change is
  indistinguishable from a machine that did not make one, and it fails in the direction that looks
  like a real bug.

**The gate.** No script for the byte-identity check existed — section 9 describes the procedure in
prose and 8.8 names it, but `preprocess.sh` has never been in this tree. This pass wrote one
(`ppgate.py`, scratchpad only) that takes each TU's flags from its own `compile_commands.json`
entry, strips **only** genuine line markers and strips the whole line rather than blanking it, and
compares **bytes**. Two things it got wrong first, both found by self-test rather than by review:
blanking a marker with `^#.*$` leaves its newline, so a marker sitting where a blank line changed
*masks* the change and the gate reports identical on a real edit; and `^#.*$` also eats `#pragma`
lines, which survive preprocessing and are real source text. It was then proved to fail on a
one-line insertion, on a single mid-file blank line, and on the unguarded cheat-probe deletion, and
to pass on a clean tree — because a gate nobody has watched fail is not evidence. Note also that
`build_native_ms/compile_commands.json` had to be created: no compilation database covering
`ares/ms/` existed, and `build_native_gba/`'s 62 entries cover none of it.

**The evidence, re-run in full on the final text.** `gg-smoke` at 160x144 with stereo audio, seven
distinct button hashes, bits 7 and 8 and player 1 all inert, and overscan inert. `gg-sweep` 2/2
golden, and against an `ARES_MS_COTHREAD` build — which `ares/ms/ms.hpp:10-12` builds by undefining
`PLATFORM_WEB`, so it compiles the *native* arms and the comparison is differential — audio, screen
and machine state identical on every row, plus an `after-a-save-state` row identical on every row.
2 scheduler switches per frame against the cothread build's 42,508. `state-smoke` reports `gg` at
58,231 persistable bytes, `restoreExact` true, `advanced` true, `stateDriftBytes` 0 — the same
58,231 the Master System reports, which is what a shared core and an untouched layout should
produce — at `SerializerVersion` `"v131"`, unchanged. `save-smoke` reports 32,768 bytes of save RAM
through the existing table with no new entry. Master System: `ms-smoke`'s hashes are the ones it
reported before this work (`5236de0f`/`f35130e9`), `ms-sweep` reproduces all four literal golden
pairs and is identical to the cothread reference on all four, and no golden was edited. All eight
`ares/ms/` translation units preprocess byte-identically to a baseline captured before any edit, and
native `ares` still builds.

`gg` is a *system* of the `ms` core, not a seventh core: the module count stays six.
`ares-ms.wasm` grew 2,052,134 -> **2,053,688** bytes, +0.08%, which is the two web twins and nothing
else. The module-size table in `wasm/README.md` is left alone deliberately: its two columns measure
mia instrumentation on a build that predates this, and editing one cell of a paired measurement with
a number from a different experiment would make the table say something nobody measured.

*One item is `[M]` and was not done: no state blob was traded with a desktop build in either
direction. The layout evidence here is that the web build and the `ARES_MS_COTHREAD` build — which
compiles the native paths — produce byte-identical persistable state, which is a proxy for desktop
interchange and not a substitute for it.*

### 8.13 The Mega Drive hang a commercial cartridge found and six configurations did not

Reported as "MUSHA freezes when I press Start, and Chrome offers to kill the page". It is this
branch's own defect, in `ares/md/apu/bus.cpp`, and it had been shipping.

**The bug.** `APU::readExternal` and `APU::writeExternal` open with the Z80 waiting for the 68000
bus: `while(MegaDrive::bus.acquired() && !scheduler.synchronizing()) step(1);`. That wait cannot end
here. The Z80 is advanced by plain calls on the 68000's cothread (`CPU::catchUpAPU`), so while it
spins the 68000 is not running; the bus is held by a 68K→VDP DMA (`VDP::DMA::synchronize`), which
only the VDP can finish; and the VDP has no thread of its own either. Nothing can release the bus,
so `ares_md_run_frame()` never returns. MUSHA reaches it because its Z80 sound driver streams PCM
out of ROM through the bank window, so a Z80 external access eventually lands inside a DMA.

**How it was found, after two instrumentation passes found nothing.** Watchdogs on all six clock
catch-up loops, on both data-port spins, and a 20-million-call counter in `CPU::main` — none fired,
which located the hang inside a single `CPU::main()` call in a loop none of them covered. What
worked was not more reasoning but enumeration: every `while(` in `ares/md/`, `ares/ares/scheduler/`
and `ares/component/processor/z80/` listed out, which surfaces `apu/bus.cpp` immediately.
Instrumenting those two lines turned the hang into an abort at exactly the hanging frame. Two
methods are worth reusing: **save a state a few frames before the hang** — every iteration then
costs seconds rather than minutes — and **give each unbounded loop a counter that aborts naming
itself** rather than deriving which one it is.

**The fix, and the more obvious fix that was measured and rejected.** The obvious one is to advance
the VDP from inside the wait, which is exactly what `VDP::FIFO::write` and `VDP::readDataPort`
already do for the same hazard. It clears the hang. It is also wrong, and the cost is measurable:
the Z80 and the VDP race past the 68000, so the VDP-driven frame ends with the 68000 — and with it
the YM2612, which `catchUpAPU` runs to the 68000's clock — left behind. On MUSHA that cost 18% of
the audio stream over 900 frames (1,177,536 samples against the cothread build's 1,440,082), and on
the stress ROM below it cost 97%: 1,395 samples where the cothread build emits 47,177.

What ships instead **bounds the wait by the 68000's own clock**, which is what the cothread build's
structure already says it should be: there `APU::step` ends in `Thread::synchronize(cpu)`, so the
Z80 can never run past the 68000 — every step hands control back, the 68000 advances, and its
`wait()` drives the VDP through `catchUpVDP` until the DMA completes. Stopping at
`cpu.Thread::clock()` reproduces that handover. The read then applies with the bus still nominally
held, one more approximation on a path that already charges the 68000 a flat 68 Mclk instead of
stalling it for real. Stream lengths are equal to the cothread build's afterwards, on both MUSHA and
the stress ROM. The two VDP-side sites are left alone: they are entered from the VDP's side, they
pass every configuration, and nothing measured says to touch them.

**The evidence that the fix changes only the hang.** On MUSHA over 900 frames from cold boot with
Start pressed on a fixed schedule, **every pixel of every frame is identical to the cothread
reference** and the audio streams are of equal length. The residual 19.8% of samples at 20.5 dB is
not this fix: over the 700 frames before the hang, the fixed and the shipped builds report the
*same* numbers to the digit — 11.2% differing at 18.9 dB, screen identical, lengths equal — so that
divergence predates the change and the change does not move it.

**The coverage hole, closed.** The md sweep passed six configurations and never saw this, because
the stress ROM's Z80 never touches the 68000 bus at all: it drives the YM2612 at `0x4000` and stops
there. A fifth configuration, `z80-rom`, puts a ROM read and a ROM write through the bank window in
the Z80's inner loop, gated to one pass in sixteen — roughly one external access per 200 Z80 cycles,
the order a commercial PCM driver streams at. **On the build that shipped it does not finish a
single frame**: the other four configurations each print in about two seconds, and this one was
still in its first frame after four and a half minutes. That was checked before the row was kept,
because a gate nobody has watched fail is not evidence.

It is gated on its golden alone, and its output says so rather than staying silent. The reason is
measured, not assumed: Z80 bus stealing is approximated here as that flat 68-Mclk charge rather than
as real contention, so any ROM that makes the Z80 touch the 68000 bus measures the approximation far
more loudly than it measures scheduling. The same ROM with `noDma` added — the wait never entered,
no web-only code on the path — still reports 68.74% of pixels and 16.8 dB against the cothread
build. A threshold the change under test cannot move is not a threshold. At the first rate tried,
one external access per iteration, the same effect reached 91.7% and 13.2 dB; that is ~27× a real
driver and is why the rate is gated.

**The rest of the battery, on the final text.** All ten `ares/md/` translation units preprocess
**byte-identical** to a baseline captured before the edit — the change is a guarded twin at the end
of `bus.cpp`, its `#if`/`#endif` replacing the blank lines they sit on. The four original sweep
configurations are unmoved: 4/4 goldens match, all screens identical to the cothread build, audio
38.5/38.6/38.7 dB and `no-z80` identical, which are the numbers a baseline run of the shipped build
produces. `md-smoke` 1280x224, and the debug build reproduces its hashes and reports **2 scheduler
switches per frame**. `state-smoke` and `save-smoke` round-trip all seven systems; md's persistable
state is 212,031 bytes with `stateDriftBytes` 2, the cartridge-clock floor §8.7 records. The native
`ares` target compiles. *The desktop-ui asset-catalog step fails on this machine — `ibtoold failed
IDE initialization` — but it fails identically in a build directory this change does not touch, so
it is Xcode tooling and not this.*

### 8.14 Neo Geo, and the residual that was measured into a shape instead of fixed

The AES port needed none of the heavier recipes: no `sinceWaitClock` (native `CPU::wait()`
synchronizes every device on every bus cycle, so there is no throttle to reproduce), no
`busActive()` (the Z80 cannot reach the 68000's bus; there is no DMA and no coprocessor), no
`finishSample` (the YM2610 emits before it steps, so it is always at a safe point). Its two pieces
of genuinely new design are the one-clock-wide LSPC retire hook (`runCycle`/`finishCycle` with a
run-ahead-only `tailPending`, the Master System's line hook shrunk to a clock) and the deferral in
the web `APU::step()`, which pays the ym2610 to the *pre*-step clock because native's post-step
`Thread::synchronize()` iterates the cpu first and suspends there on the crossing step, leaving
that step's ym2610 payment unpaid at any save taken while suspended.

**The 8-byte state residual, and why it stands.** After that deferral, `full` and `no-timer`
matched the cothread reference byte for byte, and `no-nmi`/`fm-only` differed by 8 bytes at some
save points. Decoding the offsets against `ares/ng/system/serialization.cpp` (a temporary
`s.size()` print after each component, then a scan for each thread's u64 frequency) put every byte
in the opnb block: `busyCyclesRemaining` off by 16, opnb's `Thread::_clock` off by exactly
16 × `_scalar` — one ymfm sample — and ymfm sample-phase internals. The cause is a port access
*after* the crossing step inside the crossing instruction: the cothread Z80 executes nothing past
that step until the 68000 resumes it, so a save's synchronize walk completes the instruction with
every payment broken; the web build ran the instruction atomically before the save existed, and
`APU::in`/`out` paid the catch-up. The web build cannot un-pay it, and it cannot defer it either —
in Run mode native *does* pay it, at resume, before the port value is read.

Both guarded repairs were built and measured rather than argued about. Gating the `APU::step`
catch-up on the native suspension condition (`Thread::clock() <= cpu.Thread::clock()`) measured
byte-identical to the unguarded build on an eight-probe matrix — every variant, every save point —
and was reverted as neutral. Gating the port catch-ups the same way moved the one-sample difference
to the opposite sign and un-greened previously matching rows (the ym2610 then reads stale where
native reads fresh), and was reverted as worse. What remains is bounded and characterized: exactly
one sample of ym2610 clock position, either sign, confined to the opnb block plus at worst a
*uniform* normalization shift of every thread clock (`Scheduler::exit` subtracts the minimum, so a
one-time difference in which thread was minimum shifts all clocks equally — verified equal across
cpu/apu/lspc, so relative clocks, the only thing behaviour reads, are identical). `ng-sweep.mjs`
classifies the shape structurally and fails anything outside it; 300 frames × 4 configurations are
audio- and video-identical before and after saves, and Double Dragon's 600-frame diff classifies
its 74 differing bytes as exactly this shape at −1.0000 samples. The honest description is: the
cothread build's save-time behaviour genuinely forks from its own run-time behaviour (the walk
completes the instruction against a stale chip), and a build that has already executed cannot
reproduce both branches of a fork it cannot foresee.

**The stress-ROM lesson worth keeping.** ares's `REG_IRQACK` write sets all three acknowledge
flags from the data bits, so a handler that writes only its own bit disarms the others. The first
cut wrote 1/2/4 and the vblank handler ran once; it was caught because all four variants agreed on
one video hash — a discriminating harness that suddenly stops discriminating is itself a signal.
Every handler now writes `0x0007`.

**The preprocessor-gate laws, since ng is where they were finally pinned down** (clang 21, this
host): a skipped `#if` region of ≤7 total lines emits one blank line per source line; ≥8 lines
emits a single line marker *and swallows all adjacent blank lines on both edges*; consumed
directives in active text emit exactly one blank line each, so wrapping a native function means
replacing the blank lines around it with the directives, never adding lines. Hence every ng
web-only region either sits at end of file (nothing to swallow, namespace reopened inside the
guard) or between two adjacent non-blank lines with ≥10 lines of content — and the
`ARES_NG_COTHREAD` hook sits *inside* `namespace ares::NeoGeo` in `ng.hpp` for exactly this
reason, where the between-the-includes placement failed the gate by two blank lines.

### 8.15 PC Engine, the port that needed no new mechanism

The measurement that framed everything: the plain cothread port ran at **49.97 ms a frame**, and the
`-DARES_PCE_COTHREAD` reference built from the finished sources runs at 50.91 — the two figures agree,
which is what says the baseline was measured honestly rather than against a straw build. The fast
paths are worth **17.2×** on a trivial boot ROM, and on the stress cartridge the finished port holds
**7.8–8.3 ms** (TurboGrafx 16 / PC Engine) and **9.2–9.5 ms** (SuperGrafx) across three independent
runs.

**The speedup is quoted as a range, 20–40×, and the reason is worth recording.** The web side is
stable to within a few percent run to run; the cothread reference is not, spreading 176–392 ms on the
same binary and the same ROM. A build doing twenty times the work is twenty times as exposed to
whatever else the machine is doing. So the load-bearing number here is the web column against the
11.1 ms bar — an absolute, measured repeatedly — and not the ratio, which is a quotient with a noisy
denominator. Quoting a single speedup figure from one run would have been the more impressive and
less true thing to do.

**Where the cost was is not where the profile pointed.** After the first stage (`PCD` and `PSG`
advanced by plain calls) the profile read `CPU::main` 44.6%, `_emscripten_fiber_swap` 2.6%,
`trampoline` 4.7%, `Thread::Enter` 4.5%, `doRewind` 2.3%. Read naively that says the HuC6280
interpreter is slow and the fiber machinery is nearly free. It says the opposite: under Asyncify a
`co_switch` unwinds and rewinds the *whole stack*, and the cost is attributed to every instrumented
frame on it, so an interpreter that is on the stack across every switch absorbs the charge under its
own name. Collapsing the VDP to plain calls then took the frame from 27.09 ms to 2.92 — a 9× that no
switch count predicts. This is the same lesson §8.8 records for gba, and it is now the second time
the port's headline win looked, in profile, like the cost of something else.

**Three chips, and only one of them was hard.** `PCD::main()` and `PSG::main()` are each one whole
unit per call, so their `webAdvance` is `while(Thread::clock() < caller.clock()) main();` and neither
needs a retire hook — they are on a boundary wherever their counters stand. They each need an empty
entry point, which is a different thing and is the first of the two bugs below. `PCD` is the one that
mattered numerically: 153,615 `main()`s a frame on a console with no disc in it, because
`PCD::Present()` is a hardcoded `true` and `ares/pce/cpu/io.cpp:50-51` explains that a HuCard's saves
live in the drive's backup RAM. That is upstream's deliberate choice, it cannot be switched off, and
it is the single largest source of switches in the core.

The VDP holds a position mid-scanline, so it got `runChunk()` — one dot or one line-tail per call,
chosen on `io.hcounter`. Its three invariants are stated in the source because they are what a future
edit breaks silently: `io.hcounter == 0` means "at the top of `main()`" so hsync/vsync fire once a
line; the output pointer is `pixels().data() + 1365 * io.vcounter + io.hcounter` at the top of every
dot and after every `step()`; and the canvas base is re-read **per chunk**, not per line, because
`screen->frame()` swaps `_inputA`/`_inputB` underneath a cached pointer. The retire hook is
`vdp.finishUnit()` inside `CPU::mainWeb`, on the cothread the VDP is actually advanced from, and the
web `VDP::main()` is `return finishUnit();` with native's body verbatim below it — a second
expression, not a rewrite, so the preprocess gate still passes.

**Two bugs the fidelity sweep caught that nothing else would have, and both generalise.**

*A parked cothread's entry point is not dead code.* The scheduler's auxiliary walk resumes a thread
to run **the entry point it last returned from**. A chip advanced by plain calls never suspends
inside its own `main()`, so its cothread sits at an entry-point return — and left pointed at
`main()`, the PSG ran a full sample (64 clocks, 384 CPU cycles) and the PCD a full drive/CDDA/ADPCM
tick on every scheduler visit, on top of what `webAdvance` had already done. Nothing rendered
differently; it is one unit of overshoot per visit, invisible to video and audio, and it moved the
counters a synchronized save records. The fix is an empty `PSG::mainWeb()` / `PCD::mainWeb()`
registered by `Thread::create`. **The general law: when a chip is advanced by plain calls, its
cothread entry point must be empty or retire-only — never the real `main()`.** The VDP had this right
by accident, via its `return finishUnit()` arm; the two "trivial" chips did not, precisely because
they looked too simple to need anything.

*A chunk that ends a unit may need to wait for the caller to cover all of it.* `VDP::main()` closes a
scanline with `step(1365 - io.hcounter)`, then `vclock()`, then `scheduler.exit(Event::Frame)` — and
on the VDP's own cothread that `step()`'s `synchronize(cpu)` carries the CPU to the end of the line
*before* either runs. A plain-call advance cannot carry the caller, so the obvious "run every chunk
you have the clock for" raised the frame event a few clocks early and showed the CPU the
post-`vclock()` `irqLine()`. The park position then differed by a whole scanline, because the
scheduler resumed into a line the cothread build had already begun. `runChunk` is untouched; the gate
is one condition in `webAdvance` — visible dots run as soon as they are covered, the line's tail
waits for `Thread::clock() + (1365 - io.hcounter) * scalar() <= caller.clock()`. **The general law: a
chunk whose `step()` would have dragged the caller forward cannot run until the caller is already
there.** Both bugs were silent in video, audio and battery, and visible only in the state hash — which
is the entire argument for comparing persistable state against a reference build rather than eyeballing
a running game.

**A crash the ABI has to prevent, and it is not a quality setting.** `VDPBase::implementation` is
null until `setAccurate()` runs, and the only caller is
`ares::PCEngine::option("Pixel Accuracy", …)` — which ignores the value it is given and forces the
accurate renderer anyway, with the comment *"Forced: scanline renderer is too buggy"*. So
`wasm/pce.cpp` calls it before `ares::PCEngine::load` or the core null-derefs on the first frame. It
reads like the gba's pixel-accuracy knob and is nothing of the kind; the call site says so.

**Three decisions in `wasm/pce.cpp` worth naming.**

*The Duo and the LaserActive are refused, with a reason.* Both need a CD BIOS and a disc, and this
module has no drive ABI. Failing at load with an explanation beats booting a machine that cannot
reach its own software, and it is the same call Mega CD gets.

*The Multitap is opt-in and off by default.* The console has one physical port, so every two-player
PC Engine game needs the tap — but seating it changes what a game polls, and defaulting it on would
change single-player behaviour for every caller that never asked. `ares_pce_set_multitap` takes
effect on the next load.

*The battery blob carries the console's memory.* `saveRamGather`/`saveRamApply` grew a second pak and
a file list; the three-argument forms the other seven cores call delegate with `nullptr, {}`, so
those cores are unchanged by construction rather than by regression testing. Restoring writes the pak
*and* fills `pcd.bram` directly, because `PCD::load` is the only reader of `backup.ram` and it ran
once, at load. Two upstream details surfaced while doing it: `PCD::load` seeds an empty battery with
a `HUBM` header whose guard is `bram[0] != 'H' && bram[1] != 'U' && ...` — an `&&` that reads as an
intended `||`, so a battery matching any one of those bytes is never re-seeded — and `mia`'s PC
Engine system pak appends `backup.ram` unconditionally, so no PC Engine ever reports zero persistent
bytes. Neither is touched here; both are written up in `UPSTREAM.md`, along with the two the
`option("Pixel Accuracy")` handler carries — it discards the value it is given, which makes
`vdpPerformanceImpl` unreachable dead code, and it is the sole assignment to
`VDPBase::implementation`, which makes a null dereference the default for any frontend that does not
call it. The second of those is a latent crash in a public API and is the single entry in that file
most worth sending.

**What the ABI could not do, and what it took to fix.** Nothing structural inside a `.sgx` image
identifies it as a SuperGrafx cartridge, and the model string is what selects both the mia medium and
the MEMFS extension — so `Auto` with a SuperGrafx ROM seated a SuperGrafx card in a PC Engine and
rendered wrong rather than failing. The conclusion drawn from that, that the ABI could only sniff it
by inventing a heuristic ares does not have, was half right: a heuristic is indeed the wrong answer,
and it is not the only one available. The rest of this entry is how that was worked out, in the order
it happened, because the reasoning that stopped too early is worth keeping next to the reasoning that
did not.

**This one bit in real use, and the first mitigation was not enough.** `wasm/pce-preview.html`
originally moved its own model selector when the chosen file ended in `.sgx`. That is a page-level
fix for a page-level signal, and it is correct as far as it goes — but SuperGrafx dumps circulate
named `.pce` at least as often, and for those the filename carries no signal at all. The observed
failure was a SuperGrafx game loaded on `Auto`: sound and controls worked, the canvas stayed solid
black, and nothing anywhere said why. The game runs because the CPU, PSG and pad are all real; the
screen stays black because the game programs its second VDC through ports a PC Engine decodes as
mirrors of its first, so the display never comes on.

Two changes, neither of them a detection claim. The model selector moved next to the file picker,
because it is read at load time and it is the control that fixes this — burying it among the sound
and overscan checkboxes is what let a black screen look like a broken port. And `drawFrame()` now
ORs the pixels it is already reading, counts consecutive frames in which nothing was drawn, and after
three seconds on `Auto` says so and names the fix. The blank test was checked both ways against the
core: the stress cartridge draws on 199 of 200 frames and never trips it, a machine that boots and
never enables its display trips it on all 200.

That was where this stopped, and stopping there was wrong. The claim was that nothing in the image
identifies a SuperGrafx — but that had only ever been checked against the *filename*, never against
the bytes and never against what other emulators do, which are the two places an answer could live.
Both were then checked, and the second one had it.

**`Auto` now resolves it from a digest table, and not from content analysis, a runtime probe, or
booting every cartridge as a SuperGrafx.** Six codebases were read first: mednafen, mednafen's
`pce_fast`, both beetle-pce libretro forks, Ootake and Geargrafx. Every one of them uses a filename
extension plus a small per-game hash table plus a user override, and **not one inspects what the code
does**. Ootake comes closest and still is not content detection — it compares six bytes at a fixed
offset, gated on an exact ROM size. So the table is the state of the art, not a shortcut past it.

The digests are written here because they were computed here. They come from No-Intro's
`NEC - PC Engine SuperGrafx` datfile, version `20250913-112105`, and two independent checks agree
with it: its CRC32 column matches mednafen's separately authored list on all five titles, and
`shasum -a 256` over the two SuperGrafx cartridges available locally reproduces its SHA256 exactly.
The earlier objection — *a table of remembered hashes is worse than no table* — still stands and is
exactly why they were fetched and verified rather than recalled.

The three rejected alternatives, each for a measured or structural reason:

- **Not content analysis.** Scanning for absolute stores that decode into the VPC's register window
  does not separate the machines: 671 hits in 1941 and 1118 in Aldynes, against 645 in Samurai Ghost,
  a genuine PC Engine HuCard — and 1036 per MiB in Star Fox, which is not 6280 code at all. A tighter
  correlated signature (a store to `$0010` followed within ten bytes by one to `$0011`-`$0013`) does
  separate — 15 and 47 against 0 — but it was tuned on two of the five titles, and it depends on an
  idiom a title driving VDC1 through `ST0`/`ST1`/`ST2` would not exhibit at all, because those
  opcodes are two bytes of opcode plus immediate data and encode no address to find.
- **Not a runtime probe.** Booting as a PC Engine, watching for VPC writes and restarting would clear
  the hard constraints — a `#if defined(PLATFORM_WEB)` block with no `#else` preprocesses away
  entirely, and a field never passed to `s()` adds nothing to a save state. It is rejected for cost,
  not legality: it needs a new accessor across the core/module boundary for a problem the table
  solves with none, the restart is user-visible, and any state saved in the probe window is a PC
  Engine state that cannot restore into the SuperGrafx that replaced it.
- **Not always-SuperGrafx.** The machines genuinely differ. `CPU::load` allocates 8 KiB against
  32 KiB, and `Memory::Writable::read` masks by `bit::round(size)-1`, so banks `$f8`-`$fb` alias one
  page on a PC Engine and are four distinct pages on a SuperGrafx; `$0008`-`$001f` decode as VDC0
  mirrors on one machine and VPC control plus VDC1 on the other. It would also tax the whole PC
  Engine library with the SuperGrafx's second VDC for the sake of five cartridges.

Resolving the model surfaced the second half of the same bug. Setting `superGrafx` builds the medium
and the system pak under that name, but the model string below still fell through to the region
default, so the core came up as a PC Engine while the pak callback answered only to `SuperGrafx` and
`ares::PCEngine::load` failed outright. A detected SuperGrafx now names its own model. There is
exactly one — the machine never left Japan.

Measured on the two cartridges present, both named `.pce`, which is the reported failure exactly: on
`Auto` each now serializes 311321 bytes, the SuperGrafx size, and draws — 180 of 200 frames for 1941
and 85 of 200 for Aldynes, against 0 before. Samurai Ghost stays a PC Engine at 220556 bytes and is
not promoted, and 1941 forced to `[NEC] TurboGrafx 16 (NTSC-U)` still comes up a PC Engine drawing
nothing at all, which is both the original bug reproduced on demand and the proof that an explicit
model still outranks the table.

The blank-screen hint stays, with its job made smaller rather than removed. An exact match cannot
promote a PC Engine cartridge by mistake, so there are no false positives; what it misses is any
SuperGrafx image that is not bit-exact — an alt or bad dump, a hack, a translation, homebrew. That
residual is real: Geargrafx carries eighteen SuperGrafx CRC32s where No-Intro carries five,
Daimakaimura alone accounting for seven.

**The coverage gap this exposed, and the image written to close it.** The sweep had been running a
HuCard image on SuperGrafx silicon, and the VPC powers up with `enableVDC1` clear — so all three
configurations agreed with the reference while **nothing anywhere exercised VDC1 rendering at all**.
That is how a sweep reporting `identical` across the board coexisted with a black screen in real
play. `buildSuperGrafxRom()` now programs VDC1 through `$0010`-`$0017` and the VPC through
`$0008`-`$000e`, setting `settings[3]` to VDC1 alone and a window split so the picture is resolved by
both VDCs to the left of it and by VDC1 alone to the right, with a raster handler walking the split
sideways and a vblank DMA on VDC1. It lives in `wasm/pce-stress-rom.mjs` beside `buildStressRom()`
rather than in a sibling file, because the assembler and the hardware constants are module-private
and a sibling would have meant exporting the assembler purely as plumbing. `buildStressRom()` is
untouched and was checked byte-identical by SHA256 before and after, which is what lets the three
original golden hashes stand unchanged.

That the image genuinely depends on VDC1 was measured rather than asserted: patching the single byte
of its `lda #$c0 / sta $0012` to `#$00` blanks VDC1's renderers and nothing else, and the rightmost
quarter of the screen goes from 94.7% lit to **0.0%**, with the left bands losing about a third of
their pixels where VDC1's background had been showing through VDC0's checkerboard.

Running that same image as a PC Engine also pinned down the mechanism behind the reported failure,
and corrected the expected symptom. A PC Engine decodes `$0012` as `$0012 & 3 == 2`, which is VDC0's
**own** control register — so a SuperGrafx game's VDC1 setup writes land on VDC0's CR. With this
image's `$c0` the display is not blanked but the coincidence and vblank interrupt enables are
cleared, IRQ1 never fires again, and the result is a **frozen wrong picture** rather than a black
one: every pixel differs from the SuperGrafx render and the screen then never changes. Which of the
two presentations a real cartridge gives depends on the value it happens to write — one with bits 7
and 6 clear blanks the display outright, which is the solid black that was reported. So the corpus
reproduces the class of the fault, and deliberately was not engineered toward either outcome.

### 8.16 The cross-load entry-point leak, and the mechanism that turned out not to be there

`Thread::EntryPoints()` was recorded in §6 as this branch's, bounded and benign. Two of those three
words were wrong. This entry is what replaced them, including the part where the attractive
explanation was measured and did not survive.

**The leak, measured.** Six sequential `ares_pce_load` calls alternating a SuperGrafx and a HuCard
image, thirty frames each, through a temporary `EntryPoints().size()` export:

```
after load   entryPoints  rom
        1            3   1941 - Counter Attack (Japan).pce
        2            6   Samurai Ghost (U) [a1].pce
        3            9   1941 - Counter Attack (Japan).pce
        4           12   Samurai Ghost (U) [a1].pce
        5           15   1941 - Counter Attack (Japan).pce
        6           18   Samurai Ghost (U) [a1].pce
```

Exactly +3 per load, never shrinking. Four threads are created per `System::power()` — pcd, cpu,
vdp, psg — and exactly one of them, the cpu, is ever entered, because the other three are advanced
by plain calls and their cothreads are visited only by a synchronized save. The same six loads
against the `-DARES_PCE_COTHREAD` reference report **0 after every load**: there, all four are real
cothreads, all four are entered on the first frame, and every entry is consumed. That single
contrast is the whole ownership argument for this half — the accumulation needs the empty entry
points, which are this branch's.

**The hypothesis, and why it is wrong here.** The obvious mechanism: `co_delete` frees the cothread,
a later `co_create` returns the same address, `Thread::Enter` takes the *first* handle match, and a
new thread is resumed into a dead chip's entry point — which on this platform is often
deliberately empty (`PSG::mainWeb`, `PCD::mainWeb`), so the chip would simply stop working. It is a
good story and the PC Engine cannot tell it. Dumping every pending entry's handle alongside each
live chip's handle, across four loads:

```
load 1  live: pcd@0x2a8520  cpu@0x2c8550  vdp@0x2e8558  psg@0xbf4988
        pending: 0:pcd  1:vdp  2:psg
load 4  live: pcd@0x2a8520  cpu@0x2c8550  vdp@0x2e8558  psg@0xbf4988
        pending: 0:pcd 1:vdp 2:psg 3:pcd 4:vdp 5:psg 6:pcd 7:vdp 8:psg 9:pcd 10:vdp 11:psg
```

Every address is stable across all four loads, because **the PC Engine never calls
`Thread::destroy()`** — its chips are namespace globals, `Thread::create` finds `_handle` non-null
and takes the `co_derive` branch, and the same 128 KiB buffer is reused forever. No address is ever
recycled between two different chips, so every duplicate entry belongs to the same chip as the live
handle and `Enter()`'s first match is always that chip's own. **No thread can be resumed into another
chip's entry point in this core.** The one residue is intra-chip: the vdp's entry point is
`main<true>` or `main<false>` by model, so a HuCard loaded after a SuperGrafx does keep the
SuperGrafx entry at index 1 — and on this platform both instantiations are the single line
`return finishUnit();`, and `finishUnit()` re-reads `Model::SuperGrafx()` at run time
(`ares/pce/vdp/vdp.cpp:151`), so the two are the same function. That is why the fix moves no hash,
and it is also why the leak cannot be the reported black screen.

**It does not explain the user report.** The report was: SuperGrafx game, then a HuCard game in the
same page, second game has sound and input but no picture, cured by a page reload. That could not be
reproduced with either cartridge available here, in either order — video hashes are bit-identical
against a fresh module both ways — and the mechanism above is now ruled out rather than merely
unobserved. The page's own `modelSetByPage` restore was checked too, and it only ever fires on a
`.sgx` file name, so with two `.pce` files it never moves the selector.

So the leak is real, measured and fixed, and **the report is still unexplained**. The one cause on
record with that exact fingerprint — sound and input but no picture — is §8.15's, a SuperGrafx
cartridge running as a PC Engine, and it does not fit either: it is a property of the cartridge and
the model, so reloading the page would not cure it. Saying "fixed the leak, so that's probably it"
would have been the comfortable ending and it is not one the evidence supports. What would settle it
is the two files that produced it.

**The fix, and the invariant it states.** One invariant — *at most one pending entry per live
handle* — in the three places that can break it, each a `#if defined(PLATFORM_WEB)` block holding a
single `std::erase_if` beside the native arm:

- `Thread::create`, after `co_derive` has reset the cothread (or after `co_create` has handed back
  an address a destroyed thread may still be named by);
- `Thread::restart`, the other `co_derive` site;
- `Thread::destroy`, before `co_delete` returns the memory.

Post-fix the count is **3 after every load** instead of 3, 6, 9, … — three because the current
load's three never-entered chips are legitimately pending, and it is the *growth* that was the
defect.

**Where the two halves belong, and the evidence for the split.** The `create`/`restart` half is
ours: it accumulates only because chips are never entered, and the cothread reference measures 0.
The `destroy` half is upstream's, and is not a growing vector but a use-after-free — the freed
handle comes straight back out of the next `co_create`, verified natively on this host:

```
first  co_create -> 0x7c1400000
second co_create -> 0x7c1400000   same address: YES
```

`Thread::Enter` then prefers the dead entry, and the live thread runs a deleted object's `main()`.
`UPSTREAM.md` entry 8 has the native route through `desktop-ui` — boot paused, swap a controller —
and says plainly which part of it was executed and which part was read. The fix here is gated like
the rest of the branch; the ungated version is what should go upstream.

**Verified, on the final text.** `pce-sweep` all four configurations `identical` against a freshly
rebuilt cothread reference with every golden matched; state sizes unmoved at 220556 and 311321;
`sgx-switch` bit-identical in both directions; `sgx-autodetect` unchanged; `pce-smoke`,
`state-smoke` and `save-smoke` unchanged. `md-sweep` was run as well, because `thread.cpp` is shared
and the Mega Drive is the only core that calls `Thread::restart` — all five configurations still
match their goldens. And `ares/pce/pce.cpp` and `ares/md/cpu/cpu.cpp` preprocess **byte-identical**
to `HEAD`'s text with the host compiler, on a gate first proved to fail on a single inserted blank
line. The three guarded regions are nine lines each for the reason §8.14 gives: a skipped region of
seven lines or fewer emits one blank line per source line, and the first drafts of two of these were
five and seven lines — they were grown to clear that threshold, not for the prose.

### 8.17 PlayStation, the port that needed no performance work

Every other core in this file is here because something had to be flattened. This one is not.
Nothing became a `Thread::webAdvance` override, nothing gained a `runCycle()`, no chip is advanced
by plain calls, and there is no retire hook anywhere in the core. All five cothreads — `CPU`, `DMA`,
`GPU`, `MDEC`, `SPU` — are still real cothreads. Real games run at **6.2–9.4 ms a frame**, under the
project's 11.1 ms bar, with no performance work of any kind. Grepping `ares/ps1/` for
`webAdvance`, `mainWeb` and `runCycle` finds nothing at all; grepping it for `PLATFORM_WEB` and
`__EMSCRIPTEN__` finds five lines, all of them in the two hunks named below and two of them comments.

**The reason is upstream's, and it was already in the core.** ares' PlayStation CPU carries its own
scheduling throttles, and the port's whole contribution was to leave them alone:

| | value | `ares/ps1/cpu/` |
|---|---|---|
| `forceSyncInterval` | 1024 | `cpu.hpp:60` |
| `branchCooldownCycles` | 512 | `cpu.hpp:61` |
| `ioCooldownCycles` | 128 | `cpu.hpp:62` |

`CPU::synchronize()` (`cpu.cpp:64-74`) is the only thing in this core that reaches
`Thread::synchronize()`, and three callers gate it. `CPU::step` (`:49-62`) accrues cycles and calls
it once `cyclesUntilForcedSync` runs out — every 1024. `CPU::main()` (`:35-47`) runs
`instruction()` in a loop and breaks only when the pc goes non-sequential **and** at least 512
cycles have accrued, so a whole run of straight-line code plus the branch that ends it is one visit
to the scheduler. `CPU::ioSynchronize()` (`:76-78`) will not synchronize below 128 accrued cycles at
all. The cothread walk therefore cannot happen more often than once per 128 CPU cycles, and on
ordinary code it happens on the 512- and 1024-cycle paths. That is the same batching every other
core here had to be given, shipped upstream, for the desktop's benefit, before this port existed.

**What is not known is how much is left on the table.** No profile of the finished build was taken
and no flattening was attempted, so whether `Thread::webAdvance` overrides on the GPU and SPU would
buy anything here is **an open question, not a closed one**. What is measured is that the bar is
already cleared, which is why nothing was tried.

**Everything the port touched outside `wasm/`,** and it is a short list:

- `ares/ps1/ps1.hpp` — the `ARES_PS1_COTHREAD` reference-build hook, inside `namespace
  ares::PlayStation` between the namespace line and `#include <ares/inline.hpp>`, for the placement
  reason §8.14 states.
- `ares/ps1/accuracy.hpp` — `GPU::Threaded = 0`, keyed on `__EMSCRIPTEN__`. Read on.
- `nall/vfs/cdrom.hpp` — +27/−4, the synchronous disc load below. Native's text is verbatim in the
  `#else`.
- `wasm/ps1.cpp` (548 lines), `wasm/CMakeLists.txt`, and `ps1` added to the Emscripten core list at
  root `CMakeLists.txt:35`.

The module is **2,108,013 bytes** against the cothread reference's 2,102,730. The 5,283-byte gap is
worth understanding, because it is not what it is for the other cores: `ARES_PS1_COTHREAD` switches
off no fast path in `ares/ps1/`, since there are none. What it switches off is the *shared*
scheduler's web arms — `Thread::synchronize`'s `active()` stand-down and `webAdvance` dispatch, the
dead-stack zeroing in `Thread::serialize`, the three `EntryPoints()` erasures, and `Scheduler::enter`'s
`_resume` restore. So the reference build is still a real control here; it is a control over §4's
shared changes rather than over a recipe this core does not have.

**Three things were genuinely hard.** None of them was the emulator.

*`nall::vfs::cdrom` spawns a pthread the web build does not have.* `loadCue` hands the whole decode
to `thread::create`; every consumer of the image busy-spins in `wait()` on `usleep(1)` until
`_loadOffset` passes the sector it wants (`nall/vfs/cdrom.hpp:84`); `~cdrom()` `join()`s. In wasm the
`pthread_create` fails, the callback never runs, `_loadOffset` never leaves 0, and the first
data-sector read hangs forever — not a slow load, a permanent one. The fix runs the identical body
on the calling thread as an immediately-invoked lambda. The opening arm replaces the
`_thread = thread::create(` line with `(`; the closing arm replaces `});` with `})(0);`; and **not
one line of the 71 between them is duplicated**. The part worth writing down is what did *not* need
an arm. `wait()`
needs none because after a synchronous load `_loadOffset == _image.size()`, and `wait()`'s loop is
`while(offset + 1 > _loadOffset)` with `offset` already clamped below the image size — the exact
condition it was already testing is now true on entry. `~cdrom()` needs none because `_thread` stays
default-constructed and `nall::thread::join()` tests its handle first (`nall/thread.hpp:65-70`). The
file's other `thread::create` is inside `loadChd` (`:309`), which `-DARES_ENABLE_CHD=OFF` never
compiles. The guard is `PLATFORM_WEB`, and that is correct even for the reference build: `ps1.hpp`
undefines that macro after `<ares/ares.hpp>` has already pulled `nall/vfs/vfs.hpp` in, so the header
is parsed once, with the web arm taken, in both builds — which is what lets the reference build load
a disc at all.

*The 64 KiB stack, and why it trapped a long way from its cause.* `sizeof(nall::CD::Session)` is
**80,820 bytes** — `Track tracks[100]`, each holding `Index indices[100]` — and `loadCue` keeps two
live at once: one at `nall/vfs/cdrom.hpp:93` and a second inside the `loadSub` it calls, at `:377`.
Roughly 160 KB of automatic storage for a disc load. A native host answers that out of an 8 MB
thread stack and never notices; Emscripten's default stack is 64 KiB. The fix is
`-sSTACK_SIZE=1048576` on the `ares-ps1-wasm` target **only** (`wasm/CMakeLists.txt:93`), leaving the
other eight modules on the default. What made this expensive to find is that a release wasm build
carries no stack-overflow check, so the overflow does not surface at the write that caused it — it
surfaced as an out-of-bounds access somewhere unrelated, well after the fact. **The survey did not
predict this**, and nothing about the symptom pointed at a stack. `UPSTREAM.md` entries 12 and 13
are the upstream half: deleting the debug diagnostic that constructs the second session halves the
requirement for free.

*`GPU::Threaded` had to be keyed on `__EMSCRIPTEN__`, and this is the trap most worth recording.*
The obvious key is `PLATFORM_WEB`, and it is wrong here for a reason peculiar to this file:
`ps1.hpp:19` does `#undef PLATFORM_WEB` and `ps1.hpp:35` includes `<ps1/accuracy.hpp>` — the undef
comes **first**. So under `-DARES_PS1_COTHREAD` a `PLATFORM_WEB` key reverts `Threaded` to 1, the
`nall::thread` the GPU's render thread wants is another `pthread_create`, it fails, primitives pile
into a 65,536-entry FIFO nothing drains, and the reference build renders a blank screen. It does not
crash and it does not report anything — the sweep would simply have been comparing the web build
against nothing, and passing rows would have meant nothing. Measured on the smoke workload: 2
distinct frame hashes against the web build's 87. Upstream's own `ares::Video::Threaded` is keyed on
`__EMSCRIPTEN__` for exactly this class of reason (`ares/ares/ares.hpp:64-68`), which is what the
comment in `accuracy.hpp` points at. **The general law: a flag a reference build must keep needs a
key the reference build cannot undefine.** `ARES_*_COTHREAD` is designed to remove `PLATFORM_WEB`;
anything that must survive it has to be keyed on the toolchain instead.

**Fidelity.** Web against `-DARES_PS1_COTHREAD`, Raiden Project, 600 frames, both instances seeded
from one state blob and one battery blob:

| | |
|---|---|
| distinct frame hashes | 391 |
| video sequence | `194e5a9d` |
| audio, 481,466 frames | `69a0ae83` |
| state, 4,019,632 bytes | `5945c92f` |
| battery, 262,208 bytes | `1a5a408f` |
| cards | `dc2887e3` |

Identical on every column. **The seeding is required, not a convenience**, and for the reason the PC
Engine's is (§8.15): `System::power` calls `random.entropy(Random::Entropy::High)`
(`ares/ps1/system/system.cpp:131`), so no two power cycles produce the same machine and an unseeded
state comparison between two module instances is meaningless whatever it reports.

Boot measurements, five commercial discs, each hashed frame by frame so that "it booted" is a count
rather than an impression:

| disc | ms/frame | distinct frame hashes | reached |
|---|---|---|---|
| Raiden Project | 6.28 | 586 | title and menu |
| Strider Restoration | 6.27 | 311 | Capcom logo → wordmark |
| SimCity 2000 | 6.21 | 345 | intro FMV → "SIM CITY 2000 © 1996 Maxis" |
| Asteroids | 5.92 | 363 | 2-track disc; the CD-DA track parses |
| Vagrant Story | — | — | boots; 716 MiB image |

Those are boot and menu figures. Under sustained in-game load Raiden measures 7.74 / 7.81 / 7.82 ms
across three runs, and 9.33 / 9.34 / 9.37 on a later 600-frame in-game segment — which is the number
the 11.1 ms bar should be read against, and it clears it.

**Memory is the one genuinely open question, and it is a judgement rather than a failure.**
`nall::vfs::cdrom` makes the whole disc RAM-resident, expanded to 2,448 bytes per sector (2,352 plus
96 bytes of subchannel — the stride is visible at `nall/vfs/cdrom.hpp:372`), so the in-memory image
is 2448/2352 = **1.0408×** the BIN. Measured peaks:

| disc | peak |
|---|---|
| no disc | 104.1 MiB |
| Raiden Project | 213.3 MiB |
| Strider Restoration | 232.4 MiB |
| SimCity 2000 | 263.6 MiB |
| Asteroids | 311.3 MiB |
| Vagrant Story | 993.8 MiB |

The fit recorded from those measurements is `1.041 × BIN + 35.2 MB`, whose coefficient is exactly
the sector expansion above — which is what says the model is the mechanism rather than a curve drawn
through points. **One row does not close against it, and is recorded as such rather than smoothed
over:** Vagrant Story's 716 MiB image predicts about 780 MiB, not 993.8. Either that image figure or
the fit's domain wants re-measuring before the formula is quoted anywhere it matters. The four
smaller discs are consistent with it.

What matters more than the fit is that **Vagrant Story boots, in 2.7 s**. So capping the disc, or
streaming it, is a decision about whether a gigabyte in a browser tab is acceptable — not something
a failure has forced. `-sALLOW_MEMORY_GROWTH=1` was already in the shared function and no
`INITIAL_MEMORY` was needed. Wasm memory never shrinks, so every figure above is a peak and none of
them comes back. **This is undecided.**

**And a finding nobody was looking for: 64.1 MiB of the disc-free baseline is a colour lookup
table.** The survey predicted a ~16.3 MiB baseline; it is 104.1. `ares/ps1/gpu/gpu.cpp:27` asks the
screen for `(1 << 24) + (1 << 15)` = **16,809,984** colours, and `Screen::refreshPalette`
(`ares/ares/node/video/screen.cpp:372`) answers with `_palette = std::make_unique<u32[]>(_colors)` —
**67,239,936 bytes, 64.125 MiB**. That is **61.6%** of the module before a disc is seated, and for
the 24-bit half of the table every entry is its own index with the red and blue bytes exchanged and
an opaque alpha — 64 MiB to reorder three bytes. It is the largest single saving available here, it is
entirely independent of the disc question, and it is **untouched** — no attempt was made to shrink
it and no measurement was taken of what shrinking it would cost elsewhere. (The percentage is stated
against the same unit on both sides. An earlier pass reported 65% by dividing the table's size in
decimal MB by the baseline in MiB, which is the mistake this note exists to stop being repeated.)

**Memory cards, and the one design wrinkle worth a paragraph.** Two slots, and `save-ram.hpp`'s
existing `ARSV` container carries them with no change to the format and no change to
`saveRamGather`/`saveRamApply`. Two things forced the arrangement. Both card nodes are named
`"Memory Card"` — the only thing that distinguishes them is the port they hang off, so
`Backend::pak` resolves the slot through `ares::Node::parent(node)` and matches the port's name. And
both cards write a file called `save.card`, because `MemoryCard` reads and writes that name out of
whatever pak it was handed and has no idea which slot it is in; `ARSV` keys its entries by name and
cannot hold two under one. Rather than fork the container to carry a slot index, a third `mia::Pak`
holds a copy of each card under `memory-card-1.card` / `memory-card-2.card`, and the gather and
apply helpers are called against that pak exactly as the other cores call them against a cartridge's.
The cost is 256 KiB of duplicate storage and two `memcpy`s per save; the benefit is that the blob
format, its readers, and every other core that uses them are untouched. The blob is 262,208 bytes,
which is the 12-byte header plus two entries of 4 + 18 + 4 + 131,072.

**The trap in that path costs a restore silently.** `saveRamApply` writes the pak's bytes but does
not set the `"loaded"` attribute, and `MemoryCard`'s constructor drops what it read unless that
attribute is true (`ares/ps1/peripheral/memory-card/memory-card.cpp:8-12`). Without setting it the
restore appears to succeed, the machine comes up with the blank card `format()` just wrote, and
nothing anywhere reports a problem. `batteryToCards()` sets it, which is what `mia::Pak::load` does
when it reads a `.card` off a desktop's disk (`mia/pak/pak.cpp:107`).

**The round trip was proven through the BIOS rather than a game save, and the record has to say
so.** Driving a commercial game to its own save point headlessly was attempted and abandoned:
roughly 110,000 emulated frames across four discs with buttons pressed blind, and no reliable way to
know a menu had been reached. The BIOS is a better instrument anyway, because it is the same on
every disc. Module A's card was formatted by the SCPH-5501 MEMORY CARD menu over frames 1559–1709 —
36 frames in which the card changed, 183 bytes different — and the result validates as a real card:
`MC` header, 15 free directory frames, 20 broken-sector frames. Exported at 262,208 bytes,
`9108b4df`. The module was then torn down and **a brand-new instance** created: it came up blank
(`06a4be2b`), accepted the blob, returned it byte-identical, and on replaying the identical button
script **did not reformat** — 1 frame changed, 3 bytes, which is the BIOS's presence probe and not a
format.

Why that is conclusive rather than suggestive: `ares_ps1_save_ram_save` calls `System::save()`,
which walks the two ports and asks each card to write **the emulated device's** 128 KiB through
`MemoryCard::save()` (`ares/ps1/system/system.cpp:122-126`, `peripheral/port.cpp:29-31`,
`memory-card/memory-card.cpp:23-27`) — not the pak it was seeded from. A restore that reached the pak
and stopped there would have exported `format()`'s image instead, which is exactly the blank
`06a4be2b`. The bytes coming back could only have come off the device.

**Cards are correctly outside the save state, and that was verified in both directions.**
`PeripheralPort::serialize` has an empty body (`ares/ps1/peripheral/port.cpp:60-61`), so a state
taken with a written card and loaded into a machine holding blank ones leaves them blank — which is
what a console's save state says about what is in its slots. The state size is unmoved at 4,019,632
bytes, and a state blob captured before the card code existed still loads.

**Seven defects were found and none was fixed here.** `UPSTREAM.md` entries 11–17 carry them with a
native reproduction each: a `MODE2/2336` cue track dropped from the sheet entirely so a game disc
parses as an audio CD; the unconditional debug print in `loadSub`; the `CD::Session` stack
requirement above; `MemoryCard` dereferencing what `platform->pak()` returned without checking
it — the same shape as entry 3, with `ares/n64/controller/gamepad/gamepad.cpp:66` written
identically; half-rate **stereo** CD-XA audio interleaved a sample at a time instead of a frame at a
time, which mono-ises the stream and plays as static; and a data read that never re-checks its track,
so a drive left reading walks off the end of track 1 into the CD-DA tracks behind it and feeds music
PCM to the ADPCM decoder whenever two bytes of it happen to look like a subheader; and `SIO1_BAUD`
at `1f80105e` going undecoded, so a game that writes it and reads it back divides by the 0 it gets,
traps, and spends the rest of the run inside the BIOS error handler. None of the seven needs this
branch to reproduce — entries 15 and 16 were found in the browser and confirmed against the
`-DARES_PS1_COTHREAD` reference, and entry 17 was found and fixed entirely in a native build with no
Emscripten in the process.

**Entry 17 is also the only one whose fix this branch cannot simply take.** Serializing the new
register changes the save-state layout, and §2's rule is that states stay byte-interchangeable with a
stock desktop build in both directions. The field can be added without serializing it — the game
writes and reads the register back on consecutive instructions — but that is a compromise this branch
would be making for itself, not a patch to send upstream.

### 8.18 The disc change, and the two exports it took

`ares_ps1_disc_open()` and `ares_ps1_disc_close(const u8* data, u32 size)` take the module's public
ABI from 24 `_ares_ps1_*` symbols to 26. They are the first exports that touch the medium after
construction: everything before them reached the tray exactly once, as a cold seat inside
`ares_ps1_load`. Four decisions, so the next reader does not re-derive them:

**Two exports rather than one `disc_change`.** The dwell between the door opening and the door
closing must contain real emulated frames — `Disc::disconnect` queues `ErrorCode_DoorOpen`
(`ares/ps1/disc/disc.cpp:106`) and that response only means anything if the game gets scheduler time
to poll it. A single atomic export would disconnect and reconnect with zero emulated time between
them, and the door-open would be queued and consumed in the same instant. The dwell itself lives in
the caller, not in the core, because desktop-ui proves it is a per-machine UI decision: the
PlayStation and Mega CD changers wait 3000 ms before reconnecting
(`desktop-ui/emulator/playstation.cpp:151-158`) while the LaserActive deliberately does not
(`pc-engine-ld.cpp:129`), and a module that owns no timer should not grow one to hard-code a policy
its own reference implementation treats as variable.

**No Asyncify arm, and the exports return real `int`s.** `Disc::connect` (`disc.cpp:52-77`) and
`Disc::disconnect` (`:78-107`) call no `step()` and no `Thread::synchronize` — neither enters the
scheduler, so no fiber switch is crossed and the return value survives, the same reasoning
`ares_ps1_state_load` records. The medium build is `mia::*`, which `-sASYNCIFY_REMOVE=mia::*`
already excludes from instrumentation on the stated grounds that mia never runs while a frame is in
flight (`wasm/CMakeLists.txt`) — a condition these exports satisfy, being called from JS between
frames. **This is a dependency on upstream, not a law of nature**: an upstream merge that gives
either function a scheduler call makes both exports need the `state_save` treatment — a `void`
return and a size/data split. Check `disc.cpp` after every merge that touches it.

**No new link option.** `disc_close` runs the same `loadCue` as a cold load and inherits the
ps1-only `-sSTACK_SIZE=1048576` that §8.17's two-`CD::Session` stack requirement forced. Nothing
about being called on a warm machine changes the automatic-storage math.

**Error path is `stateFail`'s, never `fail`'s.** `fail` calls `backend.unload()`, which would turn
a refused disc into a dead machine mid-game. Both exports set the error string and leave the machine
alive; on a failed `disc_close` the tray is left open and the module holds no medium —
`Disc::connect` already self-heals a bad pak by calling `disconnect()` (`disc.cpp:63`), so this is a
state the core is built to sit in, and the caller decides whether to retry with the outgoing disc.

**CHD stays `OFF`, and the decompressor went to JavaScript.** The disc-change work is what put the
question back on the table, so the answer is recorded here: `loadChd` spawns a thread
(`nall/vfs/cdrom.hpp:309`) the web build has no counterpart for, and enabling `ARES_ENABLE_CHD`
would link lzma, miniz and zstd into every module — paid on every download by cartridge-only
players. The consumer decodes `.chd` lazily on its own side and hands this module ordinary cue
sheets and track files, which is why nothing here can tell a compressed image ever existed.

`wasm/ps1-disc-smoke.mjs` is the liveness check: boot one disc, open the tray, run the dwell with
the door open, close it on a different disc, and prove the machine both survived and noticed —
plus the refusal path, which must leave a machine that still runs frames and still saves state.
Like the sweep, it needs a real BIOS and real discs and skips with a message when it has none.

### Smaller items

Four have answers that are verifiable technical facts, simply never written down:
`Path::program()` returns `/` because Emscripten has no executable path and MEMFS's root is the only
meaningful answer; `thread::setName()` is a no-op because `pthread_setname_np` is unavailable in a
non-pthread build; `Video::Threaded = false` because the web build has no worker threads; and
`.gitignore` needs `wasm/` listed because the file is deny-all plus an allowlist.

---

## 9. How to check any of this without trusting it

Nothing above rests on assertion. Each claim has a command behind it.

- **Native behaviour unchanged.** Build `ares/ms/ms.cpp`, `ares/fc/cpu/cpu.cpp`, `libco/libco.c`,
  `ares/sfc/smp/smp.cpp`, `ares/sfc/dsp/dsp.cpp`, `ares/md/cpu/cpu.cpp`, `ares/md/vdp/vdp.cpp`,
  `ares/md/opn2/opn2.cpp`, `ares/md/apu/apu.cpp` and `ares/md/controller/controller.cpp` at `-O2 -S`
  before and after, and diff. Note `-march=native` is in the native flags, so a comparison is valid
  for one host.
- **Web matches the cothread design it replaces.** `ARES_MS_COTHREAD`, `ARES_MD_COTHREAD`,
  `ARES_GB_COTHREAD`, `ARES_GBA_COTHREAD`, `ARES_NG_COTHREAD`, `ARES_PCE_COTHREAD` and
  `ARES_PS1_COTHREAD` build the same source with the flat steppers switched off. `wasm/ms-sweep.mjs`,
  `wasm/md-sweep.mjs`, `wasm/gb-sweep.mjs`, `wasm/gba-sweep.mjs`, `wasm/ng-sweep.mjs`,
  `wasm/pce-sweep.mjs` and `wasm/ps1-sweep.mjs` compare whole concatenated sample streams and every
  frame against that reference, not per-frame hashes. `ps1` is the one where the reference switches
  off no core fast path — there are none — and controls the shared scheduler arms instead; §8.17.
- **The PlayStation's numbers.** Both trees are built with `-DARES_CORES=ps1 -DARES_ENABLE_CHD=OFF`,
  the reference adding `-DCMAKE_CXX_FLAGS=-DARES_PS1_COTHREAD`. Then, with a BIOS and a disc of your
  own:

  ```sh
  node wasm/ps1-smoke.mjs build_wasm_ps1/wasm/ares-ps1.mjs
  node wasm/ps1-sweep.mjs build_wasm_ps1/wasm/ares-ps1.mjs build_wasm_ps1_co/wasm/ares-ps1.mjs
  node wasm/state-smoke.mjs build_wasm_ps1/wasm ps1
  node wasm/save-smoke.mjs build_wasm_ps1/wasm ps1
  ```

  `ps1-stress-rom.mjs` synthesizes its own stub BIOS, so `ps1-smoke` needs no file from Sony; the
  sweep's fidelity and memory figures need a real BIOS and a real disc, which is why they are quoted
  in §8.17 rather than reproducible from this repository alone. Both sides of the sweep must be
  seeded from one state blob and one battery blob or the state comparison means nothing —
  `random.entropy(Random::Entropy::High)` guarantees two instances differ.
- **A core changed nothing native can see.** Preprocess its translation units with and without the
  branch and compare, as §8.8 does for gba: `git stash push -- ares/`, run each entry of
  `build_native_gba/compile_commands.json` with `-E` instead of `-c`, strip `#` line markers, hash.
- **Save states interchange with desktop.** `wasm/state-smoke.mjs` round-trips every core and
  reports `stateDriftBytes`; persistable states are byte-identical to native's for the same
  workload and load in either direction.
- **The tests can actually fail.** Each fidelity claim was checked by mutation — breaking the fix
  and confirming the measurement moves. The mutations are named in the commit messages.
- **The build-system claims in §8.** Same method, one hunk at a time: `git checkout b80f67d38 --
  <file>` to restore upstream, reconfigure, observe, then `git restore --source=HEAD --staged
  --worktree -- <file>`. Note that plain `git checkout <rev> -- <path>` also stages, so restoring
  needs `git restore`, not a second `git checkout --`.
  §8.2 needs only a native configure with `-DARES_TREAT_NALL_AS_SYSTEM=OFF`; it reproduces on
  upstream with no Emscripten involved. §8.3 and §8.4 need an Emscripten configure plus
  `cmake --build <dir> --target ares-resource mia-resource`, with the generated `resource.cpp`
  deleted first — an existing one hides the failure. §8.5 needs an Emscripten configure and a grep
  for `-pthread` in the generated build files.

The goldens in the sweep scripts are literals recorded from a known-good build, not a same-build
reference, on purpose: a self-referential comparison is blind to a regression in the code under
test.
