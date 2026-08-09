#include <ms/ms.hpp>

namespace ares::MasterSystem {

CPU cpu;
#include "memory.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto CPU::load(Node::Object parent) -> void {
  ram.allocate(8_KiB);

  node = parent->append<Node::Object>("CPU");

  debugger.load(node);
}

auto CPU::unload() -> void {
  ram.reset();
  node = {};
  debugger = {};
}

auto CPU::main() -> void {
  #if defined(PLATFORM_WEB)
  //the z80 samples its interrupt inputs between instructions, so bring the vdp to the current cpu
  //clock before reading the lines it drives.
  catchUpVDP();
  #endif
  if(state.nmiLine) {
    state.nmiLine = 0;  //edge-sensitive
    if(nmi()) {
      debugger.interrupt("NMI");
    }
  }

  if(state.irqLine) {
    //level-sensitive
    if(irq()) {
      debugger.interrupt("IRQ");
    }
  }

  debugger.instruction();
  instruction();

  #if defined(PLATFORM_WEB)
  //this thread is about to reach the safe point the scheduler treats as the whole machine's, and a
  //save state is written from there. the vdp is advanced by plain calls from this cothread, so its
  //own cothread may never have run -- Thread::Enter answers the scheduler's first synchronization
  //before executing anything -- and it cannot be relied on to bring itself to a line boundary.
  //do it here, where the call is on a cothread the scheduler owns, so endLine() may exit normally.
  if(scheduler.synchronizingPrimary()) while(vdp.hcounter()) vdp.runCycle();
  #endif
}

auto CPU::step(u32 clocks) -> void {
  Thread::step(clocks);
  #if defined(PLATFORM_WEB)
  synchronizeWeb();
  #else
  Thread::synchronize();
  #endif
}

#if defined(PLATFORM_WEB)
//the vdp holds no state in its cothread's program counter under PLATFORM_WEB: VDP::main() performs
//exactly one clock through runCycle() and returns to the entry loop. that makes entering its
//cothread pure overhead -- under asyncify a cothread switch is the largest cost in the profile --
//so catch it up with plain calls on the cpu's own cothread instead. runCycle() is the flat twin of
//the native scanline loop and never switches back.
auto CPU::catchUpVDP() -> void {
  if(scheduler.synchronizing()) return;  //mirror Thread::synchronize(), which stands down here
  while(vdp.Thread::clock() < Thread::clock()) vdp.runCycle();
}

//the psg and opll are the same shape: one sample per main(), no cothread-resident state.
auto CPU::catchUpAudio() -> void {
  if(scheduler.synchronizing()) return;
  while(psg.Thread::clock() < Thread::clock()) psg.runCycle();
  //load-bearing, not defensive: without an OPLL the thread was never created, so its scalar is
  //zero and Thread::step(1) would advance no clock -- the loop below would never terminate.
  if(opll.node) {
    while(opll.Thread::clock() < Thread::clock()) opll.runCycle();
  }
}

auto CPU::synchronizeWeb() -> void {
  if(scheduler.synchronizing()) return;
  catchUpVDP();
  catchUpAudio();
  //not a no-op: a Paddle, Sports Pad, Mega Mouse or MD Fighting Pad in a controller port is a
  //real cothread, and only this call advances it.
  Thread::synchronizeExcept(vdp, psg, opll);
}
#endif

auto CPU::setNMI(bool value) -> void {
  state.nmiLine = value;
}

auto CPU::setIRQ(bool value) -> void {
  state.irqLine = value;
}

auto CPU::power() -> void {
  Z80::bus = this;
  Z80::power();
  Thread::create(system.colorburst(), std::bind_front(&CPU::main, this));
  PC = 0x0000;  //reset vector address
  SP = 0xfffd;  //initial stack pointer location

  ram.fill(0);  //fixes hang in Shanghai II (Japan) (GG)
                //bios usually clears ram, so it should be safe

  ram.write(0xc000, 0xab);  //CPU $3e initial value
  ram.write(0xc700, 0x9b);  //VDP $01 initial value
  state = {};
  bus = {};
  bus.biosEnable = (bool)bios;
  bus.cartridgeEnable = !(bool)bios;
  if(Model::MasterSystemII()) bus.pullup = 0xff;
  if(Model::GameGear()) bus.pullup = 0xff;
  sio = {};
}

}
