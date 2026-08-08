#include <fc/fc.hpp>

namespace ares::Famicom {

CPU cpu;
#if defined(PLATFORM_WEB)
u32 CPU::apuSyncGranularity = 1;
u32 CPU::ppuSyncGranularity = 1;
#endif
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
}

auto CPU::step(u32 clocks) -> void {
  assert(clocks == rate());
  io.oddCycle ^= 1;
  Thread::step(clocks);
  #if defined(PLATFORM_WEB)
  //The DMC's DMA request is the one APU event that reaches back into CPU timing: it steals a cycle,
  //so deferring it moves every subsequent bus access. fc-sweep.mjs diverges at every granularity
  //with the DMC running and at none without it.
  //But the request is rare -- dmc.cpp raises it only when the bit counter wraps, which even at the
  //fastest rate is once per 432 CPU cycles, plus a two-or-three cycle delay at sample start. Pinning
  //the APU cycle-exact for a whole sample would cost the batching win outright on any game with
  //continuous DMC drums, for one cycle in four hundred. Hold it exact across the window the request
  //can land in instead. The counters read here are the APU's own and so lag by up to the
  //granularity, which is what the margin on periodCounter covers.
  auto& dmc = apu.dmc;
  bool dmcImminent = dmc.dmaDelayCounter
    || (dmc.lengthCounter && dmc.bitCounter == 7 && dmc.periodCounter <= apuSyncGranularity + 1);
  bool syncAPU = ++apuSyncCounter >= apuSyncGranularity || dmcImminent;
  bool syncPPU = ++ppuSyncCounter >= ppuSyncGranularity;
  if(syncAPU) apuSyncCounter = 0;
  if(syncPPU) ppuSyncCounter = 0;
  if(!syncAPU && !syncPPU) return Thread::synchronizeExcept(apu, ppu);
  if(!syncAPU) return Thread::synchronizeExcept(apu);
  if(!syncPPU) return Thread::synchronizeExcept(ppu);
  #endif
  Thread::synchronize();
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
