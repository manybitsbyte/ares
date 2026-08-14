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
  entries 1-10 on 2026-08-12, entries 11-17 on 2026-08-13. `recorded` means it was established
  earlier in the project and is carried forward from `DECISIONS.md` without being re-checked today.

**Where the newest entries stand, for working the queue.** Confidence and *readiness to send* are not
the same thing: every entry below is source-verified, but the first rule above asks for a native
reproduction, and three of the compact-disc and PlayStation entries do not yet have one.

| | ready to send | fix written? | what is owed first |
|---|---|---|---|
| **17** `SIO1_BAUD` undecoded | **yes — reproduced on ares' shipped desktop installer** | **applied here**, §2d D2 | capture the release version; **re-add the `serialization.cpp` line** |
| **14** `MemoryCard` pak deref | yes — native repro program, segfault, exit 139 | one-line guard, 42 sites already use it | — |
| **11** `MODE2/2336` track dropped | yes — cue parses two ways, both shown | yes, two lists must change together | — |
| **12** `loadSub` debug print | yes — unconditional in release, reading it is the proof | yes, delete four lines | — |
| **13** `CD::Session` on the stack | yes, and it belongs with 12 | follows from 12 | — |
| **15** CD-XA half-rate stereo | not yet | **applied here**, §2d D1 | boot `Asteroids (USA)` on a desktop build, ~40 s, listen |
| **16** unbounded data read | not yet | half of one — see the entry | establish what hardware does past the end of a data track |

Entry 17 is the strongest item in the file: a commercial disc that will not boot, one undecoded
register, a two-instruction trace that shows the whole failure, a control disc that is unaffected,
and a 126-disc sweep showing exactly one title reaches the register at all. Send that one first.

**Two of these are already applied in this working tree** — 15 and 17, the only changes on the branch
that alter emulated behaviour. `DECISIONS.md` §2d states them with before/after measurements. They
are unguarded and upstream-shaped, so sending them is a matter of lifting the hunks out, not of
extracting them from port machinery. **Entry 17's upstream patch needs one line this tree omits**;
the entry says which and why.

**Six discs still fail with no diagnosis at all.** They are recorded under *Open* near the end of
this file rather than as entries, because a symptom is not a defect report.

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

## Open — reproduced, cause not found. Do not send these yet

A 126-disc PlayStation library was swept on 2026-08-13, 9000 frames per disc, scored on whether the
display ever leaves the BIOS's 640x480. **118 booted; with entry 17 applied, 119.** These are the
six that remain, recorded here so the investigation can restart from evidence instead of from
scratch. **None of them has a diagnosis, so none of them is a pull request.** They are ares defects
rather than the port's only in the weak sense that nothing implicates the port — see the caveat at
the end.

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
| Mortal Kombat Trilogy (v1.0) | wedges on the intro FMV in headless runs — no disc command after frame 1,334, pixel-identical frames 3,500-6,999 | **but boots and plays in a browser**, so it is nondeterministic; power-on RAM is seeded from `Random::Entropy::High`. Its runaway read is entry 16, which is the *consequence*, not this |

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
