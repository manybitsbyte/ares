#include <pce/pce.hpp>

namespace ares::PCEngine {

VDPBase vdp;
VDP vdpImpl;

#define vdp vdpImpl

#include "vce.cpp"
#include "vdc.cpp"
#include "vpc.cpp"
#include "irq.cpp"
#include "dma.cpp"
#include "background.cpp"
#include "sprite.cpp"
#include "color.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto VDPBase::setAccurate(bool value) -> void {
  accurate = value;
  if(value) {
    implementation = &vdpImpl;
    vce = &vdpImpl.vce;
    vdc0 = &vdpImpl.vdc0;
    vdc1 = &vdpImpl.vdc1;
    vpc = &vdpImpl.vpc;
  } else {
    implementation = &vdpPerformanceImpl;
    vce = &vdpPerformanceImpl.vce;
    vdc0 = &vdpPerformanceImpl.vdc0;
    vdc1 = &vdpPerformanceImpl.vdc1;
    vpc = &vdpPerformanceImpl.vpc;
  }
}

auto VDP::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("VDP");

  screen = node->append<Node::Video::Screen>("Screen", 1365, 263);
  colorEmulation = screen->append<Node::Setting::Boolean>("Color Emulation", true, [&](auto value) {
    screen->resetPalette();
  });
  colorEmulation->setDynamic(true);
  screen->colors(1 << 10, std::bind_front(&VDP::color, this));
  screen->setSize(1128, 263);
  screen->setScale(0.25, 1.0);
  screen->setAspect(8.0, 7.0);
  screen->refreshRateHint(60); // TODO: More accurate refresh rate hint

  vce.debugger.load(vce, node);
  vdc0.debugger.load(vdc0, node); if(Model::SuperGrafx())
  vdc1.debugger.load(vdc1, node);
}

auto VDP::unload() -> void {
  vce.debugger = {};
  vdc0.debugger = {}; if(Model::SuperGrafx())
  vdc1.debugger = {};
  screen->quit();
  node->remove(screen);
  screen.reset();
  node.reset();
}

#if defined(PLATFORM_WEB)
//A second expression of main() below, not a refactor of it: native keeps its scanline verbatim.
//
//main() is one whole scanline, and the cpu suspends it partway through -- the step() inside the dot
//loop synchronizes the cpu back, so the cothread build leaves the vdp a few dots past the cpu and no
//further. Advancing it by plain function calls has no suspension point, so a whole main() per call
//would leave it up to a scanline ahead, and the cpu can see that: it reads the vdc status port and
//takes IRQ1 off vdp.irqLine(). The dot loop is therefore split into one call per iteration.
//
//The only state main() keeps in locals is `output`, and io.hcounter tracks it exactly: every
//iteration writes vce.clock() pixels and steps hcounter by the same vce.clock(), so
//output == pixels + 1365 * vcounter + hcounter holds at the top of every iteration and after every
//step. Reconstructing it from the counters is what lets a chunk stand alone, and reading the base
//per chunk rather than per line is what keeps it right across screen->frame(), which swaps the two
//canvases underneath it.
template<bool supergrafx> auto VDP::runChunk() -> void {
  auto output = screen->pixels().data() + 1365 * io.vcounter;

  if(io.hcounter == 0) {
    vdc0.hsync(); if(supergrafx)
    vdc1.hsync();

    if(io.vcounter == 0) {
      vdc0.vsync(); if(supergrafx)
      vdc1.vsync();
    }
  }

  if(io.hcounter <= 1360) {
    output += io.hcounter;
    vdc0.hclock(); if(supergrafx)
    vdc1.hclock();

    n14 color;
    if(!supergrafx) color = vdc0.bus();
    if( supergrafx) color = vpc.bus(io.hcounter);
    color = vce.io.grayscale << 9 | vce.cram.read((n9)color) | color.bit(8, 11) << 10;

    switch(vce.clock()) {
    case 4: *output++ = color; [[fallthrough]];
    case 3: *output++ = color; [[fallthrough]];
    case 2: *output++ = color; [[fallthrough]];
    case 1: *output++ = color;
    }

    step<supergrafx>(vce.clock());
    return;
  }

  auto outputStart = output;
  output += io.hcounter;

  step<supergrafx>(1365 - io.hcounter);
  vdc0.vclock(); if(Model::SuperGrafx())
  vdc1.vclock();

  if (Model::LaserActive() && (io.vcounter < 262)) {
    pcd.ld.scanline(outputStart, io.vcounter);
  }
  while (outputStart < output) {
    *(outputStart++) &= 0b1111111111;
  }

  io.hcounter = 0;
  if(++io.vcounter >= 262 + vce.io.extraLine) {
    io.vcounter = 0;

    if(screen->overscan()) {
      screen->setSize(1128+(24*2), 263);
      screen->setViewport(0, 0, screen->width(), screen->height());
    } else {
      screen->setSize(1128-(48+24)-24, 263-(21+12)-12);
      screen->setViewport(48+24, 21+12, screen->width(), screen->height());
    }
    screen->frame();

    scheduler.exit(Event::Frame);
  }
}

//run to the scanline boundary main() returns at, and never past it into a new one: a line started
//here would make the vdp's position depend on how many times the scheduler had visited it, which a
//persistable save state records and the cothread build does not have.
auto VDP::finishUnit() -> void {
  if(Model::SuperGrafx()) { while(io.hcounter) runChunk<true>();  }
  else                    { while(io.hcounter) runChunk<false>(); }
}

auto VDP::webAdvance(const Thread& caller) -> bool {
  //the closing chunk waits for the caller to cover the whole of it. main() closes a line from the
  //vdp's own cothread, where the closing step()'s synchronize(cpu) carries the cpu to the end of the
  //line before vclock() runs -- so the cpu sees the line's last dots with irqLine() still holding
  //its pre-vclock value, and Event::Frame is raised only once the cpu is there too. running that
  //chunk as soon as any part of it is covered raised the frame a few clocks early, which parks the
  //machine at a different safe point: a synchronized save then finds the vdp a whole line behind the
  //cothread build's, because the scheduler resumes into a line the cothread build has already begun.
  auto ready = [&] {
    if(Thread::clock() >= caller.clock()) return false;
    if(io.hcounter <= 1360) return true;
    return Thread::clock() + (1365 - io.hcounter) * scalar() <= caller.clock();
  };
  if(Model::SuperGrafx()) { while(ready()) runChunk<true>();  }
  else                    { while(ready()) runChunk<false>(); }
  return true;
}
#endif

template<bool supergrafx> auto VDP::main() -> void {
  #if defined(PLATFORM_WEB)
  //this cothread is entered by nothing but the scheduler's synchronization protocol, which takes its
  //safe point before the entry point runs; CPU::mainWeb() has already run finishUnit() on the
  //cothread the vdp is actually advanced from, so there is nothing left here to do. starting a
  //scanline would put the vdp a whole one ahead of where main() returns.
  return finishUnit();
  #endif
  vdc0.hsync(); if(supergrafx)
  vdc1.hsync();

  if(io.vcounter == 0) {
    vdc0.vsync(); if(supergrafx)
    vdc1.vsync();
  }

  auto output = screen->pixels().data() + 1365 * io.vcounter;
  auto outputStart = output;

  while(io.hcounter <= 1360) {
    vdc0.hclock(); if(supergrafx)
    vdc1.hclock();

    n14 color;
    if(!supergrafx) color = vdc0.bus();
    if( supergrafx) color = vpc.bus(io.hcounter);
    color = vce.io.grayscale << 9 | vce.cram.read((n9)color) | color.bit(8, 11) << 10;

    switch(vce.clock()) {
    case 4: *output++ = color; [[fallthrough]];
    case 3: *output++ = color; [[fallthrough]];
    case 2: *output++ = color; [[fallthrough]];
    case 1: *output++ = color;
    }

    step<supergrafx>(vce.clock());
  }

  step<supergrafx>(1365 - io.hcounter);
  vdc0.vclock(); if(Model::SuperGrafx())
  vdc1.vclock();

  if (Model::LaserActive() && (io.vcounter < 262)) {
    pcd.ld.scanline(outputStart, io.vcounter);
  }
  while (outputStart < output) {
    *(outputStart++) &= 0b1111111111;
  }

  io.hcounter = 0;
  if(++io.vcounter >= 262 + vce.io.extraLine) {
    io.vcounter = 0;

    if(screen->overscan()) {
      screen->setSize(1128+(24*2), 263);
      screen->setViewport(0, 0, screen->width(), screen->height());
    } else {
      screen->setSize(1128-(48+24)-24, 263-(21+12)-12);
      screen->setViewport(48+24, 21+12, screen->width(), screen->height());
    }
    screen->frame();

    scheduler.exit(Event::Frame);
  }
}

template<bool supergrafx> auto VDP::step(u32 clocks) -> void {
  io.hcounter += clocks;
  vdc0.dma.step(clocks); if(supergrafx)
  vdc1.dma.step(clocks);

  Thread::step(clocks);
  synchronize(cpu);
}

auto VDP::power() -> void {
  if(Model::SuperGrafx()) Thread::create(system.colorburst() * 6.0, std::bind_front(&VDP::main<true>, this));
  else                    Thread::create(system.colorburst() * 6.0, std::bind_front(&VDP::main<false>, this));

  screen->power();

  vce.power();
  vdc0.power(); if(Model::SuperGrafx())
  vdc1.power(); if(Model::SuperGrafx())
  vpc.power();
}

}
