//Builds a Master System image that exercises every path the web build's synchronous scheduling can
//affect: mode 4 with a full name table, sixteen overlapping sprites forcing per-line overflow and
//collision, a line-interrupt handler rewriting registers 7 and 8 mid-scanline, a frame-interrupt
//handler sweeping PSG volumes and keying the OPLL, a main loop polling the V and H counter ports,
//and register 1 writes from inside both handlers that change vlines() partway through a scanline.
//
//That last case is the point of the ROM. vlines() is 192, 224 or 240 depending on register 0 and 1,
//and the native VDP commits to one value for a whole scanline; anything that re-reads it per dot
//renders a line the cothread build would have left blank, or truncates one it would have drawn.
//
//Exported rather than run: wasm/ms-sweep.mjs boots it.

//register 0: mode 4 (videoMode bits 1 and 3), line interrupt enable
const R0 = 0x16;
//register 1 selects the remaining videoMode bits, with the frame interrupt and display always on
const R1_192 = 0x60;  //videoMode 0b1010
const R1_224 = 0x70;  //videoMode 0b1011
const R1_240 = 0x68;  //videoMode 0b1110

//ram scratch
const LINES  = 0xc000;  //line interrupts taken
const FRAMES = 0xc001;  //frame interrupts taken
const STATUS = 0xc002;  //most recent VDP status read
const HDOT   = 0xc003;  //most recent H counter read
const VLOW   = 0xc004;  //most recent V counter read below 0x60
const VHIGH  = 0xc005;  //...and at or above it

class Asm {
  constructor(origin) {
    this.origin = origin;
    this.bytes = [];
    this.labels = new Map();
    this.fixups = [];
  }

  get pc() { return this.origin + this.bytes.length; }

  label(name) {
    if(this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.labels.set(name, this.pc);
    return this;
  }

  //pad forward to an absolute address; the Z80 vector table makes this unavoidable
  org(address) {
    if(this.pc > address) throw new Error(`origin ${address.toString(16)} already passed`);
    while(this.pc < address) this.bytes.push(0x00);
    return this;
  }

  b(...bytes) { this.bytes.push(...bytes.map(value => value & 0xff)); return this; }

  //16-bit little-endian operand naming a label, resolved once every label is known
  a16(name) { this.fixups.push({at: this.bytes.length, name}); return this.b(0, 0); }

  di()      { return this.b(0xf3); }
  ei()      { return this.b(0xfb); }
  im1()     { return this.b(0xed, 0x56); }
  reti()    { return this.b(0xed, 0x4d); }
  retn()    { return this.b(0xed, 0x45); }
  xorA()    { return this.b(0xaf); }
  incA()    { return this.b(0x3c); }
  incHL()   { return this.b(0x23); }
  decC()    { return this.b(0x0d); }
  ldAL()    { return this.b(0x7d); }
  ldAHL()   { return this.b(0x7e); }
  pushAF()  { return this.b(0xf5); }
  popAF()   { return this.b(0xf1); }
  pushHL()  { return this.b(0xe5); }
  popHL()   { return this.b(0xe1); }

  ldAi(n)   { return this.b(0x3e, n); }
  ldBi(n)   { return this.b(0x06, n); }
  ldCi(n)   { return this.b(0x0e, n); }
  andi(n)   { return this.b(0xe6, n); }
  ori(n)    { return this.b(0xf6, n); }
  cpi(n)    { return this.b(0xfe, n); }
  outi(n)   { return this.b(0xd3, n); }
  ini(n)    { return this.b(0xdb, n); }

  ldSP(nn)  { return this.b(0x31, nn & 0xff, nn >> 8); }
  ldHL(nn)  { return this.b(0x21, nn & 0xff, nn >> 8); }
  ldMemA(nn){ return this.b(0x32, nn & 0xff, nn >> 8); }
  ldAMem(nn){ return this.b(0x3a, nn & 0xff, nn >> 8); }

  //backward-only, like the 68k assembler in md-stress-rom.mjs: the target must already be defined
  djnz(name) {
    const target = this.labels.get(name);
    if(target === undefined) throw new Error(`undefined label ${name}`);
    const displacement = target - (this.pc + 2);
    if(displacement < -128 || displacement > 127) throw new Error(`djnz out of range: ${name}`);
    return this.b(0x10, displacement);
  }

  jrnz(name) {
    const target = this.labels.get(name);
    if(target === undefined) throw new Error(`undefined label ${name}`);
    const displacement = target - (this.pc + 2);
    if(displacement < -128 || displacement > 127) throw new Error(`jr nz out of range: ${name}`);
    return this.b(0x20, displacement);
  }

  jp(name)   { return this.b(0xc3).a16(name); }
  jpnz(name) { return this.b(0xc2).a16(name); }
  jpc(name)  { return this.b(0xda).a16(name); }

  //VDP register write: the value byte, then 0x80 | register, both through the control port
  vdpRegister(register, value) { return this.ldAi(value).outi(0xbf).ldAi(0x80 | register).outi(0xbf); }

  //VDP address setup: low byte, then high byte with the code bits (0x40 VRAM write, 0xc0 CRAM)
  vdpAddress(address, code) {
    return this.ldAi(address & 0xff).outi(0xbf).ldAi(code | (address >> 8 & 0x3f)).outi(0xbf);
  }

  assemble() {
    for(const {at, name} of this.fixups) {
      const target = this.labels.get(name);
      if(target === undefined) throw new Error(`undefined label ${name}`);
      this.bytes[at] = target & 0xff;
      this.bytes[at + 1] = target >> 8 & 0xff;
    }
    return new Uint8Array(this.bytes);
  }
}

//sixteen sprites on one scanline, in two overlapping runs four pixels apart, so every line they
//cover reports both overflow (more than eight candidates) and collision (opaque pixels meeting)
function spriteTables() {
  const y = new Uint8Array(64).fill(0xd0);
  const xn = new Uint8Array(128);
  for(let index = 0; index < 16; index++) {
    y[index] = 0x30;
    xn[index * 2 + 0] = 0x40 + (index & 7) * 4;
    xn[index * 2 + 1] = 0x10 + index;
  }
  //the terminator doubles as a real sprite at line 209 once vlines() grows past 192, so a mid-line
  //mode change is visible in the sprite path as well as the background one
  for(let index = 16; index < 64; index++) {
    xn[index * 2 + 0] = (index * 7) & 0xff;
    xn[index * 2 + 1] = index & 0x3f;
  }
  return {y, xn};
}

export function buildStressRom(options = {}) {
  const lineCoincidence = options.lineCoincidence ?? 7;
  const rom = new Uint8Array(32768);
  const a = new Asm(0x0000);

  a.di().im1().jp("init");

  a.org(0x0038).jp("irq");
  a.org(0x0066).retn();  //pause button; the harness never presses it

  a.org(0x0100).label("init");
  a.di().im1().ldSP(0xdff0);
  a.xorA().ldMemA(LINES).ldMemA(FRAMES).ldMemA(STATUS).ldMemA(HDOT).ldMemA(VLOW).ldMemA(VHIGH);

  for(const [register, value] of [
    [0x0, R0],
    [0x1, R1_192],
    [0x2, 0xff],  //name table 0x3800
    [0x3, 0xff],
    [0x4, 0xff],
    [0x5, 0x7e],  //sprite attribute table 0x3f00
    [0x6, 0xff],  //sprite pattern table 0x2000
    [0x7, 0x00],
    [0x8, 0x00],
    [0x9, 0x00],
    [0xa, lineCoincidence],
  ]) a.vdpRegister(register, value);

  //cram: 32 colors
  a.vdpAddress(0x0000, 0xc0).ldHL(0x0400 + 0).ldBi(32).label("cram");
  a.ldAHL().outi(0xbe).incHL().djnz("cram");

  //vram 0x0000-0x1fff: a byte ramp, giving every tile a distinct four-plane pattern
  a.vdpAddress(0x0000, 0x40).ldHL(0x0000).ldCi(0x20).label("tileOuter").ldBi(0).label("tileInner");
  a.ldAL().outi(0xbe).incHL().djnz("tileInner").decC().jrnz("tileOuter");

  //name table 0x3800: 1792 bytes, so tile index, flip, palette and priority all vary
  a.vdpAddress(0x3800, 0x40).ldHL(0x0000).ldCi(0x07).label("nameOuter").ldBi(0).label("nameInner");
  a.ldAL().andi(0x3f).outi(0xbe).incHL().djnz("nameInner").decC().jrnz("nameOuter");

  //sprite attribute table: y bytes at 0x3f00, x/pattern pairs at 0x3f80
  a.vdpAddress(0x3f00, 0x40).ldHL(0x0420).ldBi(64).label("spriteY");
  a.ldAHL().outi(0xbe).incHL().djnz("spriteY");
  a.vdpAddress(0x3f80, 0x40).ldHL(0x0460).ldBi(128).label("spriteXN");
  a.ldAHL().outi(0xbe).incHL().djnz("spriteXN");

  //psg: three tones plus noise, all keyed
  for(const value of [0x80, 0x0f, 0x90, 0xa0, 0x1e, 0xb2, 0xc0, 0x2d, 0xd4, 0xe6, 0xf0]) {
    a.ldAi(value).outi(0x7f);
  }

  //opll: a custom instrument, an f-number and a key-on. ignored unless the model has one, and the
  //ports decode to nothing on the machines that do not, so this is safe on every configuration.
  for(const [register, value] of [
    [0x00, 0x21], [0x01, 0x21], [0x02, 0x1e], [0x03, 0x07],
    [0x04, 0xf0], [0x05, 0xf0], [0x06, 0x0f], [0x07, 0x0f],
    [0x30, 0x00], [0x10, 0xa4], [0x20, 0x15],
  ]) a.ldAi(register).outi(0xf0).ldAi(value).outi(0xf1);
  a.ldAi(0x03).outi(0xf2);  //unmute both sound sources

  a.ei();

  //main loop: poll the V and H counter ports and branch on what comes back, so CPU::in's catch-up
  //sits on the critical path. the mode changes live in the interrupt handlers instead, where the
  //scanline they land on is fixed by the VDP rather than by how fast this loop happens to run.
  a.label("main");
  a.ini(0x7f).ldMemA(HDOT);
  a.ini(0x7e).cpi(0x60).jpc("mainUpper");
  a.ldMemA(VLOW).jp("main");
  a.label("mainUpper").ldMemA(VHIGH).jp("main");

  //interrupt handler: one status read acknowledges either source and samples the sprite flags
  a.label("irq");
  a.pushAF().pushHL();
  a.ini(0xbf).ldMemA(STATUS);
  a.andi(0x80).jpnz("frameIrq");

  a.ldAMem(LINES).incA().ldMemA(LINES);
  a.andi(0x0f).outi(0xbf).ldAi(0x87).outi(0xbf);  //register 7: backdrop, mid-scanline
  a.ldAMem(LINES).outi(0xbf).ldAi(0x88).outi(0xbf);  //register 8: hscroll, mid-scanline
  //past scanline 200 the line only exists because the frame handler grew vlines(); shrink it back
  //here, mid-scanline, so a line the native VDP renders in full is one a per-dot vlines() truncates
  a.ini(0x7e).cpi(200).jpc("irqDone");
  a.ldAi(R1_192).outi(0xbf).ldAi(0x81).outi(0xbf);
  a.label("irqDone").popHL().popAF().ei().reti();

  //the frame interrupt fires at vcounter == vlines() + 1, so this handler runs just past the end of
  //the visible area: growing vlines() here turns the line already in progress from blank to visible
  a.label("frameIrq");
  a.ldAMem(FRAMES).incA().ldMemA(FRAMES);
  a.andi(0x0f).ori(0x90).outi(0x7f);  //psg channel 0 volume
  a.ldAMem(FRAMES).andi(0x0f).ori(0xb0).outi(0x7f);  //psg channel 2 volume
  a.ldAi(0x20).outi(0xf0).ldAMem(FRAMES).andi(0x0f).ori(0x10).outi(0xf1);  //opll key-on/off
  a.ldAMem(FRAMES).andi(0x01).jpnz("frame240");
  a.ldAi(R1_224).jp("frameMode");
  a.label("frame240").ldAi(R1_240);
  a.label("frameMode").outi(0xbf).ldAi(0x81).outi(0xbf);
  a.popHL().popAF().ei().reti();

  const code = a.assemble();
  if(code.length > 0x0400) throw new Error("code overruns the data tables");
  rom.set(code, 0);

  //data tables at 0x0400: palette, then the sprite attribute source
  for(let index = 0; index < 32; index++) rom[0x0400 + index] = (index * 5 + 1) & 0x3f;
  const {y, xn} = spriteTables();
  rom.set(y, 0x0420);
  rom.set(xn, 0x0460);

  rom.set(new TextEncoder().encode("TMR SEGA"), 0x7ff0);
  rom[0x7fff] = 0x4c;  //export, 32KB
  return rom;
}
