#include <sfc/sfc.hpp>

namespace ares::SuperFamicom {

SMP smp;
#include "memory.cpp"
#include "io.cpp"
#include "timing.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto SMP::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("SMP");

  debugger.load(node);
}

auto SMP::unload() -> void {
  debugger = {};
  node = {};
}

auto SMP::main() -> void {
  if(r.wait) {
    instructionWait();
  } else if(r.stop) {
    instructionStop();
  } else {
    debugger.instruction();
    instruction();
  }

  #if defined(PLATFORM_WEB)
  //returning from here while the scheduler is walking auxiliary threads means this thread is about
  //to take the safe point a save state is written from. the dsp is advanced by plain calls from this
  //cothread, so its own cothread may never have run -- Thread::Enter answers the scheduler's first
  //synchronization before executing anything -- and it cannot be relied on to reach the end of the
  //sample cycle its native main() would have returned at. do it here instead. the dsp is walked
  //after the smp, so its main() then finds nothing left to finish.
  if(scheduler.synchronizing()) dsp.finishSample();
  #endif
}

auto SMP::power(bool reset) -> void {
  if(auto fp = system.pak->read("ipl.rom")) {
    fp->read(iplrom, 64);
  }

  SPC700::power();
  create(system.apuFrequency() / 12.0, std::bind_front(&SMP::main, this));

  r.pc.byte.l = iplrom[62];
  r.pc.byte.h = iplrom[63];

  io = {};
  timer0 = {};
  timer1 = {};
  timer2 = {};
}

}
