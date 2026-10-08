#pragma once

//measurement only (probe D). Per-cothread wall-clock attribution that does not read the stack.
//
//every control transfer between emulated components goes through exactly one of the co_switch call
//sites in thread.cpp and scheduler.cpp. Timestamping both sides of each of them partitions a frame
//into: time each cothread spent computing, and time spent inside the switch machinery itself. That
//is an exact accounting -- no sampler, no stack walk, nothing Asyncify can rewrite underneath it --
//at the cost of two clock reads per switch, which land almost entirely in the switch bucket and are
//subtracted out by calibration.

#if defined(ARES_COPROF)

#if defined(__EMSCRIPTEN__)
  #include <emscripten/emscripten.h>
#else
  #include <chrono>
#endif

namespace ares {

struct CoProf {
  enum : u32 { Max = 32 };

  bool enabled = false;
  cothread_t handles[Max] = {};
  f64 run[Max] = {};        //nanoseconds computing on that cothread
  u64 entries[Max] = {};    //times that cothread was resumed
  u32 count = 0;
  u64 switches = 0;         //co_switch calls executed
  f64 switchNs = 0;         //nanoseconds inside the switch machinery (incl. this probe's clock reads)
  f64 last = 0;

  static auto now() -> f64 {
    #if defined(__EMSCRIPTEN__)
      return emscripten_get_now() * 1.0e6;  //ms -> ns
    #else
      return (f64)std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    #endif
  }

  auto index(cothread_t handle) -> u32 {
    for(u32 i = 0; i < count; i++) if(handles[i] == handle) return i;
    if(count < Max) { handles[count] = handle; return count++; }
    return Max - 1;
  }

  //`doubled` runs each hook's work twice. The second copy writes to scratch and changes no result,
  //so (frame time doubled - frame time single) is this probe's own cost per frame, measured rather
  //than assumed. Subtracting it from the switch bucket is the only correction applied.
  bool doubled = false;
  f64 scratchNs = 0, scratchLast = 0;
  f64 scratchRun[Max] = {};

  //called on the outgoing side, immediately before co_switch
  auto leave() -> void {
    f64 t = now();
    run[index(co_active())] += t - last;
    last = t;
    if(doubled) { f64 u = now(); scratchRun[index(co_active())] += u - scratchLast; scratchLast = u; }
  }

  //called on the incoming side, immediately after co_switch returns
  auto arrive() -> void {
    f64 t = now();
    switchNs += t - last;
    last = t;
    switches++;
    entries[index(co_active())]++;
    if(doubled) { f64 u = now(); scratchNs += u - scratchLast; scratchLast = u; entries[index(co_active())]--; entries[index(co_active())]++; }
  }

  auto reset() -> void {
    for(u32 i = 0; i < Max; i++) { run[i] = 0; entries[i] = 0; scratchRun[i] = 0; }
    switches = 0;
    switchNs = 0;
    scratchNs = 0;
    last = now();
    scratchLast = last;
  }
};

inline CoProf coprof;

//always-on switch tally: one memory increment, no clock, no call. This is what the sync-interval
//sweep reads, so that sweep runs at the uninstrumented frame cost.
inline u64 coSwitches = 0;

}

//fully qualified: every use site sits inside a per-core namespace
#define COPROF_LEAVE()  do { ::ares::coSwitches++; if(::ares::coprof.enabled) ::ares::coprof.leave();  } while(0)
#define COPROF_ARRIVE() do { if(::ares::coprof.enabled) ::ares::coprof.arrive(); } while(0)

#else
  #define COPROF_LEAVE()  do {} while(0)
  #define COPROF_ARRIVE() do {} while(0)
#endif
