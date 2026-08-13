# Upstream defects found while porting

Defects in ares that are **not** this branch's, found while porting eight cores to WebAssembly, and
**not fixed here**. Each is independent of the web build: none needs the port to reproduce, and none
should ride upstream on a WebAssembly pull request. This file exists so they can be re-investigated
one at a time and sent back separately.

**Ground rules for anything taken from this list.**

- Reproduce it natively first. Every entry below states how. A defect that only shows under
  Emscripten belongs in `DECISIONS.md`, not here.
- One defect, one pull request. Several of these are in files the port never touches, which is the
  point — a reviewer should not have to accept a WebAssembly branch to take a two-line fix.
- Do not carry the port's rationale across. The argument for fixing `PCD::load` is that the code
  disagrees with its own comment, not that a browser needed it.
- Confidence is stated per entry. `verified` means the source was read and the claim checked on
  2026-08-12. `recorded` means it was established earlier in the project and is carried forward from
  `DECISIONS.md` without being re-checked today.

---

## PC Engine

### 1. `PCD::load` battery seed: `&&` where the comment says `||`

`ares/pce/pcd/pcd.cpp:65-67` — **verified**

```cpp
// Only do this if the HUBM string is not present, to prevent overwriting
// existing bram
if (bram[0] != 'H' && bram[1] != 'U' && bram[2] != 'B' && bram[3] != 'M') {
```

The comment states the intent exactly: seed only when the `HUBM` signature is **not present**.
"Not present" is *any* of the four bytes differing. The code requires *all four* to differ.

So a BRAM image whose first four bytes are, say, `H` `x` `x` `x` does not carry the signature, yet is
never re-seeded — the guard sees `bram[0] == 'H'` and stops. The console is then handed a battery
with no valid header, which is the state the seed exists to prevent.

The common paths are unaffected, which is why it has survived: a fresh `0xff`-filled or zero-filled
BRAM differs in all four bytes and seeds correctly. It needs a partial match to bite.

Fix is `||`, or more plainly a four-byte compare. Two characters either way.

### 2. `option("Pixel Accuracy")` ignores its argument, and the performance renderer is unreachable

`ares/pce/system/system.cpp:25` — **verified**

```cpp
if(name == "Pixel Accuracy") vdp.setAccurate(true); // Forced: scanline renderer is too buggy
```

Every other core that takes this option honours it — `ares/sfc/system/system.cpp:20` is
`ppu.setAccurate(value.boolean())`. The PC Engine discards `value` and forces `true`.

`VDPBase::setAccurate` is the only thing in the tree that selects between `vdpImpl` and
`vdpPerformanceImpl` (`ares/pce/vdp/vdp.cpp:21-33`), and grepping the whole tree finds exactly one
caller: the line above. **`vdpPerformanceImpl` is therefore dead code** — a complete second VDP
implementation, compiled into every build, that no public API can reach.

The comment gives a real reason, so the forcing is probably deliberate. The defect is that it is
undocumented at the API boundary and leaves an unreachable implementation shipping. Either is a fine
outcome; both are better than the present state:

- keep forcing, delete `vdpPerformanceImpl`, and say so in the option handler; or
- fix the scanline renderer and honour the argument.

Worth asking upstream which they intend before writing either patch.

### 3. `VDPBase::implementation` is null until an option is set, and the core dereferences it

`ares/pce/vdp/vdp.hpp:23` — **verified**

`implementation` is initialised to `nullptr` and is assigned only inside `setAccurate`, whose only
caller is the option handler in entry 2. A frontend that loads a PC Engine without first calling
`option("Pixel Accuracy", …)` gets a null dereference on the first frame.

`desktop-ui` is safe by accident of ordering — every one of its six PC Engine variants calls the
option in `load()` (`desktop-ui/emulator/pc-engine.cpp:101` and siblings). Nothing in the core
requires that, and nothing documents it. Any other frontend crashes, which is how this was found:
`wasm/pce.cpp:272-276` carries a comment and a call placed specifically to avoid it.

Fix is a default: initialise `implementation` to the accurate implementation at construction, so the
option changes a working default rather than creating one. This is the entry most worth sending —
it is a latent crash in a public API, it costs one line, and it does not depend on how upstream
answers entry 2.

### 4. `mia` gives every PC Engine a battery — probably intended, worth confirming

`mia/system/pc-engine.cpp:10` — **verified**

```cpp
pak->append("backup.ram", 2_KiB);
```

Unconditional, so no PC Engine ever reports zero persistent bytes, whatever the cartridge is.

This is very likely deliberate and correct: `PCD::Present()` is a hardcoded `true`
(`ares/pce/pcd/pcd.hpp:28`) and `ares/pce/cpu/io.cpp:50-51` explains that the drive is always
reported *so that* HuCard games can save into its backup RAM. An always-present drive has an
always-present battery.

Listed only so the next person to notice it does not file it as a bug. **Ask, do not patch.**

---

## Shared core

### 5. A Mega Drive loses one YM2612 sample on every Z80 reset

**recorded** — `DECISIONS.md` §6

`Thread::restart` calls `co_derive`, discarding whatever the cothread held, including the sample
`OPN2::main()` had just clocked. Native, no Emscripten involved.

The web build reproduces this deliberately, because bit-equality with the cothread build is what the
sweeps measure. That makes it awkward to fix here and easy to fix upstream: it is a native defect
with a native reproduction, and the port has no opinion about the fix beyond wanting to match it.

### 6. `Scheduler::_resume` is left pointing at the last auxiliary thread

**recorded** — `DECISIONS.md` §6, §7 item 4

Reset only in `power()`, so it dangles after a synchronization pass. Native never notices, because
every chip has a cothread to be resumed on; the port noticed because its chips do not.

The fix in this branch is `PLATFORM_WEB`-only and **native keeps the latent behaviour** — a
deliberate narrowing that the original commit message does not admit to. If this is sent upstream,
send the unnarrowed version.

### 7. `OPLL::unload()` never calls `Thread::destroy()`

**recorded** — `DECISIONS.md` §6

It clears the node and leaves the handle outliving the device. The web build works around it by
testing `opll.node` instead of `opll.handle()`; native is untouched. Small, self-contained, and the
easiest of the shared-core entries to write a patch for.

---

## Build system

### 8. `nall-headers` is an INTERFACE target with a `PUBLIC` include directory

`nall/nall/CMakeLists.txt:67` — **recorded**, `DECISIONS.md` §8.2

```
cmake -S . -B out -DARES_TREAT_NALL_AS_SYSTEM=OFF
CMake Error at nall/nall/CMakeLists.txt:67 (target_include_directories):
  target_include_directories may only set INTERFACE properties on INTERFACE targets
```

Upstream master, native, no Emscripten. The line sits in the `else()` branch of an option that
defaults `ON`, so at the default it is never evaluated and nobody has hit it. Reproduce by flipping
the option, exactly as above.

This branch no longer relies on it — the force that made it reachable was removed once measurement
showed it bought nothing — so the fix is free of the port entirely.

### 9. `sourcery` is a directory-scoped imported target, breaking cross-compilation

`CMakeLists.txt:69`, `ares/CMakeLists.txt:18`, `mia/CMakeLists.txt:4` — **recorded**,
`DECISIONS.md` §8.4

```
[100%] Generating .../ares/resource/resource.cpp
/bin/sh: sourcery: command not found
```

Under cross-compilation `sourcery` comes from `find_package` as an *imported* target, and imported
targets are directory-scoped: invisible in sibling directories, still less in ones processed
earlier. CMake then emits it as a literal program name to be found on `PATH`. `IMPORTED_GLOBAL`
makes it visible, after which upstream's own rule text resolves correctly.

Pre-existing, and the web build is simply the first thing to exercise it — any cross-compilation
would. Worth stating plainly in the pull request: the hunk touches a native path, but the path was
already broken.

---

## Not upstream's — do not send these

`Thread::EntryPoints()` grows without bound in the web build. An entry is pushed by every
`Thread::create` and erased only when that cothread is first entered; under the web build some
cothreads are entered only during a synchronized save, so a Game Boy toggling its LCD leaks one
entry per toggle. **This branch introduced it**, it is bounded and benign in practice, and it is
recorded in `DECISIONS.md` §6 as ours. It is listed here only so it is not mistaken for an upstream
defect on a later reading of that section.
