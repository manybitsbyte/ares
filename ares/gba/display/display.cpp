#include <gba/gba.hpp>

//The only PPU state the CPU needs on every cycle is raised IRQs and DMAs,
//which occur independently of the render process.
//Display exists to put these events on a separate thread,
//so the CPU and PPU can run out-of-order.

//hdraw:    1006 cycles
//hblank:    226 cycles
//scanline: 1232 cycles

//vdraw:     160 scanlines (197120 cycles)
//vblank:     68 scanlines ( 83776 cycles)
//frame:     228 scanlines (280896 cycles)

namespace ares::GameBoyAdvance {

Display display;
#include "io.cpp"
#include "serialization.cpp"

auto Display::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("Display");
}

auto Display::unload() -> void {
  node.reset();
}

auto Display::step(u32 clocks) -> void {
  Thread::step(clocks);
  Thread::synchronize(cpu);
}

#if defined(PLATFORM_WEB)
//One of main()'s seven chunks, from wherever it would have been suspended. A second expression of
//main() below rather than a refactor of it, so that native keeps main() verbatim; the split points
//are exactly its step() calls, in order.
auto Display::runChunk() -> void {
  switch(unit.phase) {

  case 0:
    cpu.keypad.run();
    io.vblank = io.vcounter >= 160 && io.vcounter <= 226;
    step(1);
    break;

  case 1:
    io.vcoincidence = io.vcounter == io.vcompare;
    if(io.vcounter == 160) {
      if(io.irqvblank) cpu.setInterruptFlag(CPU::Interrupt::VBlank);
    }
    step(1);
    break;

  case 2:
    if(io.irqvcoincidence) {
      if(io.vcoincidence) cpu.setInterruptFlag(CPU::Interrupt::VCoincidence);
    }
    if(io.vcounter == 160) {
      cpu.dmaVblank();
    }
    step(3);
    break;

  case 3:
    if(io.vcounter == 162) {
      if(videoCapture) cpu.dmac.channel[3].enable = 0;
      videoCapture = !videoCapture && cpu.dmac.channel[3].timingMode == 3 && cpu.dmac.channel[3].enable;
    }
    if(io.vcounter >= 2 && io.vcounter < 162 && videoCapture) cpu.dmaHDMA();
    step(1002);
    break;

  case 4:
    io.hblank = 1;
    step(1);
    break;

  case 5:
    if(io.irqhblank) cpu.setInterruptFlag(CPU::Interrupt::HBlank);
    step(1);
    break;

  case 6:
    if(io.vcounter < 160) cpu.dmaHblank();
    step(223);
    break;

  //main() has one more statement after its last step(), and the cothread build is suspended inside
  //that step when it reaches it -- so the counter does not move until the display is next resumed.
  //an eighth phase with no step of its own is what reproduces that. without it the display's
  //vcounter runs a whole scanline early, the ppu reads it in beginUnit(), and one visible line in
  //every few frames is skipped and another drawn twice.
  case 7:
    io.hblank = 0;
    if(++io.vcounter == 228) io.vcounter = 0;
    break;

  }
  if(++unit.phase == 8) unit.phase = 0;
}

//run to the scanline boundary native's main() returns at, and never past it into a new one
auto Display::finishUnit() -> void {
  while(unit.phase) runChunk();
}

auto Display::webAdvance(const Thread& caller) -> bool {
  while(Thread::clock() < caller.clock()) runChunk();
  return true;
}
#endif

auto Display::main() -> void {
#if defined(PLATFORM_WEB)
  //this cothread is entered by nothing but the scheduler's synchronization protocol, and
  //CPU::mainWeb() has already run finishUnit() on the cothread the display is advanced from
  finishUnit();
#else
  cpu.keypad.run();

  io.vblank = io.vcounter >= 160 && io.vcounter <= 226;

  step(1);

  io.vcoincidence = io.vcounter == io.vcompare;

  if(io.vcounter == 160) {
    if(io.irqvblank) cpu.setInterruptFlag(CPU::Interrupt::VBlank);
  }

  step(1);

  if(io.irqvcoincidence) {
    if(io.vcoincidence) cpu.setInterruptFlag(CPU::Interrupt::VCoincidence);
  }

  if(io.vcounter == 160) {
    cpu.dmaVblank();
  }

  step(3);

  if(io.vcounter == 162) {
    if(videoCapture) cpu.dmac.channel[3].enable = 0;
    videoCapture = !videoCapture && cpu.dmac.channel[3].timingMode == 3 && cpu.dmac.channel[3].enable;
  }
  if(io.vcounter >= 2 && io.vcounter < 162 && videoCapture) cpu.dmaHDMA();

  step(1002);

  io.hblank = 1;

  step(1);
  if(io.irqhblank) cpu.setInterruptFlag(CPU::Interrupt::HBlank);

  step(1);
  if(io.vcounter < 160) cpu.dmaHblank();

  step(223);
  io.hblank = 0;
  if(++io.vcounter == 228) io.vcounter = 0;
#endif
}

auto Display::power() -> void {
  Thread::create(system.frequency(), std::bind_front(&Display::main, this));
  #if defined(PLATFORM_WEB)
  unit = {};
  #endif

  for(u32 n = 0x004; n <= 0x007; n++) bus.io[n] = this;

  io = {};
}

}
