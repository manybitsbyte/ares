#include <md/md.hpp>

namespace ares::MegaDrive {

CPU cpu;
#include "bus.cpp"
#include "io.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto CPU::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("CPU");
  tmss.allocate(2_KiB >> 1);
  ram.allocate(64_KiB >> 1);
  debugger.load(node);

  if(auto fp = system.pak->read("tmss.rom")) {
    for(auto address : range(tmss.size())) tmss.program(address, fp->readm(2L));
  }
}

auto CPU::unload() -> void {
  debugger = {};
  tmss.reset();
  ram.reset();
  node.reset();
}

auto CPU::main() -> void {
  #if defined(PLATFORM_WEB)
  //the 68000 samples interrupts between instructions, and the native build samples with the vdp
  //where the last wait's synchronization left it -- an instruction's trailing internal cycles
  //never synchronize -- so catch the vdp up to exactly that clock here. advancing further would
  //recognize an interrupt an instruction early.
  if(!scheduler.synchronizing() && !webCatchUp.vdp) {
    webCatchUp.vdp = 1;
    //the addition form re-reads both clocks every iteration: a frame() fired by runCycle()
    //rebases all thread clocks through Scheduler::exit, and the delta stays valid across it.
    while(vdp.Thread::clock() + sinceWaitClock < Thread::clock()) vdp.runCycle();
    webCatchUp.vdp = 0;
  }
  #endif
  if(state.interruptPending) {
    if(lower(Interrupt::Reset)) {
      r.a[7] = read(1, 1, 0) << 16 | read(1, 1, 2) << 0;
      r.pc   = read(1, 1, 4) << 16 | read(1, 1, 6) << 0;
      prefetch();
      prefetch();
      debugger.interrupt("Reset");
    }

    if(6 > r.i && lower(Interrupt::VerticalBlank)) {
      debugger.interrupt("Vblank");
      vdp.irq.acknowledge(6);
      return interrupt(Vector::Level6, 6);
    }

    if(4 > r.i && lower(Interrupt::HorizontalBlank)) {
      debugger.interrupt("Hblank");
      vdp.irq.acknowledge(4);
      return interrupt(Vector::Level4, 4);
    }

    if(2 > r.i && lower(Interrupt::External)) {
      debugger.interrupt("External");
      vdp.irq.acknowledge(2);
      return interrupt(Vector::Level2, 2);
    }
  }

  debugger.instruction();
  instruction();
}

auto CPU::step(u32 clocks) -> void {
  clocks += state.stolenMcycles/7;
  state.stolenMcycles -= state.stolenMcycles/7 * 7;
  refresh.ram += clocks;
  refresh.external += clocks;
  Thread::step(clocks);
  cyclesUntilFullSync -= clocks;
  #if defined(PLATFORM_WEB)
  sinceWaitClock += Thread::scalar() * clocks;
  #endif
}

inline auto CPU::idle(u32 clocks) -> void {
  step(clocks);
}

auto CPU::wait(u32 clocks) -> void {
  step(clocks);

  #if defined(PLATFORM_WEB)
  //interrupt sampling in main() reproduces the native build's synchronization position: the vdp
  //as of the end of the most recent wait (see CPU::main).
  sinceWaitClock = 0;

  //cartridge synchronization is retained because an SVP cartridge is an active coprocessor; for
  //ordinary cartridges it is already ahead and this check does not switch cothreads.
  Thread::synchronize(cartridge);
  catchUpAPU();
  catchUpVDP();
  //the remaining threads mirror the native full synchronize below, throttle included
  if(cyclesUntilFullSync <= 0) {
    cyclesUntilFullSync = minCyclesBetweenSyncs;
    catchUpAuxiliary();
  }
  #else
  Thread::synchronize(apu, cartridge, opn2, vdp);
  if (cyclesUntilFullSync <= 0) {
    cyclesUntilFullSync = minCyclesBetweenSyncs;
    Thread::synchronize();
  }
  #endif
}

#if defined(PLATFORM_WEB)
//the z80 holds no state in its cothread's program counter between instructions: each APU::main()
//performs one instruction (or one stall cycle) and returns to the entry loop. that makes entering
//its cothread pure overhead, so catch it up with plain function calls on the current cothread;
//Thread::synchronize() notices the z80 is not on its own cothread and skips the switch back. the
//only divergence from the cothread build is that an instruction that overshoots the 68000's clock
//completes atomically instead of yielding mid-instruction at the first step past it.
//the ym2612 produces exactly one sample per OPN2::main(), so it is caught up the same way; the
//order (z80 first, then ym2612) mirrors the native Thread::synchronize(apu, cartridge, opn2, vdp).
auto CPU::catchUpAPU() -> void {
  if(!busActive()) return;  //re-entered by a chip already advancing on this cothread
  if(scheduler.synchronizing()) return;  //mirror Thread::synchronize(), which stands down here
  webCatchUp.apu = 1;
  while(apu.Thread::clock() < Thread::clock()) apu.main();
  while(opn2.Thread::clock() < Thread::clock()) opn2.main();
  webCatchUp.apu = 0;
}

//the vdp is caught up through runCycle(), its slot-at-a-time twin of mainH32()/mainH40().
auto CPU::catchUpVDP() -> void {
  if(!busActive()) return;
  if(scheduler.synchronizing()) return;
  webCatchUp.vdp = 1;
  while(vdp.Thread::clock() < Thread::clock()) vdp.runCycle();
  webCatchUp.vdp = 0;
}

//the psg produces one sample per PSG::main() and the controllers advance one timer cycle per
//main(), so both are caught up with plain calls as well; the trailing synchronizeExcept() then
//finds them already caught up and only ever switches to coprocessor threads (Mega CD, 32X).
auto CPU::catchUpAuxiliary() -> void {
  if(!busActive()) return;
  if(scheduler.synchronizing()) return;
  while(vdp.psg.Thread::clock() < Thread::clock()) vdp.psg.main();
  controllerPort1.catchUp();
  controllerPort2.catchUp();
  extensionPort.catchUp();
  Thread::synchronizeExcept(apu, cartridge, opn2, vdp);
}
#endif

auto CPU::raise(Interrupt interrupt) -> void {
  state.interruptPending.bit((u32)interrupt) = 1;
}

auto CPU::lower(Interrupt interrupt) -> bool {
  if(!state.interruptPending.bit((u32)interrupt)) return false;
  return state.interruptPending.bit((u32)interrupt) = 0, true;
}

auto CPU::power(bool reset) -> void {
  M68000::power();
  Thread::create(system.frequency() / 7.0, std::bind_front(&CPU::main, this));

  tmssEnable = system.tmss;
  if(!reset) ram.fill();

  io = {};
  io.version = tmssEnable;
  io.romEnable = !tmssEnable;
  io.vdpEnable[0] = !tmssEnable;
  io.vdpEnable[1] = !tmssEnable;

  refresh = {};

  state = {};
  #if defined(PLATFORM_WEB)
  sinceWaitClock = 0;
  webCatchUp = {};
  #endif
  raise(Interrupt::Reset);
}

}
