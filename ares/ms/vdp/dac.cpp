auto VDP::DAC::setup(n9 y) -> void {
  auto offset = Region::PAL() ? 48 : 27;
  y = (y + offset) % vdp.screenHeight();
  output = self.screen->pixels().data() + y * 284;

  for (u32 x : range(284)) output[x] = palette(16 | io.backdropColor);
}
#if !defined(PLATFORM_WEB)
auto VDP::DAC::run(n8 x, n8 y) -> void {
  n12 color = palette(16 | io.backdropColor);

  if(self.displayEnable())
  if(!io.leftClip || x >= 8) {
    if(self.background.output.priority || !self.sprite.output.color) {
      color = palette(self.background.output.palette << 4 | self.background.output.color);
    } else if(self.sprite.output.color) {
      color = palette(16 | self.sprite.output.color);
    }
  }

  output[(x + 13) % 284] = color;
}
#endif
auto VDP::DAC::palette(n5 index) -> n12 {
  //TMS9918A colors are approximated by converting to RGB6 palette colors
  static const n6 palette[16] = {
    0x00, 0x00, 0x08, 0x0c, 0x10, 0x30, 0x01, 0x3c,
    0x02, 0x03, 0x05, 0x0f, 0x04, 0x33, 0x15, 0x3f,
  };
  if(Device::MasterSystem()) {
    if(!self.videoMode().bit(3)) return palette[index.bit(0,3)];
    return self.cram[index].bit(0,5);
  }
  if(Mode::MasterSystem()) {
    n6 color = self.cram[index];
    if(!self.videoMode().bit(3)) color = palette[index.bit(0,3)];
    n4 r = color.bit(0,1) << 0 | color.bit(0,1) << 2;
    n4 g = color.bit(2,3) << 0 | color.bit(2,3) << 2;
    n4 b = color.bit(4,5) << 0 | color.bit(4,5) << 2;
    return r << 0 | g << 4 | b << 8;
  }
  if(Mode::GameGear()) {
    if(!self.videoMode().bit(3)) {
      n6 color = palette[index.bit(0,3)];
      n4 r = color.bit(0,1) << 0 | color.bit(0,1) << 2;
      n4 g = color.bit(2,3) << 0 | color.bit(2,3) << 2;
      n4 b = color.bit(4,5) << 0 | color.bit(4,5) << 2;
      return r << 0 | g << 4 | b << 8;
    }
    return self.cram[index];
  }
  return 0;
}

auto VDP::DAC::power() -> void {
  io = {};
  output = nullptr;
}
#if defined(PLATFORM_WEB)
//A second expression of the native DAC::run above. Identical in what it produces; it just stops
//computing the backdrop colour on dots that never use it. The native form opens every dot with
//palette(16 | io.backdropColor) and then overwrites that value on any dot the display actually
//draws, so a visible dot pays two palette() calls where one would do -- and palette() is not a
//table read: on a Game Gear it runs three model predicates and a videoMode() before it reaches
//cram. At 256 dots a line that is the per-dot cost this core repeats most often.
//Reordering is safe because palette() is pure: it reads cram and videoMode and writes nothing.
//The trailing else is unreachable -- !(background.priority || !sprite.color) implies sprite.color
//-- and is kept so the branch structure still reads against the native form above.
auto VDP::DAC::run(n8 x, n8 y) -> void {
  n12 color;

  if(self.displayEnable() && (!io.leftClip || x >= 8)) {
    if(self.background.output.priority || !self.sprite.output.color) {
      color = palette(self.background.output.palette << 4 | self.background.output.color);
    } else if(self.sprite.output.color) {
      color = palette(16 | self.sprite.output.color);
    } else {
      color = palette(16 | io.backdropColor);
    }
  } else {
    color = palette(16 | io.backdropColor);
  }

  output[(x + 13) % 284] = color;
}
#endif
