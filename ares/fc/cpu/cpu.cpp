#include <fc/fc.hpp>

namespace ares::Famicom {

CPU cpu;
#include "memory.cpp"
#include "timing.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto CPU::load(Node::Object parent) -> void {
  ram.allocate(2_KiB);

  node = parent->append<Node::Object>("CPU");

  debugger.load(node);
}

auto CPU::unload() -> void {
  ram.reset();
  debugger = {};
  node = {};
}

auto CPU::main() -> void {
  if(io.interruptPending) {
    if(io.resetPending) {
      debugger.interrupt("Reset");
      reset();
      io.resetPending = 0;
    } else if(io.nmiPending) {
      debugger.interrupt("NMI");
      interrupt();
    } else {
      debugger.interrupt("IRQ");
      interrupt();
    }
  }

  debugger.instruction();
  instruction();

  #if defined(PLATFORM_WEB)
  //the scheduler takes the primary's safe point the moment this returns, and the ppu -- which never
  //suspends inside its own entry point here -- must be where returning from renderScanline() leaves
  //it natively, or a synchronized state carries an in-flight fetch native states do not have.
  if(scheduler.synchronizingPrimary()) ppu.finishScanline();
  #endif
}

auto CPU::step(u32 clocks) -> void {
  assert(clocks == rate());
  io.oddCycle ^= 1;
  Thread::step(clocks);
  #if defined(PLATFORM_WEB)
  catchUpAPU();
  catchUpPPU();
  Thread::synchronizeExcept(apu, ppu);
  #else
  Thread::synchronize();
  #endif
}

auto CPU::power(bool reset) -> void {
  MOS6502::BCD = 0;
  if(!reset) MOS6502::power();
  Thread::create(system.frequency(), std::bind_front(&CPU::main, this));

  if(!reset) {
    ram.fill(0xff);
  }

  io = {};
  io.resetPending = 1;
  io.interruptPending = 1;
}

}
