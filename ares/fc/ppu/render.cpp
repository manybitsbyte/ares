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

auto PPU::renderPixel() -> void {
  if(io.ly >= screen->canvasHeight()) return;

  u32  x = io.lx - 1;
  u32  mask = 0x8000 >> (scroll.fineX + (x & 7));
  u32  palette = 0;
  u32  objectPalette = 0;
  bool objectPriority = 0;

  //PAL systems technically blank the topmost scanline and a 2px column on each side of active display.
  if(Region::PAL()) if(io.ly == 0 || x < 2 || x > 253) return;

  palette |= latch.tiledataLo & mask ? 1 : 0;
  palette |= latch.tiledataHi & mask ? 2 : 0;
  if(palette) {
    u32 attr = latch.attribute;
    if(mask >= 256) attr >>= 2;
    palette |= (attr & 3) << 2;
  }

  if(!io.bgEnable) palette = 0;
  if(!io.bgEdgeEnable && x < 8) palette = 0;

  if(io.spriteEnable)
    for(i32 sprite = 7; sprite >= 0; sprite--) {
      if(!io.spriteEdgeEnable && x < 8) continue;
      if(latch.oam[sprite].id == 64) continue;

      u32 spriteX = x - latch.oam[sprite].x;
      if(spriteX >= 8) continue;

      if(latch.oam[sprite].attr & 0x40) spriteX ^= 7;
      u32 mask = 0x80 >> spriteX;
      u32 spritePalette = 0;
      spritePalette |= latch.oam[sprite].tiledataLo & mask ? 1 : 0;
      spritePalette |= latch.oam[sprite].tiledataHi & mask ? 2 : 0;
      if(spritePalette == 0) continue;

      if(latch.oam[sprite].id == 0 && palette && x != 255) io.spriteZeroHit = 1;
      spritePalette |= (latch.oam[sprite].attr & 3) << 2;

      objectPriority = latch.oam[sprite].attr & 0x20;
      objectPalette = 16 + spritePalette;
    }

  if(objectPalette) {
    if(palette == 0 || objectPriority == 0) palette = objectPalette;
  }

  u32 color = 0;
  if (enable() || (n14)var.address < 0x3f00) {
    color = io.emphasis << 6 | readCGRAM(palette);
  } else {
    color = io.emphasis << 6 | readCGRAM((n5)var.address);
  }

  if(Region::PAL() || Region::Dendy())
    output[(x + 18) % 283] = color;
  else
    output[(x + 16) % 283] = color;
}

auto PPU::renderScanline() -> void {
  if(io.ly < screen->canvasHeight()) {
    output = screen->pixels().data() + io.ly * 283;
    for (auto n : range(283))
      output[n] = Region::PAL() ? 0x3f : io.emphasis << 6 | readCGRAM(0);
  }

  //Vblank
  if(io.ly >= 240 && io.ly <= vlines() - 2) return step(341), scanline();

  //  0
  step(1);

  // force clear sprite counter at start of each scanline
  for (auto& id : latch.oamId) id = 64;

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

    latch.nametable = latch.nametable << 8 | nametable;
    latch.attribute = latch.attribute << 2 | (attribute & 3);
    latch.tiledataLo = latch.tiledataLo << 8 | tiledataLo;
    latch.tiledataHi = latch.tiledataHi << 8 | tiledataHi;
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
    step(2);

    latch.oam[sprite].tiledataHi = loadCHR(tileaddr + 8);
    step(2);
  }

  //321-336
  for(u32 tile : range(2)) {
    u32 nametable = loadCHR(0x2000 | (n12)var.address);
    u32 tileaddr = io.bgAddress | nametable << 4 | var.fineY;
    step(2);

    u32 attribute = loadCHR(0x23c0 | var.nametable << 10 | (var.tileY >> 2) << 3 | var.tileX >> 2);
    if(var.tileY & 2) attribute >>= 4;
    if(var.tileX & 2) attribute >>= 2;
    step(2);

    u32 tiledataLo = loadCHR(tileaddr + 0);
    step(2);

    u32 tiledataHi = loadCHR(tileaddr + 8);
    step(2);

    latch.nametable = latch.nametable << 8 | nametable;
    latch.attribute = latch.attribute << 2 | (attribute & 3);
    latch.tiledataLo = latch.tiledataLo << 8 | tiledataLo;
    latch.tiledataHi = latch.tiledataHi << 8 | tiledataHi;
  }

  //337-338
  loadCHR(0x2000 | (n12)var.address);
  bool skip = !Region::PAL() && !Region::Dendy() && enable() && io.field == 1 && io.ly == vlines() - 1;
  step(2);

  //339
  loadCHR(0x2000 | (n12)var.address);
  step(1);

  //340
  if(!skip) step(1);

  return scanline();
}

#if defined(PLATFORM_WEB)
//the dot-at-a-time twin of renderScanline(): performs the fetch and render actions that
//renderScanline() performs before the step() covering the current dot, then runs that one dot.
//because it never holds a position across calls -- the in-flight fetch values live in the dot
//struct and everything else is derived from io.lx -- the cpu can call it as a plain function
//instead of switching to the ppu's cothread, which under asyncify is the dominant cost of
//cycle-accurate scheduling. any divergence from renderScanline() here is a bug.
auto PPU::runCycle() -> void {
  u32 L = vlines();
  u32 lx = io.lx;

  if(lx == 0 && io.ly < screen->canvasHeight()) {
    output = screen->pixels().data() + io.ly * 283;
    for (auto n : range(283))
      output[n] = Region::PAL() ? 0x3f : io.emphasis << 6 | readCGRAM(0);
  }

  //Vblank
  if(io.ly >= 240 && io.ly <= L - 2) {
    step(1);
    if(io.lx == 341) scanline();
    return;
  }

  //shift the previous tile's fetches into the background latches
  auto latchTile = [&] {
    latch.nametable  = latch.nametable  << 8 | dot.nametable;
    latch.attribute  = latch.attribute  << 2 | (dot.attribute & 3);
    latch.tiledataLo = latch.tiledataLo << 8 | dot.tiledataLo;
    latch.tiledataHi = latch.tiledataHi << 8 | dot.tiledataHi;
  };

  if(lx == 1) {
    // force clear sprite counter at start of each scanline
    for (auto& id : latch.oamId) id = 64;
  }

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
  } else if(lx <= 320) {
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
      break;
    }
    case 6:
      latch.oam[sprite].tiledataHi = loadCHR(dot.tileaddr + 8);
      break;
    }
  } else if(lx <= 336) {
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
  } else if(lx == 337) {
    //337-338
    latchTile();
    loadCHR(0x2000 | (n12)var.address);
    dot.skip = !Region::PAL() && !Region::Dendy() && enable() && io.field == 1 && io.ly == L - 1;
  } else if(lx == 339) {
    //339
    loadCHR(0x2000 | (n12)var.address);
  }

  step(1);
  //the pre-render line of every other NTSC frame ends one dot early
  if(io.lx == 341 || (dot.skip && io.lx == 340)) {
    dot.skip = 0;
    scanline();
  }
}
#endif
