#include <ms/ms.hpp>

namespace ares::MasterSystem {

CPU cpu;
#if defined(PLATFORM_WEB)
u32 CPU::syncGranularity = 1;
#endif
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
  //The Z80 samples interrupts between instructions, so bring the VDP to the current CPU clock
  //before inspecting the lines it drives. This keeps interrupt recognition exact while step()
  //batches ordinary device catch-ups.
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
}

auto CPU::step(u32 clocks) -> void {
  Thread::step(clocks);
  #if defined(PLATFORM_WEB)
  syncCounter += clocks;
  if(syncCounter >= syncGranularity) synchronizeWeb();
  #else
  Thread::synchronize();
  #endif
}

#if defined(PLATFORM_WEB)
auto CPU::catchUpVDP() -> void {
  if(scheduler.synchronizing()) return;
  while(vdp.Thread::clock() < Thread::clock()) vdp.runCycle();
}

auto CPU::catchUpAudio() -> void {
  if(scheduler.synchronizing()) return;
  while(psg.Thread::clock() < Thread::clock()) psg.runCycle();
  while(opll.handle() && opll.Thread::clock() < Thread::clock()) opll.runCycle();
}

auto CPU::synchronizeWeb() -> void {
  syncCounter = 0;
  catchUpVDP();
  catchUpAudio();
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
  #if defined(PLATFORM_WEB)
  syncCounter = 0;
  #endif
  bus = {};
  bus.biosEnable = (bool)bios;
  bus.cartridgeEnable = !(bool)bios;
  if(Model::MasterSystemII()) bus.pullup = 0xff;
  if(Model::GameGear()) bus.pullup = 0xff;
  sio = {};
}

}
