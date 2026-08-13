#include <pce/pce.hpp>

namespace ares::PCEngine {

CPU cpu;
#include "io.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto CPU::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("CPU");

  if(Model::SuperGrafx() == 0) ram.allocate( 8_KiB, 0x00);
  if(Model::SuperGrafx() == 1) ram.allocate(32_KiB, 0x00);

  debugger.load(node);
}

auto CPU::unload() -> void {
  ram.reset();

  node = {};
  debugger = {};
}

#if defined(PLATFORM_WEB)
//The cpu's entry point on this platform. Every other chip in this core is advanced by plain function
//calls from this cothread, so none of them ever suspends inside its own entry point and the
//scheduler cannot walk it to the position that entry point returns at -- Thread::Enter answers the
//synchronization before running it. Retiring the vdp here, on the cothread it is actually advanced
//from, is what keeps a synchronized save finding it exactly where the cothread build leaves it. The
//psg and the pcd need no retiring: their main()s are one whole unit each, so a plain-call advance
//always leaves them on a boundary already.
//
//It wraps main() rather than living at the end of it because main() has three early returns, and
//restructuring those would be a change native could see for a reason native does not have.
auto CPU::mainWeb() -> void {
  //several turns of the machine per entry: in Run mode the shell around this call -- Enter's loop,
  //its no-op scheduler.synchronize(), the std::function boundary -- is pure overhead per main(), and
  //the scheduler needs control back only at a synchronization safe point. That request is made by
  //setting SynchronizePrimary and resuming this cothread mid-main(), so testing it after every
  //main() and returning immediately reaches Enter's scheduler.synchronize() at exactly the first
  //entry-point return the cothread build would yield at. Events exit through co_switch inside
  //main() and never wait on this loop.
  for(u32 n : range(64)) {
    main();
    if(scheduler.synchronizingPrimary()) {
      vdp.finishUnit();
      return;
    }
  }
}
#endif

auto CPU::main() -> void {
  if(tiq.pending) {
    debugger.interrupt("TIQ");
    return interrupt(tiq.vector);
  }

  if(irq1.pending) {
    debugger.interrupt("IRQ1");
    return interrupt(irq1.vector);
  }

  if(irq2.pending) {
    debugger.interrupt("IRQ2");
    return interrupt(irq2.vector);
  }

  debugger.instruction();
  instruction();
}

auto CPU::step(u32 clocks) -> void {
  timer.counter -= clocks;
  while(timer.counter < 0) {
    synchronize(psg);
    timer.counter += 1024 * 3;
    if(!timer.value--) {
      timer.value = timer.reload;
      timer.line = timer.enable;
    }
  }

  Thread::step(clocks);
  synchronize(vdp.thread());
  if(PCD::Present()) synchronize(pcd);
}

auto CPU::power() -> void {
  HuC6280::power();
  #if defined(PLATFORM_WEB)
  Thread::create(system.colorburst() * 6.0, std::bind_front(&CPU::mainWeb, this));
  #else
  Thread::create(system.colorburst() * 6.0, std::bind_front(&CPU::main, this));
  #endif

  r.pc.byte(0) = read(r.mpr[reset.vector >> 13], n13(reset.vector + 0));
  r.pc.byte(1) = read(r.mpr[reset.vector >> 13], n13(reset.vector + 1));

  ram.fill(0x00);

  irq2 = {};
  irq1 = {};
  tiq = {};
  timer = {};
  io = {};
}

auto CPU::lastCycle() -> void {
  irq2.pending = 0 & !irq2.disable & !r.p.i;
  irq1.pending = vdp.irqLine() & !irq1.disable & !r.p.i;
  tiq.pending = timer.irqLine() & !tiq.disable & !r.p.i;
}

}
