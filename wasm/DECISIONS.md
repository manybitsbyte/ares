# Decision log — what the WebAssembly port changes outside `wasm/`

The web target itself lives in `wasm/` and is nobody else's problem. This file is about the other
87 files: what the port had to change in shared code and in the cores, why each change is where it
is, and what was deliberately not done.

It exists because "the tests pass" is not a reason to accept a change into code you maintain. Every
entry below tries to answer one question: **why is this line here, rather than somewhere else?**
Where there is no good answer on record, the entry says so instead of inventing one — see §8.

Base for every count and claim here: `b80f67d38` → `1f7001a78`, 25 commits, 87 files outside
`wasm/`, +1671/−125.

| | count | what it means |
|---|---|---|
| Behind a web guard | 20 | the native preprocessor never sees it |
| Shared, compiled, never used natively | 3 | native emits nothing, but you own the source |
| Affects the native build | 16 | 4 build system, 3 portability casts, 9 source refactors |

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

Hence the shape repeated in four cores: the **driving** cothread finishes the unit of work on the
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

### 2a. Build system (4)

At default settings a native configure produces exactly the upstream target set. What follows is
still native-visible.

| id | change | native effect |
|---|---|---|
| B2 | `option(ARES_BUILD_DESKTOP … ON)` gates `ruby`/`hiro`/`desktop-ui`; `OS_EMSCRIPTEN` block adds `wasm/` | none at defaults; adds a new, untested `-DARES_BUILD_DESKTOP=OFF` configuration |
| B5 | `nall-headers` include dirs `PUBLIC` → `INTERFACE` | `nall-headers` is an INTERFACE library with no sources, so the dropped `PRIVATE` half applies to nothing; evaluated by every configure with `ARES_TREAT_NALL_AS_SYSTEM=OFF` |
| B7 | `COMMAND sourcery` → `COMMAND $<TARGET_FILE:sourcery>`, plus explicit `DEPENDS` | every native build generating `resource.cpp` now invokes sourcery by absolute path; CMake already added that dependency implicitly, so the rules should be equivalent — the rule text differs |
| B8 | `sourcery_DIR` defaulted only when unset; imported target promoted `IMPORTED_GLOBAL` | inside the cross-compiling branch, so ordinary native builds skip it — but **every existing native cross-build takes it** |

**All four are rationale gaps.** The commit that introduced them explains libco, nall detection,
the SLJIT stub and the 32-bit fixes, and says nothing about the build restructure. B8 is the one to
scrutinize hardest: it is the only change on the branch that alters a path native users already
exercise without any web involvement. See §8.

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
  template that synchronizes every thread except the named ones. All three call sites — `fc`, `ms`,
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

## 4. What is behind a web guard (20)

Summarized, since native never sees it: the Emscripten CMake platform detection and its three
module files; the libco Emscripten fiber backend and its 128 KiB stacks; `PLATFORM_WEB` /
`ARCHITECTURE_WASM32` detection in nall; the SH2 recompiler wrapped in `#if defined(SLJIT)` with a
stub for wasm; `Path::program()`, `thread::setName()` and `Video::Threaded` web branches; the
scheduler's `active()` stand-down, `_resume` restore and dead-stack zeroing; and the four cores'
synchronous catch-up recipes with their flat `runCycle()` twins.

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

## 8. Open rationale gaps

Places where the code is verified but the *reason* is not on record. Filling these is a
prerequisite for asking anyone to review the branch.

| # | item | what still needs stating |
|---|---|---|
| 1 | B2 `ARES_BUILD_DESKTOP` | why a shared, default-ON option rather than `if(OS_EMSCRIPTEN)` around the same three `add_subdirectory` calls; whether `-DARES_BUILD_DESKTOP=OFF` is a supported native configuration or an artefact |
| 2 | B5 `PUBLIC`→`INTERFACE` | what failed with `PUBLIC`, on which CMake version, and why it could not sit inside the `OS_EMSCRIPTEN` guard two lines above |
| 3 | B7 sourcery `$<TARGET_FILE>` | why `COMMAND sourcery` was insufficient — imported-target resolution under cross-compilation is the likely answer, but that is inference |
| 4 | B8 `IMPORTED_GLOBAL` | why it is needed and what breaks without it. **This hunk affects every existing native cross-build** and has the least justification of anything on the branch |
| 5 | B4 Threads skip | one line on why `find_package(Threads)` must be skipped rather than found and ignored |

Four smaller ones have answers that are verifiable technical facts, simply never written down:
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
- **Web matches the cothread design it replaces.** `ARES_MS_COTHREAD` and `ARES_MD_COTHREAD` build
  the same source with the flat steppers switched off. `wasm/ms-sweep.mjs` and `wasm/md-sweep.mjs`
  compare whole concatenated sample streams and every frame against that reference, not per-frame
  hashes.
- **Save states interchange with desktop.** `wasm/state-smoke.mjs` round-trips every core and
  reports `stateDriftBytes`; persistable states are byte-identical to native's for the same
  workload and load in either direction.
- **The tests can actually fail.** Each fidelity claim was checked by mutation — breaking the fix
  and confirming the measurement moves. The mutations are named in the commit messages.

The goldens in the sweep scripts are literals recorded from a known-good build, not a same-build
reference, on purpose: a self-referential comparison is blind to a regression in the code under
test.
