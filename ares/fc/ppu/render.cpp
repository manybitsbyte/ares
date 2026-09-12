auto PPU::enable() const -> bool {
  return io.bgEnable || io.spriteEnable;
}

auto PPU::rendering() const -> bool {
  return enable() && (io.ly < 240 || io.ly == vlines() - 1);
}

auto PPU::loadCHR(n16 address) -> n8 {
  if (enable()) {
    io.busAddress = (n14)address;
    cartridge.ppuAddressBus(address);
    return cartridge.readCHR(address);
  } else {
    return 0x00;
  }
}

auto PPU::bgShift() -> u32 {
  if(!enable()) return 0;

  u32 mask = 0x8000 >> scroll.fineX;
  u32 palette = 0;

  palette |= latch.tiledataLo  & mask ? 1 : 0;
  palette |= latch.tiledataHi  & mask ? 2 : 0;
  palette |= latch.attributeLo & mask ? 4 : 0;
  palette |= latch.attributeHi & mask ? 8 : 0;
  latch.tiledataLo <<= 1;
  latch.tiledataHi <<= 1;
  latch.tiledataHi |= 0x0001;
  latch.attributeLo <<= 1;
  latch.attributeHi <<= 1;

  return palette;
}

auto PPU::renderPixel() -> void {
  if(io.ly >= screen->canvasHeight()) return;

  u32  x = io.lx - 1;
  u32  objectPalette = 0;
  bool objectPriority = 0;

  u32 palette = bgShift();
  if(!(palette & 3)) palette = 0;
  if(!io.bgEnable) palette = 0;
  if(!io.bgEdgeEnable && x < 8) palette = 0;

  if(!model->raster.pixelVisible(x, io.ly)) return;

  for(i32 sprite = 7; sprite >= 0; sprite--) {
    if(latch.oam[sprite].id == 64) continue;
    if(!latch.oam[sprite].x) latch.oam[sprite].counting = false;
    if(latch.oam[sprite].counting) {
      latch.oam[sprite].x--;
      continue;
    }
    if(!enable()) continue;

    //shift out sprite pixels once x-position countdown expires
    u32 spritePalette = 0;
    spritePalette |= latch.oam[sprite].tiledataLo & 0x80 ? 1 : 0;
    spritePalette |= latch.oam[sprite].tiledataHi & 0x80 ? 2 : 0;
    latch.oam[sprite].tiledataLo <<= 1;
    latch.oam[sprite].tiledataHi <<= 1;

    if(!io.spriteEnable) continue;
    if(!io.spriteEdgeEnable && x < 8) continue;
    if(spritePalette == 0) continue;

    if(latch.oam[sprite].id == 0 && palette && x != 255) io.spriteZeroHit = 1;
    spritePalette |= (latch.oam[sprite].attr & 3) << 2;
    objectPriority = latch.oam[sprite].attr & 0x20;
    objectPalette = 16 + spritePalette;
  }

  if(objectPalette && (palette == 0 || objectPriority == 0)) palette = objectPalette;

  u32 color = 0;
  if(enable() || (n14)var.address < 0x3f00) {
    color = io.emphasis << 6 | readCGRAM(palette);
  } else {
    color = io.emphasis << 6 | readCGRAM((n5)var.address);
  }

  output[(x + model->raster.outputOffset) % 283] = color;
}

auto PPU::renderScanline() -> void {
  if(io.ly < screen->canvasHeight()) {
    output = screen->pixels().data() + io.ly * 283;
    auto backdrop = model->raster.backdrop(io.emphasis << 6 | readCGRAM(0));
    for(auto n : range(283)) output[n] = backdrop;
  }

  //Vblank
  if(io.ly >= 240 && io.ly <= vlines() - 2) return step(341), scanline();

  //  0
  step(1);

  //force clear sprite counter at start of each scanline
  for(auto& id : latch.oamId) id = 64;

  //  1-256
  for(u32 tile : range(32)) {
    u32 nametable = loadCHR(0x2000 | (n12)var.address);
    u32 tileaddr = io.bgAddress | nametable << 4 | var.fineY;
    renderPixel();
    step(1);

    renderPixel();
    step(1);

    u32 attribute = loadCHR(0x23c0 | var.nametable << 10 | var.attrY << 3 | var.attrX);
    if(var.tileY & 2) attribute >>= 4;
    if(var.tileX & 2) attribute >>= 2;
    renderPixel();
    step(1);

    renderPixel();
    step(1);

    u32 tiledataLo = loadCHR(tileaddr + 0);
    renderPixel();
    step(1);

    renderPixel();
    step(1);

    u32 tiledataHi = loadCHR(tileaddr + 8);
    renderPixel();
    step(1);

    renderPixel();
    step(1);

    latch.attributeLo.byte(0) = (attribute & 1) ? 0xff : 0x00;
    latch.attributeHi.byte(0) = (attribute & 2) ? 0xff : 0x00;
    latch.tiledataLo.byte(0) = tiledataLo;
    latch.tiledataHi.byte(0) = tiledataHi;
  }

  for(u32 n : range(8)) {
    latch.oam[n].id   = latch.oamId[n];
    latch.oam[n].y    = soam[4 * n + 0];
    latch.oam[n].tile = soam[4 * n + 1];
    latch.oam[n].attr = soam[4 * n + 2];
    latch.oam[n].x    = soam[4 * n + 3];
  }

  //257-320
  for(u32 sprite : range(8)) {
    u32 nametable = loadCHR(0x2000 | (n12)var.address);
    step(2);

    u32 attribute = loadCHR(0x23c0 | var.nametable << 10 | (var.tileY >> 2) << 3 | var.tileX >> 2);
    u32 tileaddr = io.spriteHeight == 8
    ? io.spriteAddress + latch.oam[sprite].tile * 16
    : (latch.oam[sprite].tile & ~1) * 16 + (latch.oam[sprite].tile & 1) * 0x1000;
    step(2);

    u32 spriteY = (io.ly - latch.oam[sprite].y) & (io.spriteHeight - 1);
    if(latch.oam[sprite].attr & 0x80) spriteY ^= io.spriteHeight - 1;
    tileaddr += spriteY + (spriteY & 8);

    latch.oam[sprite].tiledataLo = loadCHR(tileaddr + 0);
    if(latch.oam[sprite].attr & 0x40) latch.oam[sprite].tiledataLo = bit::reverse<u8>(latch.oam[sprite].tiledataLo);
    step(2);

    latch.oam[sprite].tiledataHi = loadCHR(tileaddr + 8);
    if(latch.oam[sprite].attr & 0x40) latch.oam[sprite].tiledataHi = bit::reverse<u8>(latch.oam[sprite].tiledataHi);
    step(2);
  }

  //321-336
  for(u32 tile : range(2)) {
    u32 nametable = loadCHR(0x2000 | (n12)var.address);
    u32 tileaddr = io.bgAddress | nametable << 4 | var.fineY;
    bgShift();
    step(1);
    bgShift();
    step(1);

    u32 attribute = loadCHR(0x23c0 | var.nametable << 10 | (var.tileY >> 2) << 3 | var.tileX >> 2);
    if(var.tileY & 2) attribute >>= 4;
    if(var.tileX & 2) attribute >>= 2;
    bgShift();
    step(1);
    bgShift();
    step(1);

    u32 tiledataLo = loadCHR(tileaddr + 0);
    bgShift();
    step(1);
    bgShift();
    step(1);

    u32 tiledataHi = loadCHR(tileaddr + 8);
    bgShift();
    step(1);
    bgShift();
    step(1);

    latch.attributeLo.byte(0) = (attribute & 1) ? 0xff : 0x00;
    latch.attributeHi.byte(0) = (attribute & 2) ? 0xff : 0x00;
    latch.tiledataLo.byte(0) = tiledataLo;
    latch.tiledataHi.byte(0) = tiledataHi;
  }

  //337-338
  loadCHR(0x2000 | (n12)var.address);
  bool skip = model->raster.oddFrameCycleSkip && enable() && io.field == 1 && io.ly == vlines() - 1;
  step(2);

  //339
  loadCHR(0x2000 | (n12)var.address);
  if(enable()) {
    for(u32 sprite : range(8)) latch.oam[sprite].counting = true;
  }
  step(1);

  //340
  if(!skip) step(1);

  return scanline();
}

#if defined(PLATFORM_WEB)
//the dot-at-a-time twin of renderScanline(): performs the fetch, latch and render actions that
//renderScanline() performs before the step() covering the current dot, then runs that one dot.
//because it never holds a position across calls -- the in-flight fetch values live in the dot
//struct and everything else is derived from io.lx -- the cpu can call it as a plain function
//instead of switching to the ppu's cothread, which under asyncify is the dominant cost of
//cycle-accurate scheduling. the background latches are now shifted a pixel at a time by bgShift(),
//so a latchTile() that lands on the wrong dot moves the picture; each one is placed on the dot that
//follows the eighth step() of the tile it completes. any divergence from renderScanline() is a bug.
auto PPU::runCycle() -> void {
  u32 L = vlines();
  u32 lx = io.lx;

  if(lx == 0 && io.ly < screen->canvasHeight()) {
    output = screen->pixels().data() + io.ly * 283;
    auto backdrop = model->raster.backdrop(io.emphasis << 6 | readCGRAM(0));
    for(auto n : range(283)) output[n] = backdrop;
  }

  //Vblank
  if(io.ly >= 240 && io.ly <= L - 2) {
    step(1);
    if(io.lx == 341) scanline();
    return;
  }

  //load the completed tile's fetches into the background shifters
  auto latchTile = [&] {
    latch.attributeLo.byte(0) = (dot.attribute & 1) ? 0xff : 0x00;
    latch.attributeHi.byte(0) = (dot.attribute & 2) ? 0xff : 0x00;
    latch.tiledataLo.byte(0) = dot.tiledataLo;
    latch.tiledataHi.byte(0) = dot.tiledataHi;
  };

  if(lx == 1) {
    //force clear sprite counter at start of each scanline
    for(auto& id : latch.oamId) id = 64;
  }

  //dot 0 has no action; every range states both bounds so it cannot fall into a later arm and
  //index that arm's tables out of bounds
  if(lx >= 1 && lx <= 256) {
    //  1-256
    if(lx >= 9 && (lx & 7) == 1) latchTile();
    switch((lx - 1) & 7) {
    case 0:
      dot.nametable = loadCHR(0x2000 | (n12)var.address);
      dot.tileaddr = io.bgAddress | dot.nametable << 4 | var.fineY;
      break;
    case 2:
      dot.attribute = loadCHR(0x23c0 | var.nametable << 10 | var.attrY << 3 | var.attrX);
      if(var.tileY & 2) dot.attribute >>= 4;
      if(var.tileX & 2) dot.attribute >>= 2;
      break;
    case 4:
      dot.tiledataLo = loadCHR(dot.tileaddr + 0);
      break;
    case 6:
      dot.tiledataHi = loadCHR(dot.tileaddr + 8);
      break;
    }
    renderPixel();
  } else if(lx >= 257 && lx <= 320) {
    //257-320
    if(lx == 257) {
      latchTile();
      for(u32 n : range(8)) {
        latch.oam[n].id   = latch.oamId[n];
        latch.oam[n].y    = soam[4 * n + 0];
        latch.oam[n].tile = soam[4 * n + 1];
        latch.oam[n].attr = soam[4 * n + 2];
        latch.oam[n].x    = soam[4 * n + 3];
      }
    }
    u32 sprite = (lx - 257) >> 3;
    switch((lx - 257) & 7) {
    case 0:
      loadCHR(0x2000 | (n12)var.address);
      break;
    case 2:
      loadCHR(0x23c0 | var.nametable << 10 | (var.tileY >> 2) << 3 | var.tileX >> 2);
      dot.tileaddr = io.spriteHeight == 8
      ? io.spriteAddress + latch.oam[sprite].tile * 16
      : (latch.oam[sprite].tile & ~1) * 16 + (latch.oam[sprite].tile & 1) * 0x1000;
      break;
    case 4: {
      u32 spriteY = (io.ly - latch.oam[sprite].y) & (io.spriteHeight - 1);
      if(latch.oam[sprite].attr & 0x80) spriteY ^= io.spriteHeight - 1;
      dot.tileaddr += spriteY + (spriteY & 8);
      latch.oam[sprite].tiledataLo = loadCHR(dot.tileaddr + 0);
      if(latch.oam[sprite].attr & 0x40) latch.oam[sprite].tiledataLo = bit::reverse<u8>(latch.oam[sprite].tiledataLo);
      break;
    }
    case 6:
      latch.oam[sprite].tiledataHi = loadCHR(dot.tileaddr + 8);
      if(latch.oam[sprite].attr & 0x40) latch.oam[sprite].tiledataHi = bit::reverse<u8>(latch.oam[sprite].tiledataHi);
      break;
    }
  } else if(lx >= 321 && lx <= 336) {
    //321-336
    if(lx == 329) latchTile();
    switch((lx - 321) & 7) {
    case 0:
      dot.nametable = loadCHR(0x2000 | (n12)var.address);
      dot.tileaddr = io.bgAddress | dot.nametable << 4 | var.fineY;
      break;
    case 2:
      dot.attribute = loadCHR(0x23c0 | var.nametable << 10 | (var.tileY >> 2) << 3 | var.tileX >> 2);
      if(var.tileY & 2) dot.attribute >>= 4;
      if(var.tileX & 2) dot.attribute >>= 2;
      break;
    case 4:
      dot.tiledataLo = loadCHR(dot.tileaddr + 0);
      break;
    case 6:
      dot.tiledataHi = loadCHR(dot.tileaddr + 8);
      break;
    }
    bgShift();
  } else if(lx == 337) {
    //337-338
    latchTile();
    loadCHR(0x2000 | (n12)var.address);
    dot.skip = model->raster.oddFrameCycleSkip && enable() && io.field == 1 && io.ly == L - 1;
  } else if(lx == 339) {
    //339
    loadCHR(0x2000 | (n12)var.address);
    if(enable()) {
      for(u32 sprite : range(8)) latch.oam[sprite].counting = true;
    }
  }

  step(1);
  //the pre-render line of every other NTSC frame ends one dot early
  if(io.lx == 341 || (dot.skip && io.lx == 340)) {
    dot.skip = 0;
    scanline();
  }
}
#endif
