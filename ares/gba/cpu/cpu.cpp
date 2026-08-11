#include <gba/gba.hpp>

namespace ares::GameBoyAdvance {

CPU cpu;
#include "prefetch.cpp"
#include "bus.cpp"
#include "io.cpp"
#include "memory.cpp"
#include "dma.cpp"
#include "timer.cpp"
#include "keypad.cpp"
#include "coprocessor.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto CPU::load(Node::Object parent) -> void {
  iwram.allocate( 32_KiB);
  ewram.allocate(256_KiB);

  node = parent->append<Node::Object>("CPU");

  debugger.load(node);
}

auto CPU::unload() -> void {
  iwram.reset();
  ewram.reset();
  node = {};
  debugger = {};
}

#if defined(PLATFORM_WEB)
//The cpu's entry point on this platform. Every other chip is advanced by plain function calls from
//this cothread, so none of them ever suspends inside its own entry point and the scheduler cannot
//walk it to the position that entry point returns at -- Thread::Enter answers the synchronization
//before running it. Retiring them here, on the cothread they are actually advanced from, is what
//keeps a synchronized save finding them exactly where the cothread build leaves them.
//
//It wraps main() rather than living at the end of it because main() has two early returns, and
//restructuring those would be a change native could see for a reason native does not have.
auto CPU::mainWeb() -> void {
  main();
  if(scheduler.synchronizingPrimary()) {
    //in the order Scheduler::enter walks the auxiliary threads; the player and the cartridge clock
    //advance a whole unit per call and so are already on a boundary
    ppu.finishUnit();
    apu.finishUnit();
    display.finishUnit();
  }
}
#endif

auto CPU::main() -> void {
  if(stopped()) {
    if(!keypad.conditionMet) {
      stepIRQ();
      Thread::step(1);
      Thread::synchronize();
      return;
    }
    Thread::step(2);
    Thread::synchronize();
    context.stopped = false;
  }

  if(halted()) {
    dmac.runPending();
    if(!(irq.enable[0] & irq.flag[0])) {
      return step(1);
    }
    step(2);
    context.halted = false;
  }

  debugger.instruction();
  instruction();
}

auto CPU::setInterruptFlag(u32 source) -> void {
  irq.flag[1] |= source;
}

inline auto CPU::stepIRQ() -> void {
  if(!dmac.stallingCPU) {
    irq.synchronizer = irq.ime[0] && (irq.enable[0] & irq.flag[0]);
    irq.enable[0] = irq.enable[1];
    irq.flag[0] = irq.flag[1];
    irq.ime[0] = irq.ime[1];
  }
}

#if defined(PLATFORM_WEB)
//A second expression of the function below, not a refactor of it: native keeps its step() verbatim,
//down to the blank lines the preprocessor leaves. Its per-iteration loop re-decides the same things
//every time around: Timer::run()'s tick test reads cpu.clock(), which is Thread::clock(), and
//Thread::step() runs after the loop -- so within one call a timer either ticks on every iteration
//or on none. When no ticking timer's period can wrap (the only thing that raises a flag, feeds a
//FIFO, or steps a cascade), the whole loop is: each ticking timer's period grows by clocks, and the
//irq pipeline -- a one-stage delay whose inputs nothing in the loop is left to change -- either
//takes its single verbatim step or, run twice or more against constant inputs, lands on [0] = [1]
//with the synchronizer read through it. The pending and timerLatched guards keep the two
//clock-order-sensitive latch steps on the loop. The counter updates at the top branch around work
//that usually has none to do: the remainder only exists in the wrap clock of a scanline, and the
//waiting counters only move while a DMA channel is holding one.
auto CPU::step(u32 clocks) -> void {
  if(!clocks) return;
  u32 hcounter = context.hcounter + clocks;
  context.hcounter = hcounter < 1232 ? hcounter : hcounter % 1232;

  if(dmac.channel[0].waiting | dmac.channel[1].waiting | dmac.channel[2].waiting | dmac.channel[3].waiting) {
    dmac.channel[0].waiting = max(0, dmac.channel[0].waiting - (s32)clocks);
    dmac.channel[1].waiting = max(0, dmac.channel[1].waiting - (s32)clocks);
    dmac.channel[2].waiting = max(0, dmac.channel[2].waiting - (s32)clocks);
    dmac.channel[3].waiting = max(0, dmac.channel[3].waiting - (s32)clocks);
  }

  static const u32 tickMask[] = {0, 63, 255, 1023};
  bool ticking[4], wraps = false;
  for(u32 n : range(4)) {
    ticking[n] = timer[n].enable && !timer[n].cascade && (clock() & tickMask[timer[n].frequency]) == 0;
    if(ticking[n] && u32(timer[n].period) + clocks > 65535) wraps = true;
  }
  if(!wraps && !context.timerLatched
  && !timer[0].pending && !timer[1].pending && !timer[2].pending && !timer[3].pending) {
    for(u32 n : range(4)) if(ticking[n]) timer[n].period = timer[n].period + clocks;
    if(!dmac.stallingCPU) {
      irq.synchronizer = clocks == 1
      ? irq.ime[0] && (irq.enable[0] & irq.flag[0])
      : irq.ime[1] && (irq.enable[1] & irq.flag[1]);
      irq.enable[0] = irq.enable[1];
      irq.flag[0] = irq.flag[1];
      irq.ime[0] = irq.ime[1];
    }
    context.clock += clocks;
  } else
  for(auto _ : range(clocks)) {
    stepIRQ();
    timer[0].run();
    timer[1].run();
    timer[2].run();
    timer[3].run();
    timer[0].reloadLatch();
    timer[1].reloadLatch();
    timer[2].reloadLatch();
    timer[3].reloadLatch();
    if(context.timerLatched) {
      timer[0].stepLatch();
      timer[1].stepLatch();
      timer[2].stepLatch();
      timer[3].stepLatch();
      context.timerLatched = 0;
    }
    context.clock++;
  }

  Thread::step(clocks);
  Thread::synchronize(display, player);

  //occasionally perform a full sync in case CPU has not recently interacted with some component
  static u32 counter = 0;
  counter += clocks;
  if(counter >= 1024) {
    Thread::synchronize();
    counter = 0;
  }
}
#else
auto CPU::step(u32 clocks) -> void {
  if(!clocks) return;
  context.hcounter = (context.hcounter + clocks) % 1232;

  dmac.channel[0].waiting = max(0, dmac.channel[0].waiting - (s32)clocks);
  dmac.channel[1].waiting = max(0, dmac.channel[1].waiting - (s32)clocks);
  dmac.channel[2].waiting = max(0, dmac.channel[2].waiting - (s32)clocks);
  dmac.channel[3].waiting = max(0, dmac.channel[3].waiting - (s32)clocks);

  for(auto _ : range(clocks)) {
    stepIRQ();
    timer[0].run();
    timer[1].run();
    timer[2].run();
    timer[3].run();
    timer[0].reloadLatch();
    timer[1].reloadLatch();
    timer[2].reloadLatch();
    timer[3].reloadLatch();
    if(context.timerLatched) {
      timer[0].stepLatch();
      timer[1].stepLatch();
      timer[2].stepLatch();
      timer[3].stepLatch();
      context.timerLatched = 0;
    }
    context.clock++;
  }

  Thread::step(clocks);
  Thread::synchronize(display, player);

  //occasionally perform a full sync in case CPU has not recently interacted with some component
  static u32 counter = 0;
  counter += clocks;
  if(counter >= 1024) {
    Thread::synchronize();
    counter = 0;
  }
}
#endif
auto CPU::power() -> void {
  ARM7TDMI::power();
  #if defined(PLATFORM_WEB)
  Thread::create(system.frequency(), std::bind_front(&CPU::mainWeb, this));
  #else
  Thread::create(system.frequency(), std::bind_front(&CPU::main, this));
  #endif

  bindCDP( 0, [&](n4 cm, n3 op2, n4 cd, n4 cn, n4 op1) { return coprocessor.vcCDP(); });
  bindMCR(14, [&](n32 data, n4 cm, n3 op2, n4 cn, n3 op1) { return coprocessor.debugMCR(); });
  bindMRC(14, [&](n4 cm, n3 op2, n4 cn, n3 op1) { return coprocessor.debugMRC(); });

  for(auto& byte : iwram) byte = 0x00;
  for(auto& byte : ewram) byte = 0x00;

  for(auto n : range(4)) dmac.channel[n] = {n};
  for(auto n : range(4)) timer[n] = {n};
  serial = {};
  keypad = {};
  joybus = {};
  irq = {};
  wait = {};
  memory = {};
  prefetch = {};
  context = {};

  dmac.channel[0].source.setBits(27); dmac.channel[0].latch.source.setBits(27);
  dmac.channel[0].target.setBits(27); dmac.channel[0].latch.target.setBits(27);
  dmac.channel[0].length.setBits(14); dmac.channel[0].latch.length.setBits(14);

  dmac.channel[1].source.setBits(28); dmac.channel[1].latch.source.setBits(28);
  dmac.channel[1].target.setBits(27); dmac.channel[1].latch.target.setBits(27);
  dmac.channel[1].length.setBits(14); dmac.channel[1].latch.length.setBits(14);

  dmac.channel[2].source.setBits(28); dmac.channel[2].latch.source.setBits(28);
  dmac.channel[2].target.setBits(27); dmac.channel[2].latch.target.setBits(27);
  dmac.channel[2].length.setBits(14); dmac.channel[2].latch.length.setBits(14);

  dmac.channel[3].source.setBits(28); dmac.channel[3].latch.source.setBits(28);
  dmac.channel[3].target.setBits(28); dmac.channel[3].latch.target.setBits(28);
  dmac.channel[3].length.setBits(16); dmac.channel[3].latch.length.setBits(16);

  for(u32 n = 0x0b0; n <= 0x0df; n++) bus.io[n] = this;  //DMA
  for(u32 n = 0x100; n <= 0x10f; n++) bus.io[n] = this;  //Timers
  for(u32 n = 0x120; n <= 0x12b; n++) bus.io[n] = this;  //Serial
  for(u32 n = 0x130; n <= 0x133; n++) bus.io[n] = this;  //Keypad
  for(u32 n = 0x134; n <= 0x15b; n++) bus.io[n] = this;  //Serial
  for(u32 n = 0x200; n <= 0x20b; n++) bus.io[n] = this;  //System
  for(u32 n = 0x300; n <= 0x303; n++) bus.io[n] = this;  //System
  //0x080-0x083 mirrored via gba/memory/memory.cpp        //System
}

}
