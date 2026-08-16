# Upstream defects found while porting

Defects in ares that are **not** this branch's, found while porting nine cores to WebAssembly, and
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
- Confidence is stated per entry. `verified` means the source was read and the claim checked —
  entries 1-10 on 2026-08-12, entries 11-18 on 2026-08-13, and 18, 19, 20, 21 and 22 on 2026-08-14.
  `recorded` means it was established earlier in the project and is carried forward from notes —
  `DECISIONS.md`, or an investigation's own scratch record — without being re-checked today. Entry 19
  is mixed and says so: mechanism verified, measurements recorded.

**Where the newest entries stand, for working the queue.** Confidence and *readiness to send* are not
the same thing: every entry below is source-verified except **20**, which is a measured effect with no
mechanism and says so in its first line. The first rule above asks for a native reproduction, and
three of the compact-disc and PlayStation entries still owe one — 15 and 16 have never been reproduced
natively, and 19's reproduction survives only as notes.

| | ready to send | fix written? | what is owed first |
|---|---|---|---|
| **24** CD-XA queue 8 sectors deep | **yes — native, both arms one tree, nine controls bit-identical on audio hash and save state** | **applied here**, §2d D6 | nothing — a listener on `Syphon Filter` would confirm what the counts already show |
| **25** `ENDX` not cleared on key-on | yes — psx-spx and DuckStation both clear it | one line in `keyOn()` | find a title that polls ENDX, so the fix has a symptom |
| **26** loop-end skips the repeat address | yes, and it belongs with 25 | one line | nothing observable found; send it with 25 or not at all |
| **23** MDEC macroblock 2.23x too slow | **yes — native, image-gated, and it is what closes Open A** | **applied here**, §2d D5 | nothing — but a second reference for 2,688 clks/macroblock would strengthen it, since psx-spx has no number |
| **22** `waitDMA` unbounded | **yes — the fix is applied and measured on five discs** | **applied here**, §2d D4 | boot a title from the DuckStation list, `Tekken 2` first, on stock ares |
| **21** `Syphon Filter` OT self-link | **yes — native, and on ares' shipped desktop installer** | **fixed by 22**; no separate hunk | nothing to send on its own — it is 22's evidence |
| **17** `SIO1_BAUD` undecoded | **yes — reproduced on ares' shipped desktop installer** | **applied here**, §2d D2 | capture the release version; **re-add the `serialization.cpp` line** |
| **18** sector destroyed, INT1 deferred | **yes — native, five discs; it is what hangs `Crash Bandicoot`** | **applied here**, §2d D3 | **re-add the `serialization.cpp` line** |
| **14** `MemoryCard` pak deref | yes — native repro program, segfault, exit 139 | one-line guard, 42 sites already use it | — |
| **11** `MODE2/2336` track dropped | yes — cue parses two ways, both shown | yes, two lists must change together | — |
| **12** `loadSub` debug print | yes — unconditional in release, reading it is the proof | yes, delete four lines | — |
| **13** `CD::Session` on the stack | yes, and it belongs with 12 | follows from 12 | — |
| **27** reverb cannot raise IRQ9 | not yet — DuckStation does not implement it either | no | decide whether ares should lead the reference here |
| **15** CD-XA half-rate stereo | not yet | **applied here**, §2d D1 | boot `Asteroids (USA)` on a desktop build, ~40 s, listen |
| **16** unbounded data read | not yet | half of one — see the entry | establish what hardware does past the end of a data track |
| **19** CD DMA trigger ungated | not yet — the numbers are recalled from notes, not re-run | yes, a one-line gate on channel 3 | re-run the count; establish what hardware does when a DMA is armed early |
| **20** a run changes across binaries | not yet — **no cause found**, so there is nothing to send | no | find what reads it; start from `Raiden`, one frame in 17,452 |

Entry 17 is the strongest item in the file: a commercial disc that will not boot, one undecoded
register, a two-instruction trace that shows the whole failure, a control disc that is unaffected,
and a 126-disc sweep showing exactly one title reaches the register at all. Send that one first.

**Six of these are already applied in this working tree** — 15, 17, 18, 22, 23 and 24, the only changes on
the branch that alter emulated behaviour. `DECISIONS.md` §2d states them with before/after
measurements. They are unguarded and upstream-shaped, so sending them is a matter of lifting the
hunks out, not of extracting them from port machinery. **Entries 17 and 18 each need one
`serialization.cpp` line this tree omits**; both entries say which and why. **Entry 22 needs
nothing** — it adds no state, so the hunk here is the hunk to send.

**Six discs still fail the boot sweep with no diagnosis at all.** They are recorded under *Open* near
the end of this file rather than as entries, because a symptom is not a defect report.
`Crash Bandicoot`, which used to sit with them, is now entry 18.

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

### 8. `Thread::destroy()` frees a cothread and leaves its entry point pending

`ares/ares/scheduler/thread.cpp`, `Thread::destroy` — **verified**

*Full write-up, with the fix and the open questions to resolve before sending it:*
`UPSTREAM-thread-destroy-uaf.md`.

Upstream's text, which is also what this branch compiles natively:

```cpp
inline auto Thread::destroy() -> void {
  scheduler.remove(*this);
  if(_handle) co_delete(_handle);
  _handle = nullptr;
}
```

`Thread::create` and `Thread::restart` push `{_handle, entryPoint}` onto the function-local static
`Thread::EntryPoints()`. The only removal is in `Thread::Enter()`, which erases an entry when that
cothread is **first entered**. So a thread destroyed before its first entry leaves an entry behind,
naming an address `co_delete` has just handed back to `malloc`.

The next `co_create` of the same size gets that address. Every cothread in the tree is
`Thread::Size`, so this is the ordinary case, not the unlucky one — reproduced natively on this host
(macOS arm64, so `libco/aarch64.c`), at the 131072 bytes a 64-bit `Thread::Size` asks for:

```
first  co_create -> 0x7c1400000
second co_create -> 0x7c1400000   same address: YES
```

`Thread::Enter()` then scans from index 0 and takes the **first** handle match — which is the dead
entry, because it was pushed earlier. The new thread runs the destroyed thread's entry point, whose
bound `this` points at an object that no longer exists.

**Native reproduction.** Any path that destroys a thread before its first entry and then creates
another. Shortest one in `desktop-ui`, all native: set `settings.boot.debugger` or
`settings.boot.awaitGDBClient`, which make `Program::load` boot **paused**
(`desktop-ui/program/load.cpp:124-131`), so the run loop never runs a frame
(`desktop-ui/program/program.cpp:88`) and no cothread is ever entered. Load a Mega Drive game with a
Fighting Pad seated — its constructor calls `Thread::create`
(`ares/md/controller/fighting-pad/fighting-pad.cpp:17`). Still paused, pick a different device from
System → Controller Port 1; the handler is `port->disconnect(); port->allocate(name);
port->connect();` (`desktop-ui/presentation/presentation.cpp:943-945`), which is the pad's
`Thread::destroy()` (`fighting-pad.cpp:21`) immediately followed by the new device's `co_create` of
the same size. Unpause: the new device's first entry runs `FightingPad::main` on the deleted pad.
`settings.input.defocus == "Pause"` opens the same window without the debugger settings.

*Stated exactly: the address recycling above was executed natively and its output is real. The
desktop-ui route was established by reading those four files, not by driving the GUI.*

Fix is one statement — erase the entries naming `_handle` before `co_delete`, since the entry belongs
to the handle and `destroy()` is the one place that knows the handle is going away. This branch
carries exactly that, under `PLATFORM_WEB`, to honour its own no-native-change rule; **the version to
send upstream is the ungated one**, as with entry 6.

---

## Build system

### 9. `nall-headers` is an INTERFACE target with a `PUBLIC` include directory

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

### 10. `sourcery` is a directory-scoped imported target, breaking cross-compilation

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

## Compact disc — `nall`, `mia`

Found while giving the PlayStation core a disc. All three are in code every CD system shares, and
none of them needs a PlayStation to reproduce.

### 11. A `MODE2/2336` track is dropped from the cue sheet entirely, and the disc becomes an audio CD

`nall/nall/decode/cue.hpp:302-308` — **verified**

```cpp
inline auto CUE::Track::sectorSize() const -> u32 {
  if(type == "mode1/2048") return 2048;
  if(type == "mode1/2352") return 2352;
  if(type == "mode2/2352") return 2352;
  if(type == "audio"     ) return 2352;
  return 0;
}
```

`mode2/2336` is a normal thing to find in a cue sheet and is not in the list, so it takes the
`return 0`. The zero then propagates twice: `lastSectorInFile` (`:237-241`) returns `-1` when
`bytesPerSector` is zero, and `CUE::load` reads

```cpp
auto trackEnd = nextTrack >= 0 ? nextTrack - 1 : lastSectorInFile(track);
if(trackEnd < 0) continue;                                    // :274-275
```

so the **whole track is skipped**. The failure is not a mis-sized track that reads slightly wrong
data; the track is not there at all.

**Native reproduction**, no emulator involved — describe one image two ways and print the parse:

```
MODE2/2352 →  index01: 00:02:00 - 00:05:74      image 14,700 sectors
MODE2/2336 →  index01: 00:02:00 - 00:01:74      image 14,400 sectors
```

The second line ends before it starts, and 300 sectors are missing.

**`mia` then repeats the same list independently**, hand-copied, at `mia/medium/medium.cpp:253-255`.
`CompactDisc::readDataSectorCUE` therefore returns nothing for sector 4, `PlayStation::analyze` gets
no `PVD` to look at and falls back to `manifestAudio`, and a working game disc is handed to the
emulator as an audio CD.

Fix is one line, in each of two places — and that a second copy of the list exists at all is worth
raising with it. Patch only `sectorSize()` and the disc parses correctly and still analyzes as
audio.

### 12. A debug diagnostic in `nall::vfs::cdrom::loadSub` prints the whole session table on every disc load

`nall/nall/vfs/cdrom.hpp:376-379` — **verified**

```cpp
    // Diagnostic: decode what we generated and dump it
    CD::Session finalSession;
    finalSession.decode(subchannel, 96);
    print(finalSession.serialize());
```

Unconditional, not behind a debug flag, and it is not free: it constructs a second `CD::Session`,
re-decodes the entire subchannel that was just written, and writes the serialized table to stdout.
Every disc load, on desktop, in a release build.

Its own comment says what it is. Delete the four lines.

### 13. `sizeof(nall::CD::Session)` is 80,820 bytes, and `loadCue` keeps two of them on the stack

`nall/nall/vfs/cdrom.hpp:93` and `:377` — **verified**

`CD::Session` holds 100 tracks of 100 indices, which is a little under 80 KB of automatic storage per
instance. `loadCue` puts one at `:93` and then calls `loadSub`, whose diagnostic (entry 12) puts a
second one live at `:377`. Roughly 160 KB of stack for a disc load.

A native host absorbs that from an 8 MB thread stack and never notices, which is why it has never
been reported. Anything with a smaller stack does not, and the trap is that the overflow does not
surface at the write that caused it — it surfaces later, somewhere unrelated, as a corrupt read.

Not a defect on its own, and it is listed here for the reviewer of entry 12: deleting the diagnostic
halves it for free. If it is ever worth more than that, the session table wants to be heap-allocated
or bounded by the track count actually present.

---

## PlayStation

### 14. `MemoryCard` ignores what `setPak()` returns and dereferences the pak

`ares/ps1/peripheral/memory-card/memory-card.cpp:3-8` — **verified**

```cpp
MemoryCard::MemoryCard(Node::Port parent) {
  node = parent->append<Node::Peripheral>("Memory Card");
  node->setPak(pak = platform->pak(node));

  memory.allocate(128_KiB);
  format();

  if(auto fp = pak->read("save.card")) {
```

`ares::Platform::pak` returns `{}` from its own base implementation, so a frontend that does not
serve this node — or serves it and declines — gets a null dereference the moment a card is seated.

**This is the same shape as entry 3**, and it is the same argument: a latent crash in a public API,
reachable by any frontend other than the one in this tree, costing one line to fix. Of the 45
`platform->pak()` sites under `ares/`, **42 are written `if(!node->setPak(pak = platform->pak(node)))
return;`** — the guarded form is the house style by a wide margin. Exactly two are not:

- `ares/ps1/peripheral/memory-card/memory-card.cpp:3`
- `ares/n64/controller/gamepad/gamepad.cpp:66` — identical, followed by `pak->read("save.pak")`

**Native reproduction.** No Emscripten, no `PLATFORM_WEB`, no BIOS, no disc: a 50-line program
linked against `libares.a` and `libmia.a`, with a `Platform` whose `pak()` returns `{}` for the
`"Memory Card"` node, then `port->allocate("Memory Card")`. Segmentation fault, exit 139. The same
program with a `Platform` that serves a real pak exits 0. (`scratchpad/ps1/cardrepro.cpp`, with its
build line, in this session's scratchpad — it is not in `wasm/`.)

**`desktop-ui` is safe by accident of ordering, again.** `desktop-ui/emulator/playstation.cpp:120-125`
creates the pak unconditionally *before* allocating the port, and nothing there ever allocates Memory
Card Port 2 or hot-swaps a card. So this is latent in the shipped frontend, exactly as entry 3 is.

Fix is the guard the other 42 sites already use. While in there, one adjacent thing to raise but
**not** to patch on this pull request: `MemoryCard` reads and writes `"save.card"` out of whatever
pak it is handed and does not know which slot it is in, and `desktop-ui/emulator/playstation.cpp:178`
matches on the node name alone — `if(node->name() == "Memory Card") return memoryCard->pak;` — so if
Port 2 were ever seated, both cards would share one pak and one save file. Not reachable today.

---

### 15. Half-rate stereo CD-XA audio is interleaved wrong, and plays as static

`ares/ps1/disc/cdxa.cpp:62-77` — **verified**

```cpp
template<bool isStereo, bool is8bit>
auto Disc::CDXA::decodeADPCM(n1 halfSampleRate) -> void {
  const u32 Blocks = 18;
  const u32 BlockSize = 128;
  const u32 WordsPerBlock = 28;
  const u32 SamplesPerBlock = WordsPerBlock * (is8bit ? 4 : 8);

  s16 output[SamplesPerBlock];
  for(u32 block : range(Blocks)) {
    decodeBlock<isStereo, is8bit>(output, 24 + block * BlockSize);
    for(auto sample : output) {
      if(!samples.full()) samples.write(sample);
      if(halfSampleRate && !samples.full()) samples.write(sample);
    }
  }
}
```

`output[]` is left/right interleaved when `isStereo`, so a stereo block holds `SamplesPerBlock / 2`
frames, not `SamplesPerBlock` of them. `halfSampleRate` — a `coding` byte with bit 2 set, meaning
18,900 Hz rather than 37,800 Hz — has to repeat each **frame**. Repeating each **sample** writes
`L,L,R,R` into the queue, and `clockSample()` pops pairs, so it receives `(L,L)` then `(R,R)`. The
stream is mono-ised, and the one surviving channel alternates between the left and the right source
at the full 37,800 Hz output rate. The L−R difference becomes a full-amplitude signal modulated at
Nyquist. That is the static.

Mono half-rate is unaffected — with one channel, repeating the sample and repeating the frame are the
same operation. Full-rate stereo is unaffected: `halfSampleRate` is false and the second `write` never
runs. **Only the stereo half-rate combination is wrong**, which is why this survived: it is the one
path of the four that the double-write breaks.

**Measured**, on `Asteroids (USA)`, whose FMV audio is 320 sectors of `coding 0x5` — stereo, 18,900 Hz:

| | as shipped | frame-repeat fix | real CD-DA music, straight off the disc |
|---|---|---|---|
| decoder output, left ≠ right | **0.00%** of 2,843,615 samples | 42.15% | — |
| decoder output, autocorrelation lag 1 / lag 2 | **0.49 / 0.9992** | 0.9995 / 0.9991 | — |
| final mix, autocorrelation lag 1..4 | **0.667 0.798 0.702 0.670** | 0.988 0.975 0.954 0.928 | 0.991 0.974 0.956 0.938 |
| final mix, spectral flatness | **0.79–0.90** | 0.21–0.59 | 0.22–0.49 |
| final mix, zero-crossing rate | **0.17–0.28** | 0.007–0.029 | 0.007–0.044 |

Left never once differing from right across 2.8 million samples is the direct statement of the
defect. `lag1 ≈ 0.5` beside `lag2 ≈ 1.0` is the generic signature of two signals interleaved
sample-by-sample. The third column is the ground truth: PCM lifted out of `Asteroids (USA) (Track
2).bin` with no emulator involved, and the fixed column lands on it.

**Native by construction.** `cdxa.cpp` contains no `PLATFORM_WEB` and no `__EMSCRIPTEN__` — in the
PlayStation core only `ps1.hpp` and `accuracy.hpp` do — so the shipped file *is* the native
translation unit. The `-DARES_PS1_COTHREAD` reference build, which compiles it with `PLATFORM_WEB`
undefined, reproduces the numbers above byte for byte. **A `desktop-ui` run was not performed**; on a
desktop build the path to reach it is `Asteroids (USA).cue`, roughly 40 seconds past boot, into the
attract-mode FMV. Do that before sending, since this entry's own ground rule requires it.

**FIX APPLIED IN THIS BRANCH** — `DECISIONS.md` §2d, change D1. Unguarded, because a bug fix behind
`#if defined(PLATFORM_WEB)` would assert the bug is correct natively. Lift this hunk out as-is; it
has no dependency on the port. Iterate `output[]` a frame at a time and repeat the frame:

```cpp
  const u32 SamplesPerBlock = WordsPerBlock * (is8bit ? 4 : 8);
  const u32 Step = isStereo ? 2 : 1;
  const u32 Repeats = halfSampleRate ? 2 : 1;

  s16 output[SamplesPerBlock];
  for(u32 block : range(Blocks)) {
    decodeBlock<isStereo, is8bit>(output, 24 + block * BlockSize);
    for(u32 index = 0; index < SamplesPerBlock; index += Step) {
      for(u32 repeat : range(Repeats)) {
        for(u32 channel : range(Step)) {
          if(!samples.full()) samples.write(output[index + channel]);
        }
      }
    }
  }
```

Mono is unaffected because `Step` is 1, and full rate because `Repeats` is 1 — the two arms that
were already correct stay bit-identical, which is why the control disc below does not move.

**Post-fix verification.** `Asteroids (USA)`, 4500 frames, module before vs module after: **video
identical** — 864 distinct frames and lit fraction 0.5526 both ways — while the audio hash moves
`436a32d6` → `63cb22c1`. Audio changing while the picture does not is the shape that confines the fix
to the audio path. `Raiden Project` is identical on every column including audio hash `cc855b8c`.

### 16. A data read never re-checks the track, and runs off the end into the CD-DA tracks

`ares/ps1/disc/drive.cpp:130-140` against `:61-72` — **verified**

The seek path is careful. Before a `SeekL` completes it resolves the target's track and refuses the
seek unless it is a data track (`:61-72`):

```cpp
const bool beyondDisc = target < 0 || target > session->leadOut.lba + CD::LeadOutSectors;
bool inDataTrack = false;

if(!beyondDisc) {
  if(auto trackID = session->inTrack(target)) {
    if(auto track = session->track(*trackID)) {
      inDataTrack = track->isData();
    }
  }
}

const bool ok = (seekType == SeekType::SeekP) ? !beyondDisc : (!beyondDisc && inDataTrack);
```

The read path applies no such test on any subsequent sector (`:130-140`):

```cpp
if(self.ssr.reading) {
  self.debugger.read(lba.current);
  self.fd->seek(2448ull * (CD::LeadInSectors + CD::LBAtoABA(lba.current++)));
  self.fd->read({sector.data, 2448});

  if(auto trackID = session->inTrack(lba.current)) {
    sector.track = *trackID;
  } else {
    sector.track = 0;
  }
```

`sector.track` is computed and stored and then **never consulted as a guard**. `ReadN`/`ReadS` set
`ssr.reading` and nothing clears it but an explicit `Pause`/`Stop`, so a title that starts a read and
then stops servicing the drive keeps advancing `lba.current` one sector per sector clock, straight
out the end of track 1 and into the audio tracks behind it.

What makes that audible rather than merely wasteful is `:170-180`. Raw 44,100 Hz PCM is tested as if
it were a Mode 2 subheader —

```cpp
if(sector.data[15] == 0x02) {
  ...
  if(mode.xaADPCM && (sector.data[18] & 0x44) == 0x44) {
    return cdxa->clockSector();
  }
```

— two byte comparisons, which music satisfies by chance roughly once every 250 sectors. Those
sectors are handed to the ADPCM decoder. Observed garbage subheaders while off the end:
`file=238 ch=7`, `file=86 ch=249 coding=0xfe`, `file=208 ch=0 coding=0xff`.

**Observed** on `Mortal Kombat Trilogy (USA) (v1.0)`, which begins an FMV at LBA 25,310, issues no
further disc command after frame 1,334, and renders a pixel-identical frame from 3,500 through 6,999.
The drive was still reading at LBA 44,532 — track 3, well past track 1's 30,116 sectors. Unaffected
by the entry 15 fix; the two are independent.

**Order the claims carefully if this is sent.** The runaway read is a *consequence* of that title
wedging, not proven to be its cause — something upstream of the drive stopped issuing commands first,
and why is not established here. What is established, and is defensible on its own, is that the read
path has no track bound at all. Send it as "reads are unbounded", not as "this is why Mortal Kombat
hangs".

**NOT FIXED IN THIS BRANCH.** Unlike 15 and 17, this one has a design question in front of it and was
left alone deliberately. The cheap half is free — `sector.track` is already computed on the line
above, so gating the XA decode on it costs one comparison and nothing else:

```cpp
    if(sector.data[15] == 0x02 && session->track(sector.track)
    && session->track(sector.track)->isData()) {
```

That stops music PCM reaching the ADPCM decoder, which is the audible half. It does **not** stop the
drive walking off the end, and that is the part that needs a decision rather than a patch:

- what should reading past the end of a data track *do* — keep reading and deliver nothing, raise an
  error in `ssr`, or stop the drive? Hardware's answer is not obvious from the symptom, and picking
  wrong makes a different set of titles worse.
- `ReadN`/`ReadS` on a real drive do run into the next track; a bound that is too tight would break
  legitimate reads that straddle a boundary.

**So the investigation this owes is behavioural, not diagnostic**: establish what hardware does at
the end of a data track before proposing a bound. The one-line guard above is defensible on its own
and could be sent alone, framed narrowly as "do not feed non-data sectors to the XA decoder".

### 17. `SIO1_BAUD` is not decoded, reads back 0, and a game divides by it

`ares/ps1/peripheral/io.cpp:114-121` — **verified**

`Peripheral::readHalf` decodes `1f801040/1044/1048/104a/104e` — SIO0, the controller and memory card
port — and nothing else. `ares/ps1/memory/bus.hpp:12` routes the whole `1f801050-105f` block, SIO1,
to `Peripheral` anyway, so every SIO1 access reaches the `debug(unhandled, …)` line at `:120`, **and
every SIO1 read returns 0**.

`Agile Warrior F-111X (USA)` writes `SIO1_BAUD`, reads it straight back, and divides by what it got:

```
8003c2ac  addu a0,s1,0        ; a0 = 0 -> "get"
8003c2b0  jal  0x8003be60     ; SIO1 register accessor, jump table
8003c2b4  addu a1,s0,0        ; a1 = 3 -> selector 3 = BAUD, offset +0xe
8003c2b8  lui  v1,$001f
8003c2bc  ori  v1,v1,$a400    ; v1 = 2073600, the SIO1 baud base clock
8003c2c0  div  v1,v0          ; <- v0 = 0
8003c2c4  bne  v0,0,$8003c2d0
8003c2cc  break 0x7           ; GCC's MIPS divide-by-zero trap
```

The two decisive trace events are consecutive, at frame 1020:

```
[14] pc 8003bfac  W16 1f80105e = 0001
[15] pc 8003bf0c  R16 1f80105e = 0000
```

The BIOS has no handler for `break 0x7`, so the exception lands in `A(40h)
SystemErrorUnresolvedException`, which self-loops through the A-function vector forever — **10,006,648
`a0(40)` entries** in a 3000-frame run, which is the observed "the CPU's PC is always `0x000000a0`".
The machine is alive the whole time. It is executing the BIOS's own error loop.

**This is not a polling hang, and the obvious SIO1 story is wrong.** There are exactly **15** accesses
to `1f801050-105f` in a whole run, all at frame 1020, none afterwards. `1f801054` (`SIO1_STAT`) is
**never read by this game at all**, so a TX-ready/TX-empty status bit is not involved. Counts:
`1058` (MODE) 3 writes; `105a` (CTRL) 6 writes, 3 reads; `105e` (BAUD) 2 writes, 1 read. One dropped
readback is the entire defect.

**Measured**, `Agile Warrior F-111X`, 3000 frames, native, with `1f80105e` made storage-backed:

| | as shipped | with the readback |
|---|---|---|
| `a0(40)` error-loop entries | 10,006,648 | **0** |
| distinct video frames | 170 | 307 |
| dimensions reached | 640x480 only | 640x480 → 512x240 |
| lit fraction | 0.2206 | 0.5893 |
| distinct CPU PC samples | 1 (`0xa0`) | 9, all game code |
| `JOY_STAT` pad polls | 0 | 2.25M |

It reaches the Black Ops Entertainment screen, the title screen, attract-mode 3D gameplay and the
GAME START / OPTIONS menu. A 9000-frame run stays clean, 1641 distinct frames.

**The minimal correct behaviour is the readback, not a constant.** A variant that discards writes and
hard-returns `0xffff` boots identically — the value is used only as a divisor, so anything non-zero
clears the trap. That makes a constant a fix by accident: on hardware `SIO1_BAUD` is a plain
read/write reload register, and a game that reads it back is entitled to the value it wrote. Store the
halfword and return it.

**FIX APPLIED IN THIS BRANCH** — `DECISIONS.md` §2d, change D2. It mirrors the `1f80'104e` arms that
already exist a few lines above, in `readHalf`:

```cpp
  //SIO1_BAUD
  if(address == 0x1f80'105e) {
    data.bit(0,15) = io.sio1BaudrateReloadValue;
    return data;
  }
```

and in `writeHalf`:

```cpp
  //SIO1_BAUD
  if(address == 0x1f80'105e) {
    io.sio1BaudrateReloadValue = data.bit(0,15);
    return;
  }
```

with one `n16 sio1BaudrateReloadValue;` in `peripheral.hpp` beside `baudrateReloadValue`.
`Peripheral::power` is `io = {}` so the field resets itself and needs no line there, and
`ares/ps1/memory/bus.hpp:12` already routes the block, so there is no bus change.

**The upstream patch needs one line this branch does not have: `s(io.sio1BaudrateReloadValue);` in
`ares/ps1/peripheral/serialization.cpp:31`.** It is omitted here on purpose — adding it changes the
save-state layout, and this branch keeps states byte-interchangeable with a stock desktop build. The
unsaved window is the two consecutive instructions between the write and the readback. **Put the line
back when sending this**; a register that survives a save is the correct behaviour and the reason to
omit it is local to this branch only.

**Post-fix verification**, module before vs module after: `Agile Warrior` reaches 512x240 with lit
fraction 0.5891 and 267 distinct frames, from 640x480 and 0.1263. `Raiden Project` is identical on
every column, audio hash `cc855b8c` both ways. Save state size is **4,019,632 both ways**, which is
the omitted serialization line holding the layout still.

`1f801058` and `1f80105a` stay dropped and this game does not care. **A complete SIO1 block is a
separate and much larger job** — link-cable emulation — and should not ride on this. The claim here
is narrow and provable: one register that is written and read back is silently returning 0, and it
costs a game its boot.

**Native reproduction — confirmed twice, including on a shipped release.**

1. **ares' own desktop installer**, 2026-08-13. Seat `Agile Warrior F-111X` and boot: the machine
   holds the SCEA licence screen and never leaves it. No local build, no instrumentation, no
   WebAssembly — the released binary as any user would run it. (Record the exact release version
   before opening the pull request; it was not captured at the time.)
2. A headless native harness, which is where the numbers above come from — `ARES_CORES=ps1`,
   `RelWithDebInfo`, `GPU::Threaded = 1`, the threaded `nall` cdrom loader, track files read off
   disk, no Emscripten in the process. The trap fires at frame 1020, roughly 17 seconds in.

`ares/ps1/peripheral/io.cpp` contains no `PLATFORM_WEB` and no `__EMSCRIPTEN__`, so there was never a
mechanism by which the web port could be involved; the two reproductions above are what settles it
rather than that argument.

**Worth stating in the pull request, because a reviewer will have heard otherwise:** this disc runs
correctly under other emulators, which implement `SIO1_BAUD` as the plain read/write register it is.
"It works elsewhere" is therefore true and is not evidence against the diagnosis — it is the
diagnosis.

**Control, and the blast radius.** `The Raiden Project` makes **zero** accesses to `1f801050-105f`
and is unchanged by the fix: 1166 distinct frames both ways, same dimensions, audio hash `bc67c89c`
both ways. Better than one control — a 126-disc library was swept and **`Agile Warrior F-111X` is the
only disc in it that touches the SIO1 block at all**. So this register is reached by roughly 1 title
in 126, it is dead code for everything else, and a reviewer weighing the risk of the change is
weighing almost none: today every one of those accesses is already falling through to a `debug`
line.

**One note for whoever takes this branch's side of it.** The `serialization.cpp` line makes the fix a
save-state layout change, which this branch is not allowed to make. A branch that wants the boot
without the layout change can add the field and *not* serialize it — the game writes and reads the
register back on consecutive instructions, so the unsaved window is a few cycles wide. That
compromise is this branch's business and must **not** be sent upstream; upstream should serialize it.

---

### 18. A streaming sector's data is destroyed while its own INT1 is still pending

`ares/ps1/disc/drive.cpp:183-199` and `ares/ps1/disc/command.cpp:38-69`. Confidence: mechanism
**verified** — source re-read 2026-08-13 and again 2026-08-14. Fix and measurements **verified** —
built and run natively on 2026-08-14, five discs, six 30,000-frame segments per arm, every segment
re-run once and byte-identical.

**The two halves of one event disagree.** `Disc::Drive::clockSector()` flushes the data FIFO
unconditionally, refills it from the sector just read, and then raises INT1:

```cpp
    //any remaining FIFO data is lost if a new sector is clocked
    //before all data from the previous sector was read by the CPU
    self.fifo.data.flush();
    ...
    self.queueResponse(ResponseType::Ready, {self.status()});
```

The comment states the data policy deliberately, so that half is intentional. But `queueResponse`
will not raise a second interrupt while one is pending — it **defers** it
(`command.cpp:39` and the `ResponseType::Ready` arm at `:64`). So when the host is one sector-time
late acknowledging INT1, the *interrupt* survives and the *data it refers to* does not. The deferred
INT1 arrives later describing a sector whose bytes were thrown away, and the host reads the following
sector instead. **One sector is silently dropped from the middle of a stream, with no error, no
status bit, and no gap the game can detect.**

**A deferral that keeps the announcement and throws away the thing announced is wrong on its own
terms** — `clockSector()` and `queueResponse` disagree about what one event is, and that argument
would stand with no victim at all. It has one. **`Crash Bandicoot (USA)` hangs permanently at a level
load, and the path from the dropped sector to the dead machine is traced instruction by instruction.**
Scripted-input arm, 30,000 frames:

| frame | event |
|---|---|
| 2,963 | a load screen appears; the picture stops changing, the machine is healthy |
| 3,132 | sector 15,314 is destroyed — 15,315 is clocked while 15,314's INT1 is still outstanding |
| 3,145 | the game's LZ77 decompressor desyncs, and its remaining-output count steps past zero |
| 3,145-3,161 | runaway copy, 447 KB, output pointer `0x80192c8b` → `0x80200000` |
| 3,161 | 387 stores fold onto physical `0x0-0x182`, destroying the exception vector at `0x80` |
| 3,161+ | every interrupt vectors into the wreckage, and the machine loops there for the rest of the run |

**The loss is confirmed against the disc image, not inferred.** RAM was compared byte-for-byte with
the track file (`MODE2/2352`, user data at +24) at the frame of the event. The game's buffer holds
`…15313, 15315, ZEROS, 15316…` — the slot for 15,314 got 15,315's bytes, and the slot for 15,315 got a
DMA off an empty FIFO. The same pair repeats three frames later for 15,322 and 15,323. The drive log
at the flush is the mechanism above, in order:

```
f=3132 S lba=15314 fifo=0     defer=0   <- 15314 into fifo.data, INT1 raised
f=3132 S lba=15315 fifo=2048  defer=1   <- 15315 clocked; 15314 still unread, its INT1 outstanding
f=3132 D addr=1a0734 fifoLBA=15315 fifo=2048   <- DMA gets 15315
f=3132 D addr=1a0f34 fifoLBA=15315 fifo=0      <- DMA gets zeros
```

**The game cannot recover, because its decompressor tests for exact zero.** The LZ77 loop at
`0x80013a54-0x80013af8` keeps the remaining output count in `a2` and exits on `bne a2,0`. The zero
block desyncs the token stream, a 7-byte chunk is decoded when 2 bytes remain, and `a2` walks
`16 → 9 → 2 → −5` straight past the test; the seven preceding calls into the same routine all
terminated normally. The loop then writes 447 KB past the end of its output buffer — `sb v0,(t7)` at
`0x80013ae8`, `t7` walking `0x80192c8b` → `0x80200000` — and past the end of RAM, where the 2 MiB
mirror folds the stores onto physical `0x0`. Once the exception vector at `0x80` is gone, every
interrupt vectors there, jumps to `0x00000c80`, takes a data bus error at `0x00000c94`, and re-enters
`0x80` forever.

**The fix: stage the sector beside its deferred INT1, and promote the two together when the host
drains the FIFO.** `fifo.deferred` gains a `queue<u8[2340]> sector`; `clockSector()` writes into that
queue instead of `fifo.data` while an INT1 is outstanding; the promotion goes in the request-register
write at `ares/ps1/disc/io.cpp:158-163` — bit 7 of `0x1f801803` index 0, Want-Data — and fires only
once `fifo.data` has been emptied:

```cpp
    if(io.sectorBufferReadRequest && fifo.data.empty() && !fifo.deferred.sector.empty()) {
      while(!fifo.deferred.sector.empty()) fifo.data.write(fifo.deferred.sector.read(0));
    }
```

**Promoting on the interrupt acknowledge instead does not work, and this is the part a reviewer will
ask about.** The obvious site is `flushDeferredResponse()` (`command.cpp:71-99`), which is where the
deferred INT1 is delivered — but it runs off the interrupt-*acknowledge* write (`io.cpp:178`), and
**every ISR acknowledges before it transfers data**. Promote there and the promotion's own
`fifo.data.flush()` destroys the sector the host is about to read: the loss relocates one call
earlier, and the game breaks identically, byte for byte. The drain is the correct trigger because it
is the one event that says the host is finished with the sector it already has.

Staging is one slot deep, matching `queueResponse` exactly: a second overrun drops the sector as the
existing code already drops the second interrupt. **The drive keeps turning throughout** — nothing
stalls the spindle. `Disc::serialize` gains the staged sector, which moves a save state
4,019,632 → **4,021,980** bytes, +2,348 for the 2,340-byte slot and two queue indices.

**`Crash Bandicoot`, 30,000 frames, both input arms.**

| | baseline | promote-at-drain |
|---|---|---|
| scripted: writes past the end of RAM | 387 | **0** |
| scripted: longest static run | 27,038 from frame 2,963 | **518 from frame 713** |
| scripted: distinct frames | 321 | **495** |
| no input: writes past the end of RAM | 1,367 | **0** |
| no input: longest static run | 8,076 from frame 21,925 | **595 from frame 23,851** |
| no input: distinct frames | 5,674 | **7,472** |

All six figures reproduced exactly on a second run of the same binary.

**All four controls pass.** `The Raiden Project`, `Asteroids` and `Agile Warrior F-111X` destroy no
sector in either build and are unchanged on every aggregate — sectors clocked, sectors delivered, end
LBA, longest static run and its start, lit fraction, dimensions, **audio hash** — and `Asteroids` is
bit-identical to baseline down to its video sequence hash. `Raiden`'s distinct-frame count moves by
one, and `Raiden`'s and `Agile`'s video sequence hashes change; a separate control arm carrying only
this patch's dead struct member and none of its logic moves them exactly the same way, so that belongs
to the binary rather than to this fix. It is **entry 20**.

`WipEout XL` is the only control the fix engages, and it is the one control that had the defect: its
single destroyed sector goes to zero and it gains three distinct frames, 3,408 → 3,411, with the
static stretch it was sitting on starting three frames later and ending in the same place. Sectors
clocked (16,689), end LBA (34,084), audio hash and dimensions are identical. **That is the fix
working, not a regression.**

**Zero destruction by any path.** Under the patch a sector could still be lost at three places. All
three were instrumented separately, and all three read **0** across every one of the six segments:

- **The original flush** — `fifo.data` emptied while the INT1 that announced its bytes is still
  outstanding. This one is unreachable by construction, not merely unobserved: the flush target is
  `fifo.data` only when `irq.pending()` is false, `pending()` is the OR of all five interrupt flags
  (`ares/ps1/disc/irq.cpp:11-19`), `queueResponse` arms the deferred INT1 slot only while `pending()`
  is true, and every write that clears a flag calls `flushDeferredResponse()` in the same handler
  (`io.cpp:166-180`), which delivers a deferred response and raises a flag again. An armed INT1 slot
  and an unflagged controller cannot coexist.
- **The staging slot overwritten before promotion** — a site that exists only under this patch, where
  a new sector arrives while the slot still holds one the host has not taken.
- **The second-overrun drop**, where a sector arriving behind an already-deferred INT1 is discarded,
  exactly as the existing code discards the second interrupt.

**This entry claimed on 2026-08-14 that the `Crash Bandicoot` chain was falsified. That verdict is
withdrawn.** It rested on a build in which a fix that did not work was measured by a counter that was
no longer at the right place. Three things produced it, stated once so nobody repeats them:

- **The fix under test was the promote-at-acknowledge design**, which relocates the loss instead of
  removing it. "A build that destroys 67,301 sectors and a build that destroys none corrupt
  identically" was an accurate measurement of a build that still destroyed the sector, one call later.
- **The counter sat at the original flush site**, which that build no longer reached, so it reported
  zero destruction beside byte-identical damage.
- **The "the freeze precedes the loss" ordering compared two unrelated events** — the start of a video
  static run against a corruption frame. There is no stall at frame 2,963: that is a load screen, and
  the CPU keeps running normally for about 200 more frames, PC spread across 12-13 values per 50-frame
  bucket, the drive still reading, interrupts still firing. The machine derails at 3,161, which is the
  frame of the first past-end write, not 198 frames after it.

The scripted arm's **67,301** destroyed sectors still needs reading correctly, as it always did: once
the machine stops acknowledging INT1 the drive keeps turning, so the count runs away. That is one dead
machine, not 67,301 damaged streams. `WipEout XL`'s **one** is what this defect looks like in a
machine that is still alive.

**FIX APPLIED IN THIS BRANCH** — `DECISIONS.md` §2d, change D3. Unguarded, because a bug fix behind
`#if defined(PLATFORM_WEB)` would assert the bug is correct natively. Applied in a **branch-local
form that omits one line**: `s(fifo.deferred.sector);` is left out of
`ares/ps1/disc/serialization.cpp`, so the staged sector is held live and unsaved and a save state
stays at **4,019,632** bytes rather than moving to 4,021,980. This branch keeps states
byte-interchangeable with a stock desktop build in both directions, which the upstream form would
break. **The upstream patch must restore that one line** — it is the same compromise entry 17
carries, and like 17's it must not travel.

The omission costs more here than it does in 17, and the pull request inherits none of it. The window
is one sector-time wide, and only a title that falls a sector behind ever opens it.
`ares/ps1/system/serialization.cpp:34` gates `power(/* reset = */ false)` on the state's `synchronize`
flag. A normal save/load passes `synchronize == true`, so `power(false)` clears all of
`fifo.deferred` including the staging slot, and the serialized fields restore the deferred INT1
without its bytes — a state captured inside the window loses exactly the one sector this fix saves,
which is the pre-fix outcome confined to that window. Run-ahead
(`desktop-ui/program/program.cpp:105`) and rewind (`desktop-ui/program/rewind.cpp:23`) serialize with
`synchronize == false`, so `power(false)` never runs and they neither clear the hold nor restore it;
the restored machine inherits the live instance's. Restoring the `serialization.cpp` line removes all
of it.

Every figure in the `Crash Bandicoot` table above was re-measured on the unserialized form,
30,000 frames per arm against a baseline built from the same tree, and every one reproduced exactly.
`WipEout XL` reproduced exactly too. The one number that moved is `Raiden`'s distinct-frame count,
which under the unserialized build does not move from baseline at all rather than moving by one — the
same entry-20 binary-layout noise the control paragraph above already attributes to the binary and
not to this fix. The save state stayed at 4,019,632 on all six segments.

**Ready to send.** `.agents/singleshot/entry18-probe/sector-promote-at-drain.patch` is the fix alone
in its upstream form — four files including the serialization line, no instrumentation — and applies
cleanly to HEAD; `control-sweep-instrumentation.patch` is the same fix plus the counters, for
re-running the measurement. **`sector-hold-fix.patch` is the withdrawn promote-at-acknowledge design
and is corrupt at line 23; delete it rather than repair it.** The save-state size change is the one
thing a maintainer has to accept, and what it buys is a commercial disc that hangs today.

**What is still not established**, and belongs in the pull request. Staging is one slot deep, so a
two-sector lag still drops data. Whether `Crash` is *playable* past this point was not checked — the
hang, the RAM overrun and the exception loop are gone and the picture keeps changing, but no frame
content was inspected. And why the game falls a sector behind at 15,314 in the first place is unknown:
hardware tolerates a one-sector lag because the drive has several sector buffers where ares has one,
so ares' sector pacing may be off as well. That is a separate question, and this fix does not depend
on its answer.

### 19. The DMA trigger bit starts a transfer with no source-readiness check

`ares/ps1/dma/channel.cpp:42-45` and `:80-83`. Confidence: mechanism **verified** — source re-read
2026-08-14, both sites and every line number below confirmed against the tree. Measurements
**recorded** — taken natively on 2026-08-13 and carried from that investigation's own notes; nothing
was re-run today.

`DMA::Channel::kick()` and `DMA::Channel::step()` open with the same four lines:

```cpp
    auto dmaReq = trigger;
    if(direction == 0 && canRead[id]()) dmaReq = true;
    if(direction == 1 && canWrite[id]()) dmaReq = true;
    if(!dmaReq) return false;
```

`trigger` is CHCR bit 28, decoded at `ares/ps1/dma/io.cpp:245`, and the same register write kicks
every channel in priority order (`io.cpp:262-264`). Because `dmaReq` is **seeded** from `trigger`,
the device's own readiness predicate is only ever an additional way to say yes — **never a veto**. A
game that sets bit 28 gets its sync-0 transfer immediately, whether or not anything has data for it.

For channel 3 the predicate that goes unconsulted is `Disc::canReadDMA()` (`ares/ps1/disc/io.cpp:1-3`):

```cpp
auto Disc::canReadDMA() -> bool {
  return io.sectorBufferReadRequest && !fifo.data.empty();
}
```

and nothing downstream catches the miss. `Disc::readDMA()` (`:5-12`) takes four bytes per word with
`fifo.data.read(0)`, and `nall::queue::read(fallback)` (`nall/nall/queue/st.hpp`) returns the fallback
on an empty queue — **an empty FIFO reads back as `0x00000000`, silently**. `transferBlock()` then
runs the block out in one go, so the readiness question is never asked again mid-transfer either. A
game that arms a CD DMA before the sector buffer is filled gets a block of zeros written into RAM at
full speed instead of a transfer that waits for the drive.

**Measured** — instrumentation on `transferBlock()` logging every channel-3, direction-0 transfer with
`fifo.data.size()` at entry, and on `Disc::readDMA()` logging every call that found fewer than four
bytes queued:

| disc | run | short transfers | `readDMA` underruns |
|---|---|---|---|
| `Crash Bandicoot (USA)` | 8,050 frames, scripted to N. Sanity Beach | **1** | **40** |
| `The Raiden Project` (control) | 4,000 frames, no input | 0 | 0 |

The 40 is where the logger's cap sat, so read it as "at least 40". One control disc, not several. The
short transfer itself, verbatim from the log:

```
CDDMA SHORT addr=00132114 words=512 fifo=0 blocks=1 sync=0 chop=0 sbrr=1 lba=51504 reading=1
```

512 words is 2,048 bytes — one Mode 2 Form 1 sector — with the FIFO **completely empty** and the
game's Want-Data bit already set. 2 KiB of zeros went into RAM at `0x00132114`.

**A gate was written and tested**, applied to both copies of the block:

```cpp
    //the trigger bit arms a SyncMode 0 transfer, but the device's request line still gates it.
    //The CD-ROM only asserts it while the sector buffer holds data.
    if(id == 3 && direction == 0 && !canRead[id]()) dmaReq = false;
```

`trigger` is cleared only *after* the early return, so a blocked transfer stays armed and fires from a
later `step()` once the drive has filled the FIFO; nothing else needs to re-kick it. Scoped
deliberately to channel 3 — channel 6 (OTC) has no device behind it, `canRead[6]` is a constant
`false` and OTC's direction is forced to 0 at `io.cpp:248-256`, so OTC must keep starting on the
trigger alone. A general `id != 6` form was never tested and should not be assumed safe.

**Gating it does not fix the `Crash Bandicoot` freeze, and that has to be said if this is sent.** Over
the same 30,000-frame scripted run the gate took short transfers 1 → 0 and `readDMA` underruns
40 → 0, and the freeze was **unchanged** — same longest static run, and the write past the end of RAM
still happened. The zeros landed in a buffer that title tolerated. **It is a real defect that is not
that hang.** The hang is **entry 18**, the destroyed sector behind a deferred INT1, traced end to end
and fixed. Do not re-attach this entry to that disc, and do not take entry 18's result as evidence for
this one: they are separate defects that happen to share a victim.

**What is not established** is what hardware does when a game arms a CD DMA early. The gate assumes
the transfer waits on the device's request line, which is what ares' own `canReadDMA()` predicate
implies, but it was not checked against hardware or against another emulator. That is what this entry
owes. The cheapest evidence is a sweep counting short transfers per title: if many titles arm early,
the defect earns a fix on frequency alone; if `Crash` is the only one, it is a curiosity.

### 20. A run is bit-reproducible per binary, and stops being reproducible across binaries

`ares/ps1` — no line is cited, because the line has not been found. Confidence: the observation is
**verified** — measured on 2026-08-14 by a control arm built for exactly this question, and re-read
field by field from that sweep's per-run records. The **cause is unidentified**. Nothing below is a
diagnosis; the entry exists so the effect is not met again and written off as harness noise.

**The control that found it.** Entry 18's sweep carried an arm whose only difference from baseline was
**the dead half of that fix**: `queue<u8[2340]> sector` added to `Disc::FIFO::Deferred`
(`ares/ps1/disc/disc.hpp:285-289`) and one `s(fifo.deferred.sector)` line in `Disc::serialize`, with
none of the behavioural change. Nothing reads or writes that member. `Disc` is a global
(`ares/ps1/disc/disc.cpp:5`), so all the member does is enlarge it and move whatever is laid out after
it, and the serialize line runs once after the last frame, when the harness measures state size — so
*within* a run that arm differs from baseline **only in layout**. It was there to separate "the fix
changed something" from "the binary changed", and it separated them:

| disc | baseline against the layout-only arm |
|---|---|
| `The Raiden Project` | **differs** — 17,452 against 17,453 distinct frames, and a different video sequence hash |
| `Agile Warrior F-111X` | **differs** — a different video sequence hash, 3,369 against 3,368 distinct frames |
| `Asteroids` | identical on every field, sequence hash included |
| `WipEout XL` | identical |
| `Crash Bandicoot`, both input arms | identical |

On `Raiden` the layout-only arm matches the **fixed** arm exactly and both differ from baseline, which
is what says the difference belongs to the binary and not to entry 18's logic. On `Agile Warrior` all
three arms produce three different sequence hashes while every aggregate — sectors clocked, end LBA,
longest static run, lit fraction, dimensions, audio hash — is identical in all three.

**The runs themselves are bit-reproducible, which is what makes this readable as signal rather than
scatter.** With Homebrew Mode on, `ares/ps1/system/system.cpp:131-133` re-seeds the PRNG from
`Random::Default`, two constants in `ares/ares/random.hpp`, and `Random::seed(Init)` resets both state
words from them without consulting the clock or any address. Every power-on randomisation therefore
draws from one fixed stream: RAM and scratchpad (`cpu.cpp:159-160`), VRAM (`gpu.cpp:130`), SPU RAM
(`spu.cpp:107`), the i-cache (`icache.cpp:49`). Measured: all six segments of one arm re-ran
**byte-identical**, video sequence hash included. A hash that moves when a struct grows is not
run-to-run variation.

**It is bounded, and pre-existing.** One frame in 17,452 on `Raiden`; on `Agile Warrior` nothing an
aggregate can see, so frame content or frame order inside an identical envelope. Three of the five
discs do not show it at all, no counter moves, and no memory is damaged. The arm that exposes it is
stock logic with one unused field, so neither entry 18's fix nor this branch causes it.

**Ruled out, against source.** The PRNG, as above. Uninitialised heap reaching the guest:
`Memory::Writable::allocate` fills the whole rounded allocation before it is used
(`ares/ares/memory/writable.hpp:19-26`). An address read as data: `ares/ps1` contains no
`reinterpret_cast` and no cast of a pointer to an integer — the only `uintptr_t` in the core is an
unnamed thread entry-point parameter (`gpu/gpu.hpp:67`, `:361`). **What has not been examined** is
uninitialised stack, class members that `power()` never assigns, and shared code the core pulls in.

**Why it earns an entry with no cause.** It is a trap for exactly the kind of measurement this file is
made of: add a field, recompile, and a control disc's video hash moves for reasons that have nothing
to do with the change under test. It is not what flipped entry 18's verdict — that entry names the
three things that did — but it is the same class of hazard, and it was only visible because an arm was
built to look for it. Anyone chasing it should start from `Raiden`, the cheapest case on hand: one
frame differs across a 30,000-frame run, so a frame-by-frame diff between the two arms localises it
directly.

---

### 21. `Syphon Filter` self-links its ordering table, and ares turns that into a dead machine

`ares/ps1/dma/channel.cpp:102-107` — **verified**, traced instruction by instruction on
2026-08-14 against `Syphon Filter (v1.0)` (SCUS-94240). **A fix is applied in this working tree**;
see entry 22 and §2d D4 in `DECISIONS.md`. The game hangs permanently 3,241 frames in: 368x240, then
black forever, on the native build and on ares' shipped desktop installer. Identical address on
`scph5501` and `scph5502`. **Uninitialised RAM is not implicated**: `System::power` only seeds
`Random::Default` under Homebrew Mode (`ares/ps1/system/system.cpp:131-133`, `homebrewMode` defaults
false), and the failure is the same with it on and with it off — though note that with it off
`Random::seed()` falls back to `(n64)clock()`, which in a fresh process is near-constant, so the
off-arm is weaker evidence than it looks. The reproduction on the shipped desktop build is what
settles it.

**Terminal state.** CPU PC pinned at `0x800e6f80` across 300+ consecutive frame boundaries while
video scanout continues and timers tick. That address is `lui a0,$8011` — not a branch-to-self. The
CPU is not looping, it is not executing at all. DMA channel 2 is `RUNNING sync=2 addr=12243c`, and
walking the list out of RAM gives one node that points at itself:

```
  node  0 @12243c header=0212243c next=12243c len=2
  node  1 @12243c header=0212243c next=12243c len=2   <-- REVISITED
```

`CPU::waitDMA()` (`ares/ps1/cpu/cpu.cpp:80-82`) is reached from `Bus::calcAccessTime`
(`ares/ps1/memory/bus.hpp:31`) on every non-DMA bus access, and spins while `dma.active()`. It never
becomes false — see entry 22 — so the CPU never fetches another instruction.

**Who wrote the self-link, and why the game is not at fault.** `0x800e7f54` is libgpu's `AddPrim`
verbatim: `p->tag = (p->tag & 0xff000000) | (*ot & 0x00ffffff); *ot = (u32)p & 0x00ffffff;`. Called
twice on the same `p` with the same `ot` and no ordering-table clear between, the second call reads
`*ot` — which the first call set to `p` — and writes it into `p->next`. A full instruction trace of
frame 3241, tapping the sprite loop at `0x800caa38` and every `AddPrim` entry:

```
  TAP  render entry 800ca7fc  ra=800ca5a4      <- called from the frame loop
  LOOP idx=5  s1=8012d880                       <- ctx 5
  PRIM ot=801f26a0 p=8012243c                   <- p->tag = 0219f7a4, valid
  LOOP idx=3  s1=8012d78c
  PRIM ot=801fef60 p=80122424
  TAP  teardown entry 800c794c ra=80014eac      <- game's screen-transition routine
  TAP  render entry 800ca7fc  ra=800c79a4       <- teardown calls the renderer AGAIN
  LOOP idx=5  s1=8012d880                       <- same ctx, same p, same ot
  PRIM ot=801f26a0 p=8012243c                   <- p->tag = 0212243c, self-linked
```

`p` is indexed by render context alone — `0x80122400 + ctx*12`, `ctx = bufIndex + entry->layer*2` —
and `ot` is `ctxRecord->otBase + (4 << shift) - 4`, the last table entry. The teardown at
`0x800c794c` calls the renderer twice back to back by design (`jal 800d769c` at `0x800c799c` and
`0x800c79a4`) and only then zeroes the sprite count at `0x800c79b0`. The buffer index at
`0x8011645e` has exactly one writer, `0x800ca330`, which ran once in frame 3240 and not again, and
DMA channel 6 cleared the three tables once in frame 3240 — one clear, two renders. So the game
really does call `AddPrim` twice on one primitive. **That is not the defect.** psx-spx is explicit
that hardware hands the CPU the bus back between list entries, so on hardware the machine keeps
running, the next frame's `ClearOTagR` plus `AddPrim` rewrites `p->tag` with a real link, and the
list terminates. The game glitches for a moment and continues. **ares alone converts it into a
permanent freeze**, which is why no other emulator's tracker carries this bug: DuckStation's game
database has no trait, hack or setting for SCUS-94240, SCES-01910 or either SF2 disc, and rates all
of them `NoIssues`.

**Measured, both arms in one session.** With entry 22's fix applied the game leaves the runaway on
its own — DMA channel 6 clears a table again at frame 3486, channel 2 gets a real chain address back
in the same frame, and the 300-frame window at 4,500 reports 101 distinct frames at 99.99% lit.
Without it, 6,000 frames produce zero CPU instructions per frame from 3,242 onward and the screen
never leaves black. The recovery gap is mostly the game's own level load — the CD is still running
`ReadN` throughout it — and not the throttle: widening the CPU window eight-fold does not shorten it
materially.

**What this entry does not establish.** Whether the game's teardown path is reached at all on
hardware at this moment, or whether some earlier divergence in ares put it there with three sprites
still registered. The double `AddPrim` was traced to the game's own instructions, not to a wrong
instruction result, and no wrong result was found. That question is open and is *not* what freezes
the machine.

### 22. `CPU::waitDMA()` is unbounded, so any runaway DMA is a total freeze

`ares/ps1/cpu/cpu.cpp:80-82` and `ares/ps1/dma/channel.cpp:102-109` — **verified**, source read and
the mechanism exercised on 2026-08-14. **A fix is applied in this working tree**, `DECISIONS.md`
§2d D4. This is the same defect class as the Mega Drive Z80 bus wait fixed here as `bca9c5dfc`: a
wait with no upper bound, on a condition the emulated machine can hold forever.

```cpp
auto CPU::waitDMA() -> void {
  while(dma.active()) step(16);
}
```

`DMA::Channel::transferChain()` bounds one call at `0x1000` words (`channel.cpp:223`, `:247`) but only
clears `enable` when the address has bit 23 set (`:271`), so a list that never reaches an end code
leaves the channel enabled. `Channel::step()` then sets `state = Idle` and returns, `DMA::main()`
loops straight back in and sets `state = Running` again — **with no `Thread::step` between the two**,
so `dma.active()` is never observably false and `waitDMA()` can never return. The bounded walk keeps
the emulator responsive; it does not keep the machine alive.

**What hardware does.** psx-spx, *CPU Operation during DMA*, verbatim:

> Basically, the CPU is stopped during DMA (...). However, the CPU operation resumes during periods
> when DMA gets interrupted (ie. after SyncMode 1 blocks, **after SyncMode 2 list entries**) (or in
> SyncMode 0 with Chopping enabled).

So chopping is not the mechanism here — SyncMode 2 yields between entries unconditionally, and the
game's own CHCR confirms chopping is off on channel 2 (`chop(en=0 dma=0 cpu=0)`, against channel 3
which does enable it). **An unterminated linked list is not fatal on hardware.** It costs the machine
its rendering, not its CPU: IRQs, timers and other DMA channels keep running, and the game either
recovers or times out.

Other emulators all handle this and document games that depend on it. DuckStation slices the walk at
`dma_max_slice_ticks` (1000) and halts for `dma_halt_ticks` (100) before resuming
(`src/core/dma.cpp`), mednafen drives channels from a scheduled `DMA_Update` under a clock budget,
PCSX-ReARMed runs Brent's cycle detection over the chain and bails, and no\$psx added an
endless-link-chain pre-check in v1.9 (2014-05-28). DuckStation's *Difficult to Emulate Games* wiki
names the titles: `Deadheat Road` — "Will hang emulators (if they don't properly handle infinite LLs)
or the game will time out" — plus `Hot Wheels Turbo Racing`, `Tekken 2`, and `World Cup Golf -
Professional Edition`, which "expects other DMA channels to run while an infinite linked list chain
is running". **ares will freeze on all of them today.** `Syphon Filter` is entry 21 and is only the
case that was traced.

**The fix applied here** is ten lines in `Channel::step()`, mirroring the SyncMode 0 chopping block
immediately above it: when a SyncMode 2 walk stops on the word bound with the channel still enabled,
hand the bus back for `0x1000` clocks — one CPU clock per word walked — while `state` is `Idle`, so
`waitDMA()` sees a gap. A list that reaches an end code cleared `enable` before that point and is
untouched. Deliberately *not* a general DMA timing model: it does not touch `transferChain()`, does
not change the word bound, adds no state, and leaves the save state at 4,019,632 bytes.

**Measured across the four control discs**, 2,500 frames each, before and after built back to back:
`Asteroids (USA)` and `WipEout (USA)` never reach the word bound, and their traces and their entire
save states are **byte-identical**. `Crash Bandicoot` reaches it 442 times and `The Raiden Project`
2,636 times over 2,500 frames, and both come out with **identical distinct-frame counts and identical
lit fractions in every window** — 85/63/3/21/68 and 85/63/2/18/354 respectively — differing only in
audio energy in the fourth decimal and, for `Crash`, 28 pad polls in one 500-frame window. That is
sub-sample phase, not behaviour. Save-state size is 4,019,632 on all four discs in both arms and
reloads clean.

**What this entry owes** if it is sent on its own: a title from the DuckStation list — `Tekken 2` is
the cheapest — booted on stock ares to show the freeze without needing `Syphon Filter`'s 3,241-frame
run. The `0x1000` window is an approximation of per-entry yielding chosen to be invisible to the
control discs, not a measured hardware ratio, and the entry should say so.

---

## Open — reproduced, cause not found. Do not send these yet

A 126-disc PlayStation library was swept on 2026-08-13, 9000 frames per disc, scored on whether the
display ever leaves the BIOS's 640x480. **118 booted; with entry 17 applied, 119.** Six discs from
that sweep remain, recorded here so the investigation can restart from evidence instead of from
scratch. **None of them has a diagnosis, so none of them is a pull request.** They are ares defects
rather than the port's only in the weak sense that nothing implicates the port — see the caveat at the
end.

> **Read that number correctly: 118 is "started", not "playable", and the gap is known to be real.**
> The sweep presses no buttons and scores one thing — did the picture ever leave the BIOS resolution.
> A title that boots, reaches its menu and then dies at the first level load scores as a pass.
> **`Crash Bandicoot` was the confirmed instance**: it cleared the sweep and then hung at a level load,
> on ares' shipped macOS build as well as here. It is now **entry 18**, diagnosed and fixed, so it is
> no longer listed below — but the shape of it is the point. The true playable count is lower than 118
> by an unmeasured amount, and no conclusion in this section should be read as "the other 118 are
> fine". Measuring it properly needs an input-driving harness, which the sweep did not have. Crash
> also raises the odds that some of the six below are input-reachable defects rather than boot
> failures.

### 23. A macroblock costs 6,000 clocks, so a 320x240 MDEC frame takes three NTSC frames

`ares/ps1/mdec/decoder.cpp:90-92` — **verified**, source read, mechanism traced to the game
instruction that pays for it, and both arms measured on 2026-08-15. **A fix is applied in this
working tree**, `DECISIONS.md` §2d D5. This is the root cause of Open A below, and Open A's own
"sharpest next experiment" was run first and came back negative — see *What the ISR observes*.

```cpp
auto MDEC::decodeBlock(s16 block[64], u8 table[64]) -> bool {
  //FIXME: implement proper decode timing, FF9 breaks if we decode too fast
  //but too slow and we drop frames
  step(1000);
```

The `FIXME` is upstream's own, and it is right. psx-spx (*MDEC Decompression*) gives the decode
shape ares implements exactly — `decode_colored_macroblock` is six `rl_decode_block` calls, Cr, Cb
and four Y — so a 15-bit colour macroblock costs **6,000 clocks** here. A 320x240 frame is 300
macroblocks: **1,800,000 clocks, 53.1 ms at 33.8688 MHz, three and a bit NTSC frames.**

**What hardware does.** psx-spx does not say: *DMA Transfer Rates* lists DMA0 and DMA1 at 1 clk/word
"plus whatever decompression time" and then states plainly, "MDEC decompression time is still
unknown (may vary on RLE and color/mono)". So there is no nocash figure to check against. The
reference that does carry one is **DuckStation**, which charges `TICKS_PER_BLOCK * 6` = **2,688
clocks per macroblock** — `src/core/mdec.cpp:32` for the constant, `:584` and `:647` for the two
macroblock paths that schedule the copy-out at it. ares is **2.23x slower than that.**

**What that costs, traced to the instruction.** `Syphon Filter (v1.0)` uploads each decoded frame to
VRAM as twenty 16x240 `GP0(A0h)` strips, chained by the GPU-DMA completion callback at `0x8013df00`;
when the twentieth strip retires the callback sets a done flag at `0x80141a2a`. The player then
calls a sync routine at `0x8013e7bc`:

```
0013e7dc  lbu   v0,[80141a2a]      ; read the flag -- once
0013e7e4  bne   v0,0,0013e834      ; already done: return
0013e7f0  ori   a0,a0,$4240        ; a0 = 1,000,000
0013e7f4  addu  a1,0,0             ; a1 = 0, and nothing writes it again
0013e7fc  sltu  v0,a0,v0
0013e800  bne   v0,0,0013e810      ; the only exit is the counter
0013e804  addiu v1,v1,$1
0013e808  beq   a1,0,0013e7fc      ; always taken
0013e810  lbu   v0,[80141a2a]      ; re-read, after the delay
```

**The flag load is hoisted out of the loop.** This is not a poll that ends when the upload finishes;
it is a flat 1,000,000-iteration penalty, paid in full whenever the sync is entered one strip early.
With `step(1000)` the game loses that race from its third video frame on: the first two uploads
retire before the sync call and cost nothing (MDEC commands at video frames 1808 and 1813), the
third is entered with **18 of 20 strips retired** and pays the penalty. Of the 4,971,051 instructions
retired across frames 1821-1830, **910,090 are that one `addiu` — 91% of the window is the delay.**
Every cycle after it pays the same: MDEC commands land at 1831, 1843, 1854, 1865, a cadence of
**11-12 NTSC frames — 5 fps against the 15 fps the stream is authored at.**

**And that is where the lost sectors come from.** While the CPU sits in the delay the player's CD
driver stops arming `BFRD` (`1F801803`.0 bit 7). The drive's INT1s are raised, acknowledged, and
declined: seven consecutive sectors at LBA 171702-171709, seven more at 171733-171740, **47 of 148
across the FMV.** `Disc::Drive::clockSector()`'s unconditional `fifo.data.flush()` destroys them, the
bitstream handed to the MDEC for video frame 7 is short, it decodes 68 of 300 macroblocks, DMA1 is
left `enable=1` with 28 blocks outstanding against an MDEC that can never satisfy `canReadDMA()`, and
the title screen is never reached. **Everything in Open A below is downstream of this one constant.**

**What the ISR observes — Open A's experiment, run, and negative.** The dead INT1s at frames
1828-1830 and the healthy ones at 1827 are **identical register for register**, in both directions:

```
healthy f=1827 lba=171700          dead f=1828 lba=171703
R 1800.0 = 78                      R 1800.0 = 78
R 1803.1 = e1  (INT1 pending)      R 1803.1 = e1
R 1801.1 = 22  (status)            R 1801.1 = 22
W 1803.1 = 07  (acknowledge)       W 1803.1 = 07
W 1803.0 = 80  <-- BFRD armed      (absent)
```

The status byte is `0x22` at every one of the 148 sectors — error 0, motorOn 1, seekError 0, idError
0, shellOpen 0, reading 1, seeking 0, playingCDDA 0 — which is what psx-spx's *Status Code (stat)*
requires of a drive streaming data, and `Disc::status()` composes it from those bits and no others.
The interrupt flag register, the response FIFO length and contents, the index register and the whole
acknowledge sequence all match. **Nothing ares reports at INT1 is wrong**, and the entry-18 staging
never engages here either — `irq.pending()` is false at all 148. The driver declines on its own
software state, and the reason it is in that state is the delay above.

**Both arms, measured back to back, same tree minutes apart.** With `step(448)` — 2,688 clocks per
colour macroblock, DuckStation's figure — **every** FMV frame decodes 300 macroblocks instead of 68,
the cadence becomes a steady 4 NTSC frames (15 fps), the 1,000,000-iteration delay never runs again
(every sync call finds the flag already set), and sectors destroyed inside the FMV fall from **47 to
0** — the two 280-byte partials that remain sit at LBA 171642-171643, before the stream proper, and
are present in both arms. The game then plays the 989 Studios logo where the 64x240 garbage block
used to be, the Eidetic logo, the whole intro cinematic, and **reaches and holds its title screen.**

**This is not a `Syphon Filter` defect.** Any title whose FMV player synchronises on the upload
finishing inside its own frame is exposed to the same race; `Syphon Filter` is only the one that was
traced, because its penalty is a hard-coded million and therefore impossible to mistake for
something else.

**One asymmetry to state.** ares charges per block and DuckStation per macroblock, so at 448 a
*monochrome* macroblock — one block — costs 448 here against DuckStation's flat 2,688. Only 4bpp and
8bpp output reaches that path (psx-spx, `decode_monochrome_macroblock`), which DuckStation's own
source calls "basically never used". Colour, the only depth any FMV uses, matches exactly.

### The Syphon Filter cluster — four discs, and the only real pattern

| disc | symptom |
|---|---|
| Syphon Filter (v1.0) | plays **419 frames** of intro, switches to 368x240, then black forever |
| Syphon Filter 2 (Disc 1) | black, never leaves 640x480 |
| Syphon Filter 2 (Disc 2) | identical to Disc 1 |
| Syphon Filter 3 | identical |

**Every Syphon Filter disc in the library fails, and they are half of all remaining failures.** Same
developer lineage (Eidetic/989). The gradient is the useful part: SF1 gets far enough to run its own
code and change video mode before dying, SF2 and SF3 never leave BIOS video mode at all. **That is
consistent with two distinct bugs, not one**, and it means SF1 is the better one to trace — it fails
late, so the trace has a known-good prefix to bisect against.

They emit *exactly* the same debug warnings as discs that boot perfectly, so there is no log
signature to work from. This needs an execution trace, in the shape that solved entry 17: find where
the CPU ends up, find what it last read, work backwards.

### Three unrelated singles

| disc | symptom | note |
|---|---|---|
| CTR — Crash Team Racing | hangs on the "SCEA Presents" card | fails earliest of the three |
| Dukes of Hazzard — Racing for Home | reaches 320x240, then black | gets further than CTR |
| Mortal Kombat Trilogy (v1.0) | wedges on the intro FMV in headless runs — no disc command after frame 1,334, pixel-identical frames 3,500-6,999 | **but boots and plays in a browser**. Power-on RAM is seeded from `Random::Entropy::High`, which varies run to run **only with Homebrew Mode off**, its default; with it on, `ares/ps1/system/system.cpp:131-133` re-seeds from a constant and a run is bit-reproducible per binary (entry 20). Settle which of the two applied before calling this nondeterministic. Its runaway read is entry 16, which is the *consequence*, not this |

No story was manufactured to connect these. They look unrelated and are recorded as unrelated.

### What has been ruled out, by experiment rather than argument

- **Region.** 125 of 126 discs are NTSC-U against the matching US BIOS. Re-running every failure
  against the PAL and the NTSC-J BIOS rescued **none** of them.
- **Disc format and cue parsing.** Every disc in the library is `MODE2/2352` — there is no format
  variation to correlate with. **Zero discs failed to load**: every cue parsed, every track file
  staged, `load()` succeeded every time, no module crashed, peak heap 994 MB. Entry 11's
  `MODE2/2336` defect is real but is not reachable from this library.
- **Size, track count, single vs multi-track, publisher, year.** All show the same distribution among
  failures as among the 118 that boot.

### Two method notes worth more than the list

**One frame budget is not enough to call a hang.** The first pass ran 4000 frames — chosen by
measurement, since all six known-good discs leave 640x480 between frames 1100 and 1600 — and reported
121 booting. Re-running the whole library at 9000 exposed 18 discs producing no new frames between
4000 and 9000. Frame dumps resolved each by eye: **15 were waiting for a button press** (the probe
presses none — disc-swap prompts, "Press Start", language select) and 3 were real hangs. Without the
second pass the answer would have read 121/5 instead of 118/8.

**The reference cross-check was not run on these six.** The `-DARES_PS1_COTHREAD` build was in use by
another job at the time. So "ares' defect, not the port's" rests on the entry 17 precedent and on the
uniform character of the failures — silent hangs, no module errors — and **not** on direct
measurement. Running each of the six against the reference build is the cheapest next step and should
come before any of them is called upstream's.

---

### Open A — `Syphon Filter`: the intro FMV deadlocks the MDEC pipeline, and the title screen is never reached

Reproduced on this tree **and on stock `ares/ps1` with every local change reverted**, so it is
upstream's and neither the entry 18 disc fix nor the SyncMode 2 DMA fix causes it. Native, NTSC-U,
`scph5501`, no buttons pressed. Frame numbers are video frames delivered from power-on.

**What a person sees.** BIOS logos to frame ~1305, then black. **No 989 Studios logo, no title
screen, ever.** At frames 1877-1908 a 64x240 block of garbage appears at the left edge, on alternate
frames only — this is the user-reported "scrambled tiles". The game then runs its intro cinematic and
drops into an attract loop (cinematic, mission briefing, playable demo, repeat) which on this tree
still runs at frame 14000. On stock the machine additionally freezes at ~3400; that freeze is the
`waitDMA` defect the SyncMode 2 fix removes, and it is downstream of everything described here.

**Mechanism, traced end to end.**

1. The intro FMV uploads each video frame to VRAM as twenty `GP0(A0h)` strips of 16x240. Video
   frames 1-5 are complete: MDEC command `words=1824`, exactly 300 macroblocks, 48 halfwords of
   trailing padding, twenty strips uploaded.
2. Video frame 7 (MDEC command at frame 1865) decodes **68 of 300 macroblocks**. An independent
   structural parse of the same captured bitstream, written from the psx-spx RLE description, agrees
   exactly — 300 for a good frame, 68 for this one. **ares' MDEC decoder is faithful; its input
   bitstream is short.** Only four strips reach VRAM, at x=0..63 — exactly the 64x240 garbage, sitting
   in the back buffer at VRAM `(0,240)-(63,479)` while the front buffer stays black, which is why it
   flashes on alternate frames.
3. The pipeline then deadlocks permanently: DMA channel 1 (MDECout) is left `enable=1` with 28 blocks
   outstanding while the MDEC is Idle with an empty output FIFO. `MDEC::canReadDMA()` requires
   `fifo.output.size() >= 32`, which can never again become true, so the channel never runs. The game
   waits ~43 frames, tears its screen down, and advances its state machine — which is why the title
   screen never appears.
4. The bitstream is short because **the CD sectors carrying it were destroyed before the host read
   them.** Across the FMV window 47 of 148 sectors arrive on top of a sector the host has not drained:
   31 completely unread (2048 bytes discarded), 14 with only their 32-byte STR header read.
   `Disc::Drive::clockSector()` calls `fifo.data.flush()` unconditionally, so those bytes are gone.
   The lost sectors at LBA 171703+ are precisely the chunks of the STR frame that then fails to decode.

**Where it is not.** Not the entry 18 staging slot: `irq.pending()` is false for every one of these
sectors, so the staged path never engages and nothing is dropped by its one-deep guard (measured: 0
drops). Not sector delivery order: LBAs are contiguous, audio and video interleaved as authored. Not
the drive rate: ~128 sectors/s, slightly *under* double speed. Not a CPU stall: during the loss window
the CPU retires ~530k instructions per frame, more than its neighbours, with `waitDMA` at 0 cycles.

**The one unexplained step, and the sharpest next experiment.** At frames 1828-1830 the game issues
**zero** buffer-read requests — `bfrd += 0`, `bytesRead += 0` — for three consecutive frames, and
seven sectors die. Yet every one of those INT1s is both **raised and acknowledged** (`int1Raised += 3`,
`int1Acked += 3` per frame). So the game's ISR runs, acknowledges, and declines to read. The next
experiment is to find what it inspects before deciding: instrument the response FIFO byte handed to
each INT1 (`queueResponse(ResponseType::Ready, {self.status()})`) and compare `Disc::status()` bit for
bit against psx-spx across the healthy frames and the three dead ones. If the status byte is wrong,
that is the root cause and the fix is one line. If it is right, the game is deliberately dropping
sectors its ring cannot hold, real hardware would drop them too, and the defect to fix is instead
step 3 — the MDEC/DMA1 deadlock, which is what turns a dropped video frame into a dead FMV.

**Second, independent defect visible in the same trace.** psx-spx (*Sector Buffer*) records that the
controller keeps **two** accessible sectors, the oldest and the newest, and that software must process
INT1 before further sectors arrive. ares keeps one and flushes it unconditionally. Whatever the
outcome of the experiment above, the single-sector model is narrower than hardware and should be
widened; note that two buffers alone would not have saved seven consecutive sectors here.

### Open A — closed, on 2026-08-15, by entry 23

Open A is **resolved and no longer open**; the paragraphs above are left exactly as they were written
because every measurement in them still holds. What they were missing is one level further up.

The experiment Open A asked for was run first and came back **negative**: the status byte, the
interrupt flag register, the response FIFO and the whole acknowledge sequence are identical between
the healthy INT1s and the three dead frames, so nothing ares reports at INT1 is wrong. Entry 23 has
the side-by-side trace. Open A's second arm — "then the defect to fix is the MDEC/DMA1 deadlock" —
turned out to be a symptom too: with the MDEC decoding at DuckStation's rate the bitstream is never
short, the MDEC never stops 232 macroblocks early, and DMA1 is never stranded. **The deadlock has
nothing left to trigger it**, so no fix was written for it and none is owed.

What actually happens is the third possibility Open A did not name: the game declines those sectors
because it is 91% of the way through a **hard-coded 1,000,000-iteration delay** it entered when its
VRAM upload had not finished by the frame it expected, and the upload had not finished because a
320x240 MDEC decode costs 53 ms here instead of 24. Entry 23 has it.

**The two-sector buffer note above stands, unchanged and still unfixed.** It was correct that two
buffers would not have saved seven consecutive sectors, and it is still true that ares' single
destructive buffer is narrower than the hardware psx-spx describes. It is now the only part of Open
A that is still owed, and it is owed on its own merits rather than as a `Syphon Filter` fix — with
entry 23 applied this disc destroys **no** sectors inside the FMV, so it can no longer serve as the
evidence for it. A different title will have to.

---

### 24. The CD-XA sample queue is eight sectors deep, so the drive runs a second ahead of the speaker

`ares/ps1/disc/cdxa.cpp:13` and `disc.hpp:227`. Confidence: mechanism **verified** — source read and
both halves measured 2026-08-16. Fix and measurements **verified** — built and run natively, both arms
from one tree minutes apart, nine controls unchanged.

**The queue is the bug.** `Disc::CDXA` decodes a whole XA sector into `queue<s16[4032 * 8]> samples`
and `Disc::main()` drains it one sample per 37800 Hz tick. Eight sectors is **0.853 seconds** of
audio. Nothing bounds it, nothing flushes it, and the write side drops the *newest* samples when it
is full:

```cpp
    for(u32 channel : range(Step)) {
      if(!samples.full()) samples.write(output[index + channel]);
    }
```

So an interleave that delivers the selected channel faster than 37800 Hz can drain it does not lose
the surplus — it **converts the surplus into standing latency**, and then chops each sector in half
to fit.

**`Syphon Filter (v1.0)` is the title that shows it, and its speech is what is affected.** Read off
the disc image directly, independent of ares: at LBA 49560-49759 the game streams file 1 as **16
interleaved channels of mono, 18900 Hz, 4-bit XA**, the selected channel appearing every 16 sectors.
A mono 18900 Hz sector is 4,032 samples = 213.3 ms; 16-channel interleave at the double speed the
game selects (`Setmode 0xc8`) delivers one every **106.7 ms**. That is twice the rate the format
asks for — psx-spx's interleave table gives 1/32 for 18900 Hz mono at double speed — so half of it
was always going to be discarded. What ares does with the surplus is the defect.

Measured over 4,000 frames (66.9 s) seeded into the Washington Park demo:

| | before | after |
|---|---|---|
| decoded XA samples dropped mid-sector | **749,952** | **0** |
| deepest the queue ever got | 32,256 samples = **0.853 s** | 8,064 = **0.213 s** |
| queue depth when a sector arrived — mean | 10,825 = **0.286 s of standing latency** | 678 = **0.018 s** |
| queue depth when a sector arrived — worst | 28,224 = **0.747 s** | 4,032 = **0.107 s** |
| accepted 18900 Hz sector cadence | 106.7 ms (every one, half-truncated) | **213.3 ms — one whole sector, gapless** |

Before the fix the queue sat pinned at 28,224 samples for the whole 25-second speech stream: every
sector was cut in half on the way in, and everything that survived was heard **three-quarters of a
second late**. A stream the game had already moved on from kept playing for that long.

**The fix is what the reference does.** DuckStation refuses the sector when the audio FIFO is still
ahead, rather than queueing it — a low watermark, a whole-sector drop, and the decode skipped so the
ADPCM predictor is not advanced by a sector nobody hears (`src/core/cdrom.cpp`, fetched 2026-08-16).
The same shape here is one line at the top of `clockSector()`:

```cpp
  if(samples.size() > 8) return;
```

**The predictor half of that placement is correct but, on this disc, unmeasurable — stated so nobody
cites it as evidence.** `decodeBlock` mutates `previousSamples[4]`, which is machine state
(`disc/serialization.cpp:39`) and is never reset per sector, so a decoded-then-discarded sector would
carry filter history into the next audible one. Returning before `decodeADPCM` prevents that. But an
arm that refuses the same 96 sectors and decodes them anyway, suppressing only the queue writes, is
**bit-identical over 4,000 frames** — audio `c0ea1e41`, state `aae18343` in both. Reading the disc
directly says why: all 10,739 of its 18900 Hz mono XA sectors open their first sub-block with filter
index 0, so there is no history to inherit, while the 37800 Hz stream on the same disc uses filters
1-3 on 97% of its sector starts. The placement is free and strictly more correct; it is not what
fixes this title, and a disc whose mono stream used a non-zero opening filter is where it would show.

Eight samples is 0.2 ms — slack for scheduling jitter, not a buffer. A stream whose interleave
matches its own rate lands on an empty queue every time and is never touched by it.

**Blast radius, measured.** Nine control discs, both arms, from one seeded state each: `Crash
Bandicoot`, `Raiden Project`, `Asteroids (USA)`, `WipEout (USA)`, `Wing Commander III (Disc 1)`,
`Metal Gear Solid (Disc 1)`, `Xenogears (Disc 1)`, `Novastorm (Disc 1)`, `CTR - Crash Team Racing`.
**Every one is bit-identical on audio hash and on a 4,019,632-byte save state**, and on all nine the
new line drops nothing at all — `xaDropped` is 0 in both arms and `xaMaxDepth` is unchanged. Four of
them stream XA (`Asteroids` 2,927,232 samples, `WipEout` 3,265,920, `CTR` 1,483,776, `Xenogears`
1,177,344) and none of them over-supplies, so none reaches the new path. The only disc in the set
that does is `Syphon Filter`.

**No state change.** No new field, no `SerializerVersion` bump; the save state stays 4,019,632 bytes
and was loaded across builds in both directions this session. The layout is untouched; one
*serialized value* does move, and it is the point of the change rather than a side effect — a refused
sector no longer reaches `monaural = !stereo` (`disc/cdxa.cpp`, serialized at
`disc/serialization.cpp:37`), exactly as it no longer reaches the decode.

---

### 25. `ENDX` is not cleared when a voice is keyed on

`ares/ps1/spu/voice.cpp:109-119`. Confidence: mechanism **verified** by source read and by count;
**severity unmeasured**, because no title checked here reads the register.

`SPU::Voice::keyOn()` resets the current address, the sample flags, the last samples, the phase and
the volume — and leaves `endx` alone. psx-spx describes 1F801D9Ch as "0=Newly Keyed On, 1=Reached
LOOP-END", and DuckStation clears the voice's ENDX bit inside its key-on (`src/core/spu.cpp`, fetched
2026-08-16). In ares the bit is only ever cleared by a CPU write to 1F801D9Ch.

**Measured:** across 4,000 frames of `Syphon Filter` gameplay, **1,960 of 1,960 key-ons landed on a
voice whose `endx` was already 1**. Every one of them should have read back 0 and reads back 1.

**Why it is filed and not fixed:** this run's title never looks. Over the same window `Syphon Filter`
made **0** reads of 1F801D9Ch, 0 of KON, 0 of KOFF and 0 of SPUSTAT — its sound engine tracks voice
liveness by polling each voice's current ADSR volume at 1F801C0Ch instead, 24 voices on every one of
its 2,406 120 Hz timer ticks. A title that polls ENDX to find a finished voice would see every voice
permanently finished, which is why this is worth sending even though it changes nothing here.

---

### 26. Loop-end without loop-repeat does not load the repeat address

`ares/ps1/spu/voice.cpp:37-44`. Confidence: mechanism **verified** by source read against
DuckStation; **no observable effect found**, and one is not expected.

On loop-end ares sets `endx`, and then either jumps to `adpcm.repeatAddress` (loop-repeat set) or
calls `forceOff()` (clear). DuckStation sets `current_address = repeat_address` in **both** branches
and then forces the voice off (`src/core/spu.cpp`, fetched 2026-08-16). The divergence is unobservable
in ares today because the only thing that restarts an off voice is `keyOn()`, which overwrites
`currentAddress` from `startAddress` — but it is a real difference in the state a save state carries,
and it costs one line to align. Severity: very low. Listed because this run was asked to filter
nothing out.

---

### 27. Reverb SPU-RAM accesses cannot raise IRQ9 — shared with the reference, and stated for completeness

`ares/ps1/spu/reverb.cpp:97,102`. Confidence: mechanism **verified**; **this is not an ares-only gap**.

`SPU::Reverb::read`/`write` go straight to `spu.ram.readHalf`/`writeHalf`, bypassing
`SPU::readRAM`/`writeRAM` and therefore the IRQ address compare. psx-spx says accesses in the reverb
area do trigger IRQ9. DuckStation does not implement it either (`src/core/spu.cpp`,
fetched 2026-08-16), so a patch here would be putting ares *ahead* of the reference rather than
fixing a regression.

**Measured:** 35,387,736 reverb reads and 11,795,912 reverb writes across 4,000 frames of `Syphon
Filter`, of which **0** would have matched the IRQ address — that title never enables the SPU IRQ.
The capture-buffer writes, by contrast, do go through `writeRAM` (`spu/capture.cpp:1-4`) and do raise
it, which is correct. Severity: low, and it should be sent as an accuracy improvement rather than a
bug fix.

---

## Not upstream's — do not send these

**`Thread::EntryPoints()` growing across loads is this branch's, and is now fixed here.** An entry
is pushed by every `Thread::create` and erased only when that cothread is first entered; the web
build advances most chips by plain calls, so their cothreads are entered only during a synchronized
save and their entries survive every load. Measured on the PC Engine: six sequential loads gave
3, 6, 9, 12, 15, 18 pending entries. The same six loads against the `-DARES_PCE_COTHREAD` reference
— native semantics, every thread entered every frame — gave **0 every time**, which is what says the
accumulation needs this branch's arrangement and does not reach upstream. The fix (erase the stale
entry for this handle in `create()` and `restart()`, both of which have just called `co_derive`) is
`PLATFORM_WEB`-gated here; `DECISIONS.md` §8.16 has the measurements.

Entry 8 above is the part of the same code that **is** upstream's: `destroy()` leaving an entry
behind is reachable natively and is a use-after-free, not a growing vector. Keep the two separate if
either is ever sent.
