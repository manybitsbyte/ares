#include <ng/ng.hpp>

namespace ares::NeoGeo {

APU apu;
#include "memory.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto APU::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("APU");
  ram.allocate(2_KiB);
  debugger.load(node);
}

auto APU::unload() -> void {
  debugger.unload(node);
  ram.reset();
  node.reset();
}
#if !defined(PLATFORM_WEB)
auto APU::main() -> void {
  if(nmi.pending && nmi.enable) {
    Z80::nmi();
    nmi.pending = 0;
    debugger.interrupt("NMI");
  }

  if(irq.pending) {
    Z80::irq();
    debugger.interrupt("IRQ");
  }

  debugger.instruction();
  Z80::instruction();
}

auto APU::step(u32 clocks) -> void {
  Thread::step(clocks);
  Thread::synchronize();
}
#endif
auto APU::power(bool reset) -> void {
  Z80::bus = this;
  Z80::power();
  Thread::create(4'000'000, std::bind_front(&APU::main, this));
  communication = {};
  nmi = {};
  irq = {};
  rom = {};
}

}
#if defined(PLATFORM_WEB)
//the web expression of APU::main(). native's is kept verbatim above, inside
//#if !defined(PLATFORM_WEB); placed at end of file because a skipped preprocessor region swallows
//the blank lines on both of its edges, and here there is nothing to swallow.
namespace ares::NeoGeo {

auto APU::main() -> void {
  //reaching this on the z80's own cothread means the scheduler is walking auxiliary threads to
  //their safe points. the z80 is advanced whole instructions at a time by CPU::catchUpAPU, so it
  //already stands on an instruction boundary -- where the native build's suspended step() unwinds
  //to -- and running an instruction here would put it one ahead on every save.
  if(scheduler.synchronizing()) return;

  //natively every step of the previous instruction synchronized the ym2610 to the z80's clock, so
  //the irq.pending sample below reads a chip that has caught up; here the instructions run
  //atomically, so catch it up at the boundary instead.
  cpu.catchUpOPNB();

  if(nmi.pending && nmi.enable) {
    Z80::nmi();
    nmi.pending = 0;
    debugger.interrupt("NMI");
  }

  if(irq.pending) {
    Z80::irq();
    debugger.interrupt("IRQ");
  }

  debugger.instruction();
  Z80::instruction();
}

//native's step synchronizes every thread after Thread::step, but the loop iterates the cpu first
//and suspends there whenever the z80 has overshot it -- so the crossing step's lspc and ym2610
//syncs are deferred until the z80 next resumes, and a synchronized save taken in between never
//sees them paid. syncing to the clock as it stood before this step reproduces that: the ym2610
//tracks every completed step and still owes the crossing one, exactly as the cothread build's
//suspension leaves it. the lspc needs no counterpart here because the z80 never observes it, and
//the cpu's own wait drives it to the same clocks either way.
auto APU::step(u32 clocks) -> void {
  cpu.catchUpOPNB();
  Thread::step(clocks);
}

}
#endif
