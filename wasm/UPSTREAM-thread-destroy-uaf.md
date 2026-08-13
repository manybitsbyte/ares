# `Thread::destroy()` frees a cothread and leaves its entry point pending

A use-after-free in upstream ares, found while porting the PC Engine to WebAssembly. It has nothing
to do with the web build: it needs no Emscripten, no browser, and no part of this branch to happen.
This file is the standalone write-up so it can be investigated and sent upstream on its own.

Duplicated as entry 8 in `UPSTREAM.md`. That file is the index; this one is the detail.

- **File:** `ares/ares/scheduler/thread.cpp`
- **Function:** `Thread::destroy()`
- **Class:** use-after-free — a live cothread runs a destroyed object's entry point
- **Found:** 2026-08-12
- **Status:** mechanism proven on this host; the desktop-ui trigger route was read, not driven

---

## The code

Upstream's text. This branch compiles exactly this natively — the fix it carries is behind
`#if defined(PLATFORM_WEB)`, so the native build still has the defect.

```cpp
inline auto Thread::destroy() -> void {
  scheduler.remove(*this);
  if(_handle) co_delete(_handle);
  _handle = nullptr;
}
```

The two functions that make it matter:

```cpp
inline auto Thread::create(double frequency, std::function<void ()> entryPoint) -> void {
  if(!_handle) {
    _handle = co_create(Thread::Size, &Thread::Enter);
  } else {
    co_derive(_handle, Thread::Size, &Thread::Enter);
  }
  EntryPoints().push_back({_handle, entryPoint});
  ...
}

inline auto Thread::Enter() -> void {
  for(u32 index : range(EntryPoints().size())) {
    if(co_active() == EntryPoints()[index].handle) {
      auto entryPoint = EntryPoints()[index].entryPoint;
      EntryPoints().erase(EntryPoints().begin() + index);
      while(true) {
        scheduler.synchronize();
        entryPoint();
      }
    }
  }
  struct ThreadNotFound{};
  throw ThreadNotFound{};
}
```

`EntryPoints()` is a function-local `static std::vector<EntryPoint>`, declared
`ares/ares/scheduler/thread.hpp:16`. An `EntryPoint` is `{cothread_t handle, std::function<void()>
entryPoint}` — and that `std::function` is a bound `this`.

---

## Why it is a bug

Four steps, each independently checkable:

1. **`create` and `restart` push; only `Enter` pops.** An entry is removed exactly when its cothread
   is *first entered*. A thread destroyed before it is ever entered leaves its entry behind.
2. **`destroy()` does not remove it.** It calls `co_delete(_handle)` and nulls the member. The
   pending entry still names the freed address.
3. **The address comes straight back.** `co_delete` returns the block to `malloc`, and the next
   `co_create` of the same size gets it. **Every cothread in the tree is `Thread::Size`**, so this is
   the ordinary case, not an unlucky one.
4. **`Enter()` takes the first match, and the stale entry was pushed first.** It scans from index 0.
   The dead entry is earlier in the vector than the one `create` just pushed, so the *new* thread
   runs the *destroyed* thread's entry point — an `std::function` whose bound `this` points at an
   object that no longer exists.

The infinite `while(true)` loop inside `Enter` means it never returns to try the correct entry. The
wrong object is driven for the life of the thread.

---

## Evidence

**Proven by execution on this host** (macOS arm64, so `libco/aarch64.c`), at the 131072 bytes a
64-bit `Thread::Size` asks for:

```
first  co_create -> 0x7c1400000
second co_create -> 0x7c1400000   same address: YES
```

To re-run it, the check is this shape — link against `libco` and call it directly:

```c
// co_create, co_delete, co_create again at the same size; print both addresses.
cothread_t a = co_create(131072, dummy);
co_delete(a);
cothread_t b = co_create(131072, dummy);
printf("%p %p %s\n", a, b, a == b ? "SAME" : "different");
```

**Established by reading the source, not by driving the GUI** — the desktop-ui trigger route below.
It is four files read on 2026-08-12; nobody has clicked through it. Treat it as the most likely
trigger, not as a confirmed repro.

---

## Native reproduction route (read, not driven)

Any path that destroys a thread *before its first entry* and then creates another. The shortest one
found in `desktop-ui`, all native, no web build involved:

1. Set `settings.boot.debugger` or `settings.boot.awaitGDBClient`. Either makes `Program::load` boot
   **paused** (`desktop-ui/program/load.cpp:124-131`), so the run loop never runs a frame
   (`desktop-ui/program/program.cpp:88`) and **no cothread is ever entered**. This is the part that
   matters — it is what leaves an entry pending.
   `settings.input.defocus == "Pause"` opens the same window without the debugger settings.
2. Load a Mega Drive game with a Fighting Pad seated. Its constructor calls `Thread::create`
   (`ares/md/controller/fighting-pad/fighting-pad.cpp:17`).
3. Still paused, pick a different device from System → Controller Port 1. The handler is
   `port->disconnect(); port->allocate(name); port->connect();`
   (`desktop-ui/presentation/presentation.cpp:943-945`) — the pad's `Thread::destroy()`
   (`fighting-pad.cpp:21`) immediately followed by the new device's `co_create` of the same size.
4. Unpause. The new device's first entry runs `FightingPad::main` on the deleted pad.

Under ASan this should surface as a heap-use-after-free at the first `synchronize()` inside the
new thread. That is the check worth running first — it converts the read route into a driven one.

---

## The fix

One statement, in the one place that knows the handle is going away:

```cpp
inline auto Thread::destroy() -> void {
  scheduler.remove(*this);
  if(_handle) {
    std::erase_if(EntryPoints(), [&](const EntryPoint& entry) { return entry.handle == _handle; });
    co_delete(_handle);
  }
  _handle = nullptr;
}
```

The entry belongs to the handle, so it should be retired with the handle.

**Send the ungated version.** This branch carries the same statement under `#if
defined(PLATFORM_WEB)` only to honour its own no-native-behaviour-change rule — that gating is a
property of the port, not of the fix, and must not ride along on the pull request.

Needs `#include <algorithm>` if `std::erase_if` is not already reachable in that TU.

---

## Open questions before sending it

- **Drive the repro under ASan.** Step 3 above is the whole claim and it has not been executed. If
  the GUI route turns out not to work, the defect is still real — find another path that destroys
  before first entry.
- **Is `restart()` affected too?** It calls `co_derive` on a live handle and pushes a second entry
  without removing the first. Every `restart()` in the tree passes the same entry point its
  `create()` did, so today it changes *which entry matches* and never *which function runs*. It is
  still an unbounded push with no matching pop. Whether upstream wants that in the same patch or a
  separate one is a judgement call — one defect per pull request argues for separate.
- **Does upstream consider `EntryPoints()` the right design at all?** The vector exists only to
  smuggle an `std::function` across a `co_create` that takes a bare function pointer. A per-thread
  member would remove the whole class of bug. That is a much larger change and almost certainly a
  separate conversation — do not bundle it.

---

## Related

- **`UPSTREAM.md` entry 6** — `Scheduler::_resume` is left pointing at the last auxiliary thread.
  Same file, same "send the ungated version" note.
- **`UPSTREAM.md` entry 7** — `OPLL::unload()` never calls `Thread::destroy()` at all. Adjacent
  lifetime bug in the same area; fixing 7 would *create* an instance of this one.
- **`DECISIONS.md` §8.16** — why this branch gates the fix instead of taking it natively.

## What this did not explain

It was found while chasing a different bug: on the web build, loading a HuCard game after a
SuperGrafx game gives sound but no video. **This is not the cause of that.** The PC Engine's chips
are namespace globals and never call `Thread::destroy()`, so no address is ever recycled between two
different chips there. That bug is still open; do not close it against this entry.
