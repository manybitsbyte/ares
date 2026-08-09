auto VDP::step(u32 clocks) -> void {
  Thread::step(clocks);
  Thread::synchronize(cpu);
}

template<bool _h40> auto VDP::fullslotStep() -> void {
  // EDCLK hybrid rate : 15cyc @ MClk/5 + 2cyc @ MClk/4
  static u8 EDCLK[17] = {5,5,5,5,5, 5,5,5,5,5, 5,5,5,5,5, 4,4};
  if(( _h40 && latch.clockSelect && hcounter() >= 0xe6 && hcounter() <= 0xf6) ||
     (!_h40 && latch.clockSelect && hcounter() >= 0xec && hcounter() <= 0xfc)) {
    u32 q1 = EDCLK[state.edclkPos];
    state.edclkPos = (state.edclkPos+1) % 17;
    u32 q2 = EDCLK[state.edclkPos];
    state.edclkPos = (state.edclkPos+1) % 17;
    u32 q3 = EDCLK[state.edclkPos];
    state.edclkPos = (state.edclkPos+1) % 17;
    u32 q4 = EDCLK[state.edclkPos];
    state.edclkPos = (state.edclkPos+1) % 17;
    step(q1+q2+q3+q4);
    return;
  }
  if(_h40)
    step(4+4+4+4); // MClk/4
  else
    step(5+5+5+5); // MClk/5
}

template<bool _h40, bool _refresh> auto VDP::tick() -> void {
  // Run DMA here -- fifo & prefetch have ram priority, so somes ops may be blocked
  dma.run();

  fullslotStep<_h40>();
  tickTail<_h40>(_refresh);
}

template<bool _h40> auto VDP::tickTail(bool refresh) -> void {
  htick<_h40>(); // +2 pixels

  if(cram.bus.active) {
    vdp.dac.dot(hcounter()*2+1, cram.bus.data);

    // DAC dot artifacts may be drawn continuously in the case of consectutive writes.
    // We can detect for this by checking for an impending CRAM write thru the fifo.
    // If refresh or fifo delay occurs, the data will not be updated, resulting in an extended dot.
    // Note: we're not currently checking for back-to-back slots when display is enabled.
    if(displayEnable() || fifo.slots[0].empty() || fifo.slots[0].target != 3)
      cram.bus.active = 0;
    else {
      if(fifo.slots[0].latency > 1 || vram.refreshing) cram.bus.data = vdp.cram.color(vdp.io.backgroundColor);
      vdp.dac.dot(hcounter()*2+2, cram.bus.data);
    }
  }

  // There is reportedly a latch effect when enabling the display, but it might be a fixed delay
  // rather than a wait until the fifo clears. So, this is precautionary and not necessily correct.
  if(latch.displayEnable > io.displayEnable || fifo.empty())
    latch.displayEnable = io.displayEnable;

  if(refresh) {
    vram.refreshing = 1;

    // The start of a DMA load will be aligned if it coincides with a refresh slot.
    // The duration may differ between H32 & H40 due to pixel clock, or this may just
    // be the result of some other emulation inaccuracy. Either way, this works for now.
    if(dma.active && dma.preload > 0) dma.preload = h40()?6:4;
  } else {
    fifo.tick();

    // When display is blanked, DMA load fetch may be performed in every slot
    // except for refresh slots and any slot immediately following refresh.
    if(dma.active && !vram.refreshing) dma.fetch();
    vram.refreshing = 0;

    if(dma.active && dma.preload > 0) dma.preload--;
  }

  state.rambusy = 1;
}

auto VDP::vblankcheck() -> void {
  if(v28()) {
    if(vcounter() == 0x0e0) vblank(1);
    if(vcounter() == 0x1ff) vblank(0);
  }
  if(v30()) {
    if(vcounter() == 0x0f0) vblank(1);
    if(vcounter() == 0x1ff) vblank(0);
  }
}

template<bool _h40> auto VDP::htick() -> void {
  state.hcounter++;

  if(_h40) {
    if(hcounter() == 0x00) vedge();
    else if(hcounter() == 0x05) hblank(0);
    else if(hcounter() == 0xa5) vtick();
    else if(hcounter() == 0xb3) hblank(1);
    else if(hcounter() == 0xb6) state.hcounter = 0xe4;
  } else {
    if(hcounter() == 0x00) vedge();
    else if(hcounter() == 0x05) hblank(0);
    else if(hcounter() == 0x85) vtick();
    else if(hcounter() == 0x93) hblank(1);
    else if(hcounter() == 0x94) state.hcounter = 0xe9;
  }

  irq.poll();
}

auto VDP::vtick() -> void {
  if(vblank()) {
    irq.hblank.counter = irq.hblank.frequency;
  } else if(irq.hblank.counter-- == 0) {
    irq.hblank.counter = irq.hblank.frequency;
    irq.hblank.pending = 1;
    irq.delay = h40() ? 3 : 2; // 4-6 pixel delay (~6 M68k cycles)
    debugger.interrupt(CPU::Interrupt::HorizontalBlank);
  }

  if(vcounter() == state.bottomline)
    state.vcounter = state.topline;
  else
    state.vcounter++;

  vblankcheck();
}

auto VDP::hblank(bool line) -> void {
  state.hblank = line;
  if(hblank() == 0) {
    cartridge.hblank(0);
  } else {
    cartridge.hblank(1);
  }
}

auto VDP::vblank(bool line) -> void {
  irq.vblank.transitioned |= state.vblank ^ line;
  if(state.vblank > line) state.topline = vcounter();
  state.vblank = line;
}

auto VDP::vedge() -> void {
  apu.setINT(0);
  if(!irq.vblank.transitioned) return;
  irq.vblank.transitioned = 0;

  if(vblank() == 0) {
    cartridge.vblank(0);
  } else {
    cartridge.vblank(1);
    apu.setINT(1);
    irq.vblank.pending = 1;
    irq.delay = h40() ? 3 : 2; // 4-6 pixel delay (~6 M68k cycles)
    debugger.interrupt(CPU::Interrupt::VerticalBlank);
  }
}

auto VDP::slot() -> void {
  state.rambusy = 0;
  if(!(state.rambusy = fifo.run()))
    state.rambusy = prefetch.run();
}

auto VDP::main() -> void {
  #if defined(PLATFORM_WEB)
  //route the cothread's entry point through the flat stepper so web.slot stays consistent however
  //the vdp is advanced; while running, the cpu advances the vdp through runCycle() directly and
  //this cothread is only entered by the scheduler's synchronization protocol.
  runCycle();
  #else
  latch.displayWidth = io.displayWidth;
  latch.clockSelect  = io.clockSelect;
  state.edclkPos = 0;
  if(h32()) mainH32();
  else
  if(h40()) mainH40();
  if(vcounter() == state.bottomline) {
    screen->setColorBleedWidth(latch.displayWidth ? 4 : 5);
    latch.interlace = io.interlaceMode.bit(0);
    latch.overscan  = io.overscan;
    frame();
    state.field ^= 1;
    updateScreenParams();
  }
  #endif
}

auto VDP::mainH32() -> void {
  dac.pixels = vdp.pixels();
  auto pixels = dac.active = dac.pixels+13*5;
  state.hcounter = 0;

  sprite.begin();
  if(dac.pixels) {
    blocks<false, true>();
    if(Mega32X()) m32x.vdp.scanline(pixels + 13, vcounter()); //approx 3 and 1/4 pixel offset in H40 pixels
    if(MegaLD()) mcd.ld.scanline(dac.pixels, vcounter());
  } else {
    blocks<false, false>();
    if(MegaLD()) mcd.ld.scanline(dac.pixels, vcounter());
  }

  tick<false>(); slot();
  tick<false>(); slot();

  layers.vscrollFetch();
  sprite.end();

  for(auto cycle : range(4)) {
    tick<false>(); sprite.patternFetch(cycle + 0);
  }
  for(auto cycle : range(13)) {
    tick<false>(); sprite.patternFetch(cycle + 4); sprite.scan();
  }
  // Placement of this free slot conflicts with documentation by Nemesis which has it 4 slots earlier,
  // but this works more reliably with the Direct Color DMA demos.
  tick<false>(); slot();
  // window begin call (reg latch) is placed here due to garbage line edge case in International Superstar Soccer Deluxe (E)
  window.begin();
  for(auto cycle : range(9)) {
    tick<false>(); sprite.patternFetch(cycle + 17); sprite.scan();
  }
  tick<false>(); slot();

  layerA.begin();
  layerB.begin();

  tick<false>(); layers.hscrollFetch();
  tick<false>(); sprite.patternFetch(26); sprite.scan();
  tick<false>(); sprite.patternFetch(27); sprite.scan();
  tick<false>(); sprite.patternFetch(28); sprite.scan();
  tick<false>(); sprite.patternFetch(29); sprite.scan();

  layers.vscrollFetch(-1);
  layerA.attributesFetch();
  layerB.attributesFetch();
  window.attributesFetch(-1);

  tick<false>(); layerA.mappingFetch(-1);
  if(!displayEnable()) {
    tick<false,true>(); //refresh
  } else {
    tick<false>(); sprite.patternFetch(30); sprite.scan();
  }
  tick<false>(); layerA.patternFetch( 0); sprite.scan();
  tick<false>(); layerA.patternFetch( 1); sprite.scan();
  tick<false>(); layerB.mappingFetch(-1);
  tick<false>(); sprite.patternFetch(31); sprite.scan();
  tick<false>(); layerB.patternFetch( 0); sprite.scan();
  tick<false>(); layerB.patternFetch( 1); sprite.scan();
}

auto VDP::mainH40() -> void {
  dac.pixels = vdp.pixels();
  auto pixels = dac.active = dac.pixels+13*4;
  state.hcounter = 0;

  sprite.begin();
  if(dac.pixels) {
    blocks<true, true>();
    if(Mega32X()) m32x.vdp.scanline(pixels, vcounter());
    if(MegaLD()) mcd.ld.scanline(dac.pixels, vcounter());
  } else {
    blocks<true, false>();
    if(MegaLD()) mcd.ld.scanline(dac.pixels, vcounter());
  }

  tick<true>(); slot();
  tick<true>(); slot();

  layers.vscrollFetch();
  sprite.end();

  for(auto cycle : range(4)) {
    tick<true>(); sprite.patternFetch(cycle + 0);
  }
  for(auto cycle : range(19)) {
    tick<true>(); sprite.patternFetch(cycle + 4); sprite.scan();
  }
  tick<true>(); slot();
  for(auto cycle : range(11)) {
    tick<true>(); sprite.patternFetch(cycle + 23); sprite.scan();
  }

  layerA.begin();
  layerB.begin();
  window.begin();

  tick<true>(); layers.hscrollFetch();
  tick<true>(); sprite.patternFetch(34); sprite.scan();
  tick<true>(); sprite.patternFetch(35); sprite.scan();
  tick<true>(); sprite.patternFetch(36); sprite.scan();
  tick<true>(); sprite.patternFetch(37); sprite.scan();

  layers.vscrollFetch(-1);
  layerA.attributesFetch();
  layerB.attributesFetch();
  window.attributesFetch(-1);

  tick<true>(); layerA.mappingFetch(-1);
  if(!displayEnable()) {
    tick<true,true>(); //refresh
  } else {
    tick<true>(); sprite.patternFetch(38); sprite.scan();
  }
  tick<true>(); layerA.patternFetch( 0); sprite.scan();
  tick<true>(); layerA.patternFetch( 1); sprite.scan();
  tick<true>(); layerB.mappingFetch(-1);
  tick<true>(); sprite.patternFetch(39); sprite.scan();
  tick<true>(); layerB.patternFetch( 0); sprite.scan();
  tick<true>(); layerB.patternFetch( 1); sprite.scan();
}

template<bool _h40, bool _pixels> auto VDP::blocks() -> void {
  bool top = vcounter() == state.topline;
  dac.fillLeftBorder();
  for(auto block : range(_h40 ? 20 : 16)) {
    layers.vscrollFetch(block);
    layerA.attributesFetch();
    layerB.attributesFetch();
    window.attributesFetch(block);
    tick<_h40>(); layerA.mappingFetch(block);
    if((block & 3) == 3) {
      tick<_h40,true>(); //refresh
    } else {
      tick<_h40>(); slot();
    }
    bool den = displayEnable();
    tick<_h40>(); layerA.patternFetch(block * 2 + 2);
    tick<_h40>(); layerA.patternFetch(block * 2 + 3);
    tick<_h40>(); layerB.mappingFetch(block);
    tick<_h40>(); sprite.mappingFetch(block);
    tick<_h40>(); layerB.patternFetch(block * 2 + 2);
    tick<_h40>(); layerB.patternFetch(block * 2 + 3);

    if(_pixels) {
      if(!den || top) {
        for(auto pixel: range(16)) dac.pixel<_h40, false>(block * 16 + pixel);
      } else {
        for(auto pixel: range(16)) dac.pixel<_h40, true>(block * 16 + pixel);
      }
    }
  }
  dac.fillRightBorder();
}

#if defined(PLATFORM_WEB)
//the flat twin of main(), advancing the vdp with plain function calls instead of cothread
//switches (see CPU::catchUpVDP), which under Asyncify are the dominant cost of cycle-accurate
//scheduling. in the cothread build control returns to the cpu from inside a tick's step, before
//htick() and the slot's fetch work run, so each runCycle() call ends right after a step and the
//crossing slot's tail and action are completed by the next call: the vdp is observable in
//exactly the same mid-tick position as the cothread build leaves it. any divergence from
//tick()/mainH32()/mainH40()/blocks() here is a bug.
auto VDP::runCycle() -> void {
  //complete the slot whose step the previous call performed
  if(web.pending) {
    web.pending = 0;
    if(h32()) finishSlot<false>();
    else
    if(h40()) finishSlot<true>();
  }

  if(web.slot == 0) {
    //main() latches these before selecting the scanline mode
    latch.displayWidth = io.displayWidth;
    latch.clockSelect  = io.clockSelect;
    state.edclkPos = 0;
  }

  if(h32()) stepSlot<false>();
  else
  if(h40()) stepSlot<true>();
}

//everything mainH32()/mainH40() perform before the current slot's step: the scanline prologue,
//the zero-time fetches preceding the tick, and the tick's dma.run(); then the step itself.
template<bool _h40> auto VDP::stepSlot() -> void {
  constexpr u32 blockCount = _h40 ? 20 : 16;
  constexpr u32 blockSlots = blockCount * 8;
  u32 s = web.slot;

  web.refresh = 0;
  if(s == 0) {
    dac.pixels = vdp.pixels();
    dac.active = dac.pixels + 13 * (_h40 ? 4 : 5);
    state.hcounter = 0;
    sprite.begin();
    web.top = vcounter() == state.topline;  //blocks() samples this before its first tick
    dac.fillLeftBorder();
  }

  if(s < blockSlots) {
    u32 block = s >> 3;
    switch(s & 7) {
    case 0:
      layers.vscrollFetch(block);
      layerA.attributesFetch();
      layerB.attributesFetch();
      window.attributesFetch(block);
      break;
    case 1:
      web.refresh = (block & 3) == 3;
      break;
    case 2:
      web.den = displayEnable();  //blocks() samples den here
      break;
    }
  } else {
    u32 o = s - blockSlots;
    if(o == (_h40 ? 42 : 35)) {
      layers.vscrollFetch(-1);
      layerA.attributesFetch();
      layerB.attributesFetch();
      window.attributesFetch(-1);
    }
    if(o == (_h40 ? 43 : 36)) web.refresh = !displayEnable();
  }

  // Run DMA here -- fifo & prefetch have ram priority, so somes ops may be blocked
  dma.run();
  fullslotStep<_h40>();
  web.pending = 1;
}

//everything tick() performs after its step, then the fetch or render action that
//mainH32()/mainH40() perform after that tick; ends the scanline after its final slot.
template<bool _h40> auto VDP::finishSlot() -> void {
  constexpr u32 blockCount = _h40 ? 20 : 16;
  constexpr u32 blockSlots = blockCount * 8;
  u32 s = web.slot;

  tickTail<_h40>(web.refresh);

  if(s < blockSlots) {
    u32 block = s >> 3;
    switch(s & 7) {
    case 0: layerA.mappingFetch(block); break;
    case 1: if(!web.refresh) slot(); break;
    case 2: layerA.patternFetch(block * 2 + 2); break;
    case 3: layerA.patternFetch(block * 2 + 3); break;
    case 4: layerB.mappingFetch(block); break;
    case 5: sprite.mappingFetch(block); break;
    case 6: layerB.patternFetch(block * 2 + 2); break;
    case 7:
      layerB.patternFetch(block * 2 + 3);
      if(dac.pixels) {
        if(!web.den || web.top) {
          for(auto pixel : range(16)) dac.pixel<_h40, false>(block * 16 + pixel);
        } else {
          for(auto pixel : range(16)) dac.pixel<_h40, true>(block * 16 + pixel);
        }
      }
      if(block == blockCount - 1) {
        dac.fillRightBorder();
        //approx 3 and 1/4 pixel offset in H40 pixels (see mainH32)
        if(dac.pixels && Mega32X()) m32x.vdp.scanline(dac.pixels + (_h40 ? 13 * 4 : 13 * 5 + 13), vcounter());
        if(MegaLD()) mcd.ld.scanline(dac.pixels, vcounter());
      }
      break;
    }
  } else if constexpr(_h40) {
    //the post-block tail of mainH40()
    u32 o = s - blockSlots;
    if(o ==  0) slot();
    else if(o ==  1) {
      slot();
      layers.vscrollFetch();
      sprite.end();
    }
    else if(o <=  5) sprite.patternFetch(o - 2);
    else if(o <= 24) { sprite.patternFetch(o - 2); sprite.scan(); }
    else if(o == 25) slot();
    else if(o <= 36) {
      sprite.patternFetch(o - 3); sprite.scan();
      if(o == 36) {
        layerA.begin();
        layerB.begin();
        window.begin();
      }
    }
    else if(o == 37) layers.hscrollFetch();
    else if(o <= 41) { sprite.patternFetch(o - 4); sprite.scan(); }
    else if(o == 42) layerA.mappingFetch(-1);
    else if(o == 43) { if(!web.refresh) { sprite.patternFetch(38); sprite.scan(); } }
    else if(o == 44) { layerA.patternFetch(0); sprite.scan(); }
    else if(o == 45) { layerA.patternFetch(1); sprite.scan(); }
    else if(o == 46) layerB.mappingFetch(-1);
    else if(o == 47) { sprite.patternFetch(39); sprite.scan(); }
    else if(o == 48) { layerB.patternFetch(0); sprite.scan(); }
    else if(o == 49) { layerB.patternFetch(1); sprite.scan(); }
  } else {
    //the post-block tail of mainH32()
    u32 o = s - blockSlots;
    if(o ==  0) slot();
    else if(o ==  1) {
      slot();
      layers.vscrollFetch();
      sprite.end();
    }
    else if(o <=  5) sprite.patternFetch(o - 2);
    else if(o <= 18) { sprite.patternFetch(o - 2); sprite.scan(); }
    else if(o == 19) {
      //free slot placement and window begin latch as in mainH32()
      slot();
      window.begin();
    }
    else if(o <= 28) { sprite.patternFetch(o - 3); sprite.scan(); }
    else if(o == 29) {
      slot();
      layerA.begin();
      layerB.begin();
    }
    else if(o == 30) layers.hscrollFetch();
    else if(o <= 34) { sprite.patternFetch(o - 5); sprite.scan(); }
    else if(o == 35) layerA.mappingFetch(-1);
    else if(o == 36) { if(!web.refresh) { sprite.patternFetch(30); sprite.scan(); } }
    else if(o == 37) { layerA.patternFetch(0); sprite.scan(); }
    else if(o == 38) { layerA.patternFetch(1); sprite.scan(); }
    else if(o == 39) layerB.mappingFetch(-1);
    else if(o == 40) { sprite.patternFetch(31); sprite.scan(); }
    else if(o == 41) { layerB.patternFetch(0); sprite.scan(); }
    else if(o == 42) { layerB.patternFetch(1); sprite.scan(); }
  }

  if(++web.slot >= (_h40 ? 210u : 171u)) {
    web.slot = 0;
    if(vcounter() == state.bottomline) {
      screen->setColorBleedWidth(latch.displayWidth ? 4 : 5);
      latch.interlace = io.interlaceMode.bit(0);
      latch.overscan  = io.overscan;
      frame();
      state.field ^= 1;
      updateScreenParams();
    }
  }
}
#endif


