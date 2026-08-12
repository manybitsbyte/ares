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
| Behind a web guard | 23 | the native preprocessor, or a `NOT OS_EMSCRIPTEN` branch, never lets it through. Counts entries in §4, not hunks; gb's whole port is the 21st, gba's the 22nd, and `Thread::webAdvance` the 23rd |
| Shared, compiled, never used natively | 3 | native emits nothing, but you own the source |
| Affects the native build | 13 | 1 build system, 3 portability casts, 9 source refactors |

**gba added no native-affecting change at all, and that is measured rather than asserted:** all nine
native translation units of `ares/gba/`, plus `ares/ares/ares.cpp` which carries the shared scheduler
hook, **preprocess to byte-identical text** with and without this port. §8.8 gives the command.

**Every one of the 9 native source refactors is semantics-preserving.** None changes emulated
behaviour. §2c gives the evidence for each, and §9 says how to re-check it yourself.

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

## 4. What is behind a web guard (23)

Summarized, since native never sees it: the Emscripten CMake platform detection and its three
module files; the libco Emscripten fiber backend and its 128 KiB stacks; `PLATFORM_WEB` /
`ARCHITECTURE_WASM32` detection in nall; the SH2 recompiler wrapped in `#if defined(SLJIT)` with a
stub for wasm; `Path::program()`, `thread::setName()` and `Video::Threaded` web branches; the
scheduler's `active()` stand-down, `webAdvance` hook, `_resume` restore and dead-stack zeroing; and
the seven cores' synchronous catch-up recipes with their flat `runCycle()` twins.

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

Two of these are worth knowing about even though they are guarded, because they touch shared files:

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

Three genuine defects in shared or native code were found and **not** fixed:

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

A fourth, introduced by this branch rather than found in it, and left unfixed: **`Thread::EntryPoints()`
grows without bound in the web build.** An entry is pushed by every `Thread::create` and erased only
when that cothread is first entered. Natively the gb PPU's cothread is entered continuously, so the
LCDC display-enable toggle's re-derivation (`ares/gb/ppu/io.cpp`) consumes its entry immediately.
Under the web build that cothread is entered only during a synchronized save, so a game toggling the
LCD leaks one entry per toggle. Bounded in practice and benign — the vector is walked only on thread
entry — and `md` already ships the same shape. Recorded rather than fixed because the fix belongs in
`Thread::create`, which is shared native code this branch is not otherwise touching.

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
  `ARES_GB_COTHREAD`, `ARES_GBA_COTHREAD` and `ARES_NG_COTHREAD` build the same source with the
  flat steppers switched off. `wasm/ms-sweep.mjs`, `wasm/md-sweep.mjs`, `wasm/gb-sweep.mjs`,
  `wasm/gba-sweep.mjs` and `wasm/ng-sweep.mjs` compare whole concatenated sample streams and every
  frame against that reference, not per-frame hashes.
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
