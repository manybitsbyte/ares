#include <ng/ng.hpp>

namespace ares::NeoGeo {

LSPC lspc;
#include "color.cpp"
#include "render.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto LSPC::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("LSPC");

  screen = node->append<Node::Video::Screen>("Screen", 320, 256);
  screen->colors(1 << 17, std::bind_front(&LSPC::color, this));
  screen->setSize(320, 256);
  screen->setScale(1.0, 1.0);
  screen->setAspect(1.0, 1.0);
  screen->refreshRateHint(6'000'000, 384, 264);

  vram.allocate(68_KiB >> 1);
  pram.allocate(16_KiB >> 1);

  debugger.load(node);

  set<u8> bytes;
  u64 vbits = bit::reverse<u64>(0x0123456789abcdefULL);
  memory::fill<n8>(vscale, sizeof(vscale), 0xff);
  for(u8 y : range(256)) {
    n4 upper = vbits >> (y & 15 ^ 1) * 4;
    n4 lower = vbits >> (y >> 4 ^ 1) * 4;
    bytes.insert(upper << 4 | lower << 0);
    u8 x = 0; for(auto& byte : bytes) vscale[y][x++] = byte;
  }

  u64 hbits = 0x5b1d7f390a6e2c48ULL;
  memory::fill<n1>(hscale, sizeof(hscale), 0x00);
  for(u8 y : range(16)) {
    for(u8 x : reverse(range(y + 1))) {
      n4 value = hbits >> x * 4;
      hscale[y][value] = 1;
    }
  }
}

auto LSPC::unload() -> void {
  debugger.unload(node);
  vram.reset();
  pram.reset();
  screen->quit();
  node->remove(screen);
  screen.reset();
  node.reset();
}

auto LSPC::step(u32 clocks) -> void {
  if(timer.counter && !--timer.counter) {
    if(timer.reloadOnZero) {
      timer.counter = timer.reload;
    }
    if(irq.timerAcknowledge && timer.interruptEnable) {
      irq.timerAcknowledge = 0;
      cpu.raise(CPU::Interrupt::Timer);
    }
  }
  Thread::step(clocks);
  Thread::synchronize();
}
#if !defined(PLATFORM_WEB)
auto LSPC::main() -> void {
  step(1);
  if(++io.hcounter == 384) {
    io.hcounter = 0;
    if(++io.vcounter == 264) {
      io.vcounter = 0;
      if(!animation.counter--) {
        animation.counter = animation.speed;
        animation.frame++;
      }
      if(irq.vblankAcknowledge) {
        irq.vblankAcknowledge = 0;
        cpu.raise(CPU::Interrupt::Vblank);
      }
      if(timer.reloadOnVblank) {
        timer.counter = timer.reload;
      }
      frame();
    }
  }

  // 8 lines of vblank, 16px top border, 16px bottom border
  if(io.vcounter >= 24 && io.vcounter <= 247 && io.hcounter == 56) {
    render(io.vcounter - 8);
  }
}
#endif
auto LSPC::frame() -> void {
  screen->setViewport(0, 0, 320, 256);
  screen->frame();
  scheduler.exit(Event::Frame);
}

auto LSPC::power(bool reset) -> void {
  Thread::create(6'000'000, std::bind_front(&LSPC::main, this));
  screen->power();
  animation = {};
  timer = {};
  irq = {};
  io = {};
  #if defined(PLATFORM_WEB)
  //a synchronized state is restored through power(false), and a persistable state carries no tail
  //flag -- the tail was retired before the save -- so whatever the live machine owed before the
  //restore is owed no longer. a run-ahead restore then reloads the serialized flag over this.
  //(power itself must also start with no tail owed, exactly as a fresh cothread holds no suspended
  //position.)
  web = {};
  #endif
  cpu.raise(CPU::Interrupt::Power);
}

}
#if defined(PLATFORM_WEB)
//the web expression of the lspc's advance. native's main() is kept verbatim above, inside
//#if !defined(PLATFORM_WEB); these live at end of file because a skipped preprocessor region
//swallows the blank lines on both of its edges, and here there is nothing to swallow.
namespace ares::NeoGeo {

//the cothread build suspends inside step(1) -- after the timer tick and the clock step, before
//the counter increments and the render -- because that is where Thread::synchronize switches
//away. one runCycle() therefore finishes the previous clock's tail first and then performs the
//next clock's step, leaving the lspc in exactly the mid-clock position the cothread build is
//observable in: the tail an lspc clock owes is deferred until the cpu has run past that clock,
//which is when the cothread build's resume would have executed it.
auto LSPC::runCycle() -> void {
  finishCycle();
  step(1);
  web.tailPending = 1;
}

//the tail of native main() after its step(1), verbatim. also the retire hook CPU::main() runs
//before a synchronized save: the scheduler's auxiliary walk completes this tail from the native
//build's suspended cothread, and a chip advanced by plain calls has no suspended position to
//complete it from, so the driving cothread does it on the chip's behalf.
auto LSPC::finishCycle() -> void {
  if(!web.tailPending) return;
  web.tailPending = 0;
  if(++io.hcounter == 384) {
    io.hcounter = 0;
    if(++io.vcounter == 264) {
      io.vcounter = 0;
      if(!animation.counter--) {
        animation.counter = animation.speed;
        animation.frame++;
      }
      if(irq.vblankAcknowledge) {
        irq.vblankAcknowledge = 0;
        cpu.raise(CPU::Interrupt::Vblank);
      }
      if(timer.reloadOnVblank) {
        timer.counter = timer.reload;
      }
      frame();
    }
  }

  // 8 lines of vblank, 16px top border, 16px bottom border
  if(io.vcounter >= 24 && io.vcounter <= 247 && io.hcounter == 56) {
    render(io.vcounter - 8);
  }
}

//reached only by the scheduler's synchronization protocol: the web build advances this chip
//through runCycle() on the cpu's cothread, and the pending tail is retired by CPU::main() before
//the walk arrives, so there is nothing left to do here. running a fresh clock instead would make
//the lspc's position depend on how many times its cothread had been entered.
auto LSPC::main() -> void {
  finishCycle();
}

}
#endif
