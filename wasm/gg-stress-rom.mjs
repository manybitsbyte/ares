//Builds a Game Gear image that exercises the paths the web build's synchronous scheduling can
//affect, and specifically the four the Master System stress ROM cannot reach because the Master
//System has no equivalent:
//
//  - 12-bit CRAM through the two-byte latch. On a Game Gear an even write parks a byte in
//    latch.cram and an odd write commits twelve bits to cram[address >> 1]
//    (ares/ms/vdp/io.cpp:71-81); on a Master System every write stores six bits immediately. A
//    scheduler that lets a write land at the wrong moment splits a pair and writes one colour from
//    two halves.
//  - A scrolled background. The Game Gear shows only columns 61-220 of rows 51-194
//    (ares/ms/vdp/vdp.cpp:158-160), so a static field would leave that window a constant colour and
//    hide any divergence inside it. Registers 8 and 9 move it every frame.
//  - Port 0x06, the stereo balance register, which routes each of the four PSG channels to the left
//    and right sides independently (ares/ms/psg/psg.cpp:51-62, reached through
//    ares/ms/cpu/memory.cpp:219). The Master System's PSG is mono, so nothing in ms-stress-rom.mjs
//    produces a stream whose two sides differ.
//  - Port 0x00, which reads the Start button and the region straps
//    (ares/ms/cpu/memory.cpp:37-46). It calls platform->input() from inside the read, so it puts an
//    input poll on the CPU's own clock rather than at the frame boundary.
//
//A line-interrupt handler still rewrites registers 7 and 8 mid-scanline, and the frame handler still
//moves vlines(), for the same reason the Master System ROM does: the native VDP commits to one
//vlines() for a whole scanline, and anything re-reading it per dot renders a different picture.
//
//There is no OPLL block. A Game Gear never has one (ares/ms/system/system.cpp gates the FM Sound
//Unit on the Master System), so writing those ports would exercise nothing.
//
//Exported rather than run: wasm/gg-sweep.mjs and wasm/gg-smoke.mjs boot it.

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
const PORT0  = 0xc006;  //most recent port 0x00 read: Start plus the region straps
const SCROLL = 0xc007;  //background scroll accumulator

//exported so wasm/gg-smoke.mjs can build its own image without a second copy of the encoder
export class Asm {
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

  cpl()     { return this.b(0x2f); }
  xorH()    { return this.b(0xac); }
  rrca()    { return this.b(0x0f); }
  ldBA()    { return this.b(0x47); }
  ldCA()    { return this.b(0x4f); }
  ldAC()    { return this.b(0x79); }
  orB()     { return this.b(0xb0); }

  ldAi(n)   { return this.b(0x3e, n); }
  ldBi(n)   { return this.b(0x06, n); }
  ldCi(n)   { return this.b(0x0e, n); }
  andi(n)   { return this.b(0xe6, n); }
  ori(n)    { return this.b(0xf6, n); }
  cpi(n)    { return this.b(0xfe, n); }
  addi(n)   { return this.b(0xc6, n); }
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
//cover reports both overflow (more than eight candidates) and collision (opaque pixels meeting).
//They sit inside the Game Gear's visible column range rather than the Master System's, so the
//160-pixel window actually contains them.
function spriteTables() {
  const y = new Uint8Array(64).fill(0xd0);
  const xn = new Uint8Array(128);
  for(let index = 0; index < 16; index++) {
    y[index] = 0x40;
    xn[index * 2 + 0] = 0x48 + (index & 7) * 4;
    xn[index * 2 + 1] = 0x10 + index;
  }
  //the terminator doubles as a real sprite once vlines() grows past 192, so a mid-line mode change
  //is visible in the sprite path as well as the background one
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
  a.org(0x0066).retn();  //the Game Gear's Start button drives NMI only in Master System mode

  a.org(0x0100).label("init");
  a.di().im1().ldSP(0xdff0);
  a.xorA().ldMemA(LINES).ldMemA(FRAMES).ldMemA(STATUS).ldMemA(HDOT).ldMemA(VLOW).ldMemA(VHIGH);
  a.xorA().ldMemA(PORT0).ldMemA(SCROLL);

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

  //cram: 32 twelve-bit colours, written as 64 bytes. The even byte parks in latch.cram and the odd
  //byte commits both (ares/ms/vdp/io.cpp:75-81), so the pairing is the thing under test — a split
  //pair produces a colour built from two different entries.
  a.vdpAddress(0x0000, 0xc0).ldHL(0x0400 + 0).ldBi(64).label("cram");
  a.ldAHL().outi(0xbe).incHL().djnz("cram");

  //vram 0x0000-0x1fff: a byte ramp, giving every tile a distinct four-plane pattern
  a.vdpAddress(0x0000, 0x40).ldHL(0x0000).ldCi(0x20).label("tileOuter").ldBi(0).label("tileInner");
  a.ldAL().outi(0xbe).incHL().djnz("tileInner").decC().jrnz("tileOuter");

  //name table 0x3800: 1792 bytes, so tile index, flip, palette and priority all vary
  a.vdpAddress(0x3800, 0x40).ldHL(0x0000).ldCi(0x07).label("nameOuter").ldBi(0).label("nameInner");
  a.ldAL().andi(0x3f).outi(0xbe).incHL().djnz("nameInner").decC().jrnz("nameOuter");

  //sprite attribute table: y bytes at 0x3f00, x/pattern pairs at 0x3f80
  a.vdpAddress(0x3f00, 0x40).ldHL(0x0440).ldBi(64).label("spriteY");
  a.ldAHL().outi(0xbe).incHL().djnz("spriteY");
  a.vdpAddress(0x3f80, 0x40).ldHL(0x0480).ldBi(128).label("spriteXN");
  a.ldAHL().outi(0xbe).incHL().djnz("spriteXN");

  //psg: three tones plus noise, all keyed
  for(const value of [0x80, 0x0f, 0x90, 0xa0, 0x1e, 0xb2, 0xc0, 0x2d, 0xd4, 0xe6, 0xf0]) {
    a.ldAi(value).outi(0x7f);
  }

  //stereo: channels 0 and 1 to the left only, channels 2 and 3 to the right only, so the two sides
  //of the stream carry different waveforms and a mono comparison cannot pass vacuously
  a.ldAi(0x3c).outi(0x06);

  a.ei();

  //main loop: poll the V and H counter ports and port 0x00, so CPU::in's catch-up sits on the
  //critical path and an input poll happens at the CPU's clock rather than the frame boundary. The
  //mode changes live in the interrupt handlers instead, where the scanline they land on is fixed by
  //the VDP rather than by how fast this loop happens to run.
  a.label("main");
  a.ini(0x00).ldMemA(PORT0);
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

  //rotate the stereo routing so both sides change over the run rather than holding one split
  a.ldAMem(FRAMES).andi(0x0f).ori(0x30).outi(0x06);

  //scroll the background both ways, so the 160x144 window at (61, 51) is never a constant field.
  //Register 8 is horizontal, register 9 vertical, and the two advance at different rates so the
  //window content does not repeat on a short period.
  a.ldAMem(SCROLL).addi(3).ldMemA(SCROLL);
  a.outi(0xbf).ldAi(0x88).outi(0xbf);
  a.ldAMem(SCROLL).andi(0x7f).outi(0xbf).ldAi(0x89).outi(0xbf);

  a.ldAMem(FRAMES).andi(0x01).jpnz("frame240");
  a.ldAi(R1_224).jp("frameMode");
  a.label("frame240").ldAi(R1_240);
  a.label("frameMode").outi(0xbf).ldAi(0x81).outi(0xbf);
  a.popHL().popAF().ei().reti();

  const code = a.assemble();
  if(code.length > 0x0400) throw new Error("code overruns the data tables");
  rom.set(code, 0);

  //data tables at 0x0400: 64 bytes of palette (32 twelve-bit entries, low byte then high nibble),
  //then the sprite attribute source
  for(let index = 0; index < 32; index++) {
    rom[0x0400 + index * 2 + 0] = (index * 37 + 11) & 0xff;   //low eight bits: blue and green
    rom[0x0400 + index * 2 + 1] = (index * 5 + 1) & 0x0f;     //high nibble: red
  }
  const {y, xn} = spriteTables();
  rom.set(y, 0x0440);
  rom.set(xn, 0x0480);

  rom.set(new TextEncoder().encode("TMR SEGA"), 0x7ff0);
  rom[0x7fff] = 0x4c;  //export, 32KB

  //There is deliberately no Master-System-mode variant. mia/medium/game-gear.cpp:57 sets that strap
  //from a ".sms" extension or from mia's database, and the web ABI resolves the path from the model
  //rather than from a file name, so a Game Gear model always writes ".gg" and the strap is always 0.
  //A configuration for it would be unreachable through this ABI, not merely untested.
  return rom;
}
