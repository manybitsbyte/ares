#include <gba/gba.hpp>

namespace ares::GameBoyAdvance {

PPU ppu;
#include "background.cpp"
#include "object.cpp"
#include "window.cpp"
#include "dac.cpp"
#include "io.cpp"
#include "memory.cpp"
#include "color.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto PPU::setAccurate(bool value) -> void {
  accurate = value;
}

auto PPU::load(Node::Object parent) -> void {
  vram.allocate(96_KiB);
  pram.allocate(512);
  oam.allocate(512);

  node = parent->append<Node::Object>("PPU");

  screen = node->append<Node::Video::Screen>("Screen", 240, 160);

  colorEmulation = screen->append<Node::Setting::Boolean>("Color Emulation", true, [&](auto value) {
    screen->resetPalette();
  });
  colorEmulation->setDynamic(true);

  screen->colors(1 << 15, std::bind_front(&PPU::color, this));
  screen->setSize(240, 160);
  screen->setScale(1.0, 1.0);
  screen->setAspect(1.0, 1.0);
  screen->setViewport(0, 0, 240, 160);
  screen->refreshRateHint(system.frequency() / 4, 308, 228);

  interframeBlending = screen->append<Node::Setting::Boolean>("Interframe Blending", true, [&](auto value) {
    screen->setInterframeBlending(value);
  });
  interframeBlending->setDynamic(true);

  rotation = screen->append<Node::Setting::String>("Orientation", "0°", [&](auto value) {
    if(value ==   "0°") screen->setRotation(  0);
    if(value ==  "90°") screen->setRotation( 90);
    if(value == "180°") screen->setRotation(180);
    if(value == "270°") screen->setRotation(270);
  });
  rotation->setDynamic(true);
  rotation->setAllowedValues({"0°", "90°", "180°", "270°"});

  debugger.load(node);
}

auto PPU::unload() -> void {
  debugger.unload(node);
  colorEmulation.reset();
  interframeBlending.reset();
  rotation.reset();
  screen->quit();
  node->remove(screen);
  screen.reset();
  node.reset();
  vram.reset();
  pram.reset();
}

inline auto PPU::blank() -> bool {
  return io.forceBlank[0] || cpu.stopped();
}

auto PPU::step(u32 clocks) -> void {
  for(auto _ : range(clocks)) {
    objects.step();
    Thread::step(1);
    Thread::synchronize(cpu, display);
    objReleaseBus();
  }
}

template<s32 Cycle>
auto PPU::cycleLinearMap(s32 x, u32 y) -> void {
  n3 mode = PPU::Background::IO::mode;
  if constexpr(Cycle == 0) if(mode <= 1) bg0.linearFetchTileMap(x, y);
  if constexpr(Cycle == 1) if(mode <= 1) bg1.linearFetchTileMap(x, y);
  if constexpr(Cycle == 2) if(mode == 0) bg2.linearFetchTileMap(x, y);
  if constexpr(Cycle == 3) if(mode == 0) bg3.linearFetchTileMap(x, y);
}

template<s32 Cycle>
auto PPU::cycleLinearRender(s32 x, u32 y) -> void {
  n3 mode = PPU::Background::IO::mode;
  if constexpr(Cycle == 0) if(mode <= 1) bg0.linearRender(x, y);
  if constexpr(Cycle == 1) if(mode <= 1) bg1.linearRender(x, y);
  if constexpr(Cycle == 2) if(mode == 0) bg2.linearRender(x, y);
  if constexpr(Cycle == 3) if(mode == 0) bg3.linearRender(x, y);
}

template<s32 Cycle>
auto PPU::cycleAffine(u32 x, u32 y) -> void {
  n3 mode = PPU::Background::IO::mode;
  if constexpr(Cycle == 0) if(             mode == 2) bg3.affineFetchTileMap(x, y);
  if constexpr(Cycle == 1) if(             mode == 2) bg3.affineFetchTileData(x, y);
  if constexpr(Cycle == 2) if(mode == 1 || mode == 2) bg2.affineFetchTileMap(x, y);
  if constexpr(Cycle == 3) if(mode == 1 || mode == 2) bg2.affineFetchTileData(x, y);
}

auto PPU::cycleBitmap(u32 x, u32 y) -> void {
  n3 mode = PPU::Background::IO::mode;
  if(mode >= 3 && mode <= 5) bg2.bitmap(x, y);
}

auto PPU::cycleWindow(u32 x, u32 y) -> void {
  window0.run(x, y);
  window1.run(x, y);
}

auto PPU::cycleUpperLayer(u32 x, u32 y) -> void {
  ppu.bg0.outputPixel(x, y);
  ppu.bg1.outputPixel(x, y);
  ppu.bg2.outputPixel(x, y);
  ppu.bg3.outputPixel(x, y);
  ppu.objects.outputPixel(x, y);
  window2.output[x] = objects.output.window;
  dac.upperLayer(x, y);
}

template<s32 Cycle>
auto PPU::cycle(u32 y) -> void {
  if constexpr(Cycle >=  7 && Cycle <= 1037                         ) cycleLinearRender<(Cycle -  7) & 3>((Cycle - 35) >> 2, y);
  if constexpr(Cycle >=  3 && Cycle <= 1005                         ) cycleLinearMap<(Cycle -  3) & 3>((Cycle - 31) >> 2, y);
  if constexpr(Cycle >= 31 && Cycle <= 1005                         ) cycleAffine<(Cycle - 31) & 3>((Cycle - 31) >> 2, y);
  if constexpr(Cycle >= 31 && Cycle <= 1005 && (Cycle - 31) % 4 == 3) cycleBitmap((Cycle - 31) >> 2, y);
  if constexpr(Cycle >=  3 && Cycle <= 1026 && (Cycle -  3) % 4 == 0) cycleWindow((Cycle -  3) / 4, y);
  if constexpr(Cycle >= 46 && Cycle <= 1005 && (Cycle - 46) % 4 == 0) cycleUpperLayer((Cycle - 46) / 4, y);
  if constexpr(Cycle >= 46 && Cycle <= 1005 && (Cycle - 46) % 4 == 2) dac.lowerLayer((Cycle - 46) / 4, y);
  step(1);
  bgReleaseBus();
}

#if defined(PLATFORM_WEB)
//One ppu clock, from wherever main() would have been suspended. The cothread build suspends inside
//PPU::step()'s per-clock Thread::synchronize(), so the ppu's position is exact to one clock and a
//coarser twin would land the render work in the wrong place relative to the cpu.
//
//This is a second expression of main() below rather than a refactor of it, so that native keeps
//main() verbatim. The two have to be kept in step by hand; what makes that tractable is that every
//piece of scheduled work appears here at the clock main() reaches it at, and the clock arithmetic
//is written out in the comments.
auto PPU::runCycle() -> void {
  //the previous clock's bus release, deferred; see finishClock()
  finishClock();

  //main() does its per-scanline setup before its first step(4), so it belongs at clock 0
  if(unit.cycle == 0) beginUnit();

  u32 y = unit.y;
  u32 cycle = unit.cycle;

  //main() runs step(4) first, so cycle<C> executes at clock C + 1; cycles04(3) through
  //cycles08(1030) cover C = 3 to 1037, which is clocks 4 to 1038.
  if(accurate) {
    //objects.scanline() sits between cycles08(32) and cycles02(40) in the visible arm, and between
    //step(37) and step(998) in the blanking one -- clock 41 in both
    if(cycle == 41) objects.scanline((y + 1) % 228);
    if(y < 160 && cycle >= 4 && cycle <= 1038) {
      cycleAt(cycle - 1, y);
      unit.rendered = 1;  //cycle<C> ends in bgReleaseBus(), after its step
      runCycleStep();
      if(++unit.cycle == 1232) unit.cycle = 0;
      return;
    }
  } else if(cycle == 4 + renderingCycle) {
    //the whole-scanline renderer draws at one clock and steps past the rest of the line
    objects.renderScanline((y + 1) % 228);
    if(y < 160) {
      for(s32 x : range(247)) {
        bg0.run(x - 7, y);
        bg1.run(x - 7, y);
        bg2.run(x - 7, y);
        bg3.run(x - 7, y);
      }
      for(u32 x : range(256)) cycleWindow(x, y);
      for(u32 x : range(240)) {
        cycleUpperLayer(x, y);
        dac.lowerLayer(x, y);
      }
      bgReleaseBus();
    }
  }

  runCycleStep();
  if(++unit.cycle == 1232) unit.cycle = 0;
}

//PPU::step(1) without the cothread switch it ends in
auto PPU::runCycleStep() -> void {
  objects.step();
  Thread::step(1);
  //the display half of PPU::step()'s Thread::synchronize(cpu, display), and it is load-bearing:
  //beginUnit() reads display.io.vcounter, and Thread::synchronize() walks the threads in append
  //order, which puts the ppu before the display. the cpu half needs nothing -- the ppu is only ever
  //advanced up to the cpu's clock, so it can never be the one in front.
  if(!unit.retiring) while(display.clock() < Thread::clock()) display.runChunk();
  unit.pending = 1;
}

//The bus release that closes a clock. It is deferred to the start of the next one because the
//cothread build suspends between them: PPU::step()'s Thread::synchronize() sits after Thread::step()
//and before objReleaseBus(), so a cpu that resumes there still sees the ppu's access flags set and
//pays contention for them (PPU::pramContention/vramContention/oamContention). Releasing the bus
//before returning to the cpu would quietly hand it faster memory than the hardware gives it -- which
//is invisible in the default renderer, where objects.step() sets nothing, and audible in the
//pixel-accurate one, where it sets a flag on most clocks of the scanline.
auto PPU::finishClock() -> void {
  if(!unit.pending) return;
  unit.pending = 0;
  objReleaseBus();
  if(unit.rendered) {
    unit.rendered = 0;
    bgReleaseBus();
  }
}

//everything main() does before its first step(4)
auto PPU::beginUnit() -> void {
  if(display.io.vcounter == 0) {
    frame();

    bg2.io.lx = bg2.io.x;
    bg2.io.ly = bg2.io.y;

    bg3.io.lx = bg3.io.x;
    bg3.io.ly = bg3.io.y;
  }

  unit.y = display.io.vcounter;
  memory::move(io.forceBlank, io.forceBlank + 1, sizeof(io.forceBlank) - 1);
  memory::move(bg0.io.enable, bg0.io.enable + 1, sizeof(bg0.io.enable) - 1);
  memory::move(bg1.io.enable, bg1.io.enable + 1, sizeof(bg1.io.enable) - 1);
  memory::move(bg2.io.enable, bg2.io.enable + 1, sizeof(bg2.io.enable) - 1);
  memory::move(bg3.io.enable, bg3.io.enable + 1, sizeof(bg3.io.enable) - 1);
  memory::move(objects.io.enable, objects.io.enable + 1, sizeof(objects.io.enable) - 1);
  bg0.scanline(unit.y);
  bg1.scanline(unit.y);
  bg2.scanline(unit.y);
  bg3.scanline(unit.y);
  window0.scanline(unit.y);
  window1.scanline(unit.y);
  dac.scanline(unit.y);
}

//the runtime twin of cycle<Cycle>, minus its trailing step. every test here is the same test the
//template makes with if constexpr, so the two cannot disagree about which cycle does what; only the
//dispatch moves from compile time to run time, and only in the pixel-accurate mode.
auto PPU::cycleAt(s32 cycle, u32 y) -> void {
  if(cycle >= 7 && cycle <= 1037) {
    switch((cycle - 7) & 3) {
    case 0: cycleLinearRender<0>((cycle - 35) >> 2, y); break;
    case 1: cycleLinearRender<1>((cycle - 35) >> 2, y); break;
    case 2: cycleLinearRender<2>((cycle - 35) >> 2, y); break;
    case 3: cycleLinearRender<3>((cycle - 35) >> 2, y); break;
    }
  }
  if(cycle >= 3 && cycle <= 1005) {
    switch((cycle - 3) & 3) {
    case 0: cycleLinearMap<0>((cycle - 31) >> 2, y); break;
    case 1: cycleLinearMap<1>((cycle - 31) >> 2, y); break;
    case 2: cycleLinearMap<2>((cycle - 31) >> 2, y); break;
    case 3: cycleLinearMap<3>((cycle - 31) >> 2, y); break;
    }
  }
  if(cycle >= 31 && cycle <= 1005) {
    switch((cycle - 31) & 3) {
    case 0: cycleAffine<0>((cycle - 31) >> 2, y); break;
    case 1: cycleAffine<1>((cycle - 31) >> 2, y); break;
    case 2: cycleAffine<2>((cycle - 31) >> 2, y); break;
    case 3: cycleAffine<3>((cycle - 31) >> 2, y); break;
    }
  }
  if(cycle >= 31 && cycle <= 1005 && (cycle - 31) % 4 == 3) cycleBitmap((cycle - 31) >> 2, y);
  if(cycle >=  3 && cycle <= 1026 && (cycle -  3) % 4 == 0) cycleWindow((cycle - 3) / 4, y);
  if(cycle >= 46 && cycle <= 1005 && (cycle - 46) % 4 == 0) cycleUpperLayer((cycle - 46) / 4, y);
  if(cycle >= 46 && cycle <= 1005 && (cycle - 46) % 4 == 2) dac.lowerLayer((cycle - 46) / 4, y);
}

//run to the scanline boundary native's main() returns at, and never past it into a new one: a unit
//started here would make the ppu's position depend on how many times the scheduler had visited it
auto PPU::finishUnit() -> void {
  //native reaches this position during the scheduler's *auxiliary* walk, where every
  //Thread::synchronize() breaks on scheduler.synchronizing() before switching -- so the ppu runs to
  //its line boundary without carrying the display with it. the retire hook runs on the primary
  //instead, where that guard is not in force, so the suppression is explicit here. carrying the
  //display left it further along than a cothread build's, which is machine state a persistable save
  //does not describe: it read as 27 drift bytes against that build's 0.
  unit.retiring = 1;
  while(unit.cycle) runCycle();
  finishClock();
  unit.retiring = 0;
}

auto PPU::webAdvance(const Thread& caller) -> bool {
  while(Thread::clock() < caller.clock()) {
    //the whole-scanline renderer leaves nothing scheduled between three clocks of a line -- 0
    //(beginUnit), 4 + renderingCycle (the render burst, which runs to completion inside that one
    //clock), and the wrap back to 0 -- and the object unit is only mid-evaluation inside the burst
    //itself, so objects.step() is the !active early-return on every clock this stride covers. what
    //remains per clock is Thread::step(1), the display catch-up, and the pending/release toggle;
    //the toggle is unobservable between clocks because nothing in the stride sets a bus flag, and
    //the other two sum: step(n) is n step(1)s by arithmetic, and the display only writes cpu state
    //the cpu cannot read before this call returns. the stride never covers the three clocks above,
    //so this is runCycle() verbatim for every clock anyone can observe.
    u32 renderAt = 4 + renderingCycle;
    if(!accurate && !objects.active && unit.cycle != 0 && unit.cycle != renderAt) {
      u32 next = unit.cycle < renderAt ? renderAt : 1232;
      u64 wanted = (caller.clock() - Thread::clock() + scalar() - 1) / scalar();
      u32 n = u32(min<u64>(next - unit.cycle, wanted));
      if(n > 1) {
        finishClock();
        Thread::step(n);
        if(!unit.retiring) while(display.clock() < Thread::clock()) display.runChunk();
        unit.pending = 1;
        unit.cycle += n;
        if(unit.cycle == 1232) unit.cycle = 0;
        continue;
      }
    }
    runCycle();
  }
  return true;
}
#endif

auto PPU::main() -> void {
#if defined(PLATFORM_WEB)
  //this cothread is entered by nothing but the scheduler's synchronization protocol, which takes
  //its safe point before the entry point runs; CPU::mainWeb() has already run finishUnit() on the
  //cothread the ppu is actually advanced from, so there is nothing left here to do. starting a
  //scanline would put the ppu a whole one ahead of where native's main() returns.
  finishUnit();
#else
  if(display.io.vcounter == 0) {
    frame();

    bg2.io.lx = bg2.io.x;
    bg2.io.ly = bg2.io.y;

    bg3.io.lx = bg3.io.x;
    bg3.io.ly = bg3.io.y;
  }

  u32 y = display.io.vcounter;
  memory::move(io.forceBlank, io.forceBlank + 1, sizeof(io.forceBlank) - 1);
  memory::move(bg0.io.enable, bg0.io.enable + 1, sizeof(bg0.io.enable) - 1);
  memory::move(bg1.io.enable, bg1.io.enable + 1, sizeof(bg1.io.enable) - 1);
  memory::move(bg2.io.enable, bg2.io.enable + 1, sizeof(bg2.io.enable) - 1);
  memory::move(bg3.io.enable, bg3.io.enable + 1, sizeof(bg3.io.enable) - 1);
  memory::move(objects.io.enable, objects.io.enable + 1, sizeof(objects.io.enable) - 1);
  bg0.scanline(y);
  bg1.scanline(y);
  bg2.scanline(y);
  bg3.scanline(y);
  window0.scanline(y);
  window1.scanline(y);
  dac.scanline(y);

  step(4);

  if(y < 160) {
    if(accurate) {
      #define cycles01(index) cycle<index>(y)
      #define cycles02(index) cycles01(index); cycles01(index +  1)
      #define cycles04(index) cycles02(index); cycles02(index +  2)
      #define cycles08(index) cycles04(index); cycles04(index +  4)
      #define cycles16(index) cycles08(index); cycles08(index +  8)
      #define cycles32(index) cycles16(index); cycles16(index + 16)
      #define cycles64(index) cycles32(index); cycles32(index + 32)

      //cycle 3 - earliest possible background render cycle
      cycles04(  3);
      cycles08(  7);
      cycles08( 15);
      cycles08( 23);

      //cycle 31 - start rendering backgrounds unconditionally
      cycles01( 31);
      cycles08( 32);

      //cycle 40 - start rendering sprites
      objects.scanline((y + 1) % 228);
      cycles02( 40);
      cycles04( 42);

      //cycle 46 - start pixel output
      cycles64( 46);
      cycles64(110);
      cycles64(174);
      cycles64(238);
      cycles64(302);
      cycles64(366);
      cycles64(430);
      cycles64(494);
      cycles64(558);
      cycles64(622);
      cycles64(686);
      cycles64(750);
      cycles64(814);
      cycles64(878);
      cycles64(942);

      //cycle 1006 - finish rendering final background tiles
      cycles08(1006);
      cycles08(1014);
      cycles08(1022);
      cycles08(1030);

      #undef cycles02
      #undef cycles04
      #undef cycles08
      #undef cycles16
      #undef cycles32
      #undef cycles64
    } else {
      step(renderingCycle);
      objects.renderScanline((y + 1) % 228);
      for(s32 x : range(247)) {
        bg0.run(x - 7, y);
        bg1.run(x - 7, y);
        bg2.run(x - 7, y);
        bg3.run(x - 7, y);
      }
      for(u32 x : range(256)) cycleWindow(x, y);
      for(u32 x : range(240)) {
        cycleUpperLayer(x, y);
        dac.lowerLayer(x, y);
      }
      bgReleaseBus();
      step(1035 - renderingCycle);
    }
  } else {
    if(accurate) {
      step(37);
      objects.scanline((y + 1) % 228);
      step(998);
    } else {
      step(renderingCycle);
      objects.renderScanline((y + 1) % 228);
      step(1035 - renderingCycle);
    }
  }

  step(193);
#endif
}

auto PPU::frame() -> void {
  system.controls.poll();
  screen->frame();
  scheduler.exit(Event::Frame);
}

auto PPU::power() -> void {
  Thread::create(system.frequency(), std::bind_front(&PPU::main, this));
  #if defined(PLATFORM_WEB)
  unit = {};
  #endif
  screen->power();

  for(u32 n = 0x000; n <= 0x055; n++) bus.io[n] = this;

  for(u32 n = 0; n < 96 * 1024; n++) vram[n] = 0x00;
  for(u32 n = 0; n < 1024; n += 2) writePRAM(Half, n, 0x0000);
  for(u32 n = 0; n < 1024; n += 2) writeOAM(Half, n, 0x0000);

  io = {};

  bg0.power(BG0);
  bg1.power(BG1);
  bg2.power(BG2);
  bg3.power(BG3);
  objects.power();
  window0.power(IN0);
  window1.power(IN1);
  window2.power(IN2);
  window3.power(OUT);
  dac.power();

  renderingCycle = 42;  //by default, render at first cycle of pixel output
  string gameID;
  for(u32 index : range(4)) {
    n32 address = 0xac + index;
    char byte = cartridge.readRom<true>(address).byte(address & 1);
    gameID.append(byte);
  }
  if(gameID == "AWRE") renderingCycle = 512;  //Advance Wars (USA)
  if(gameID == "AWRP") renderingCycle = 512;  //Advance Wars (Europe) (En,Fr,De,Es)
}

}
