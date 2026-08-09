//Builds a Mega Drive image that exercises every path the web build's synchronous scheduling can
//affect: display on in H40 with an animated plane, an HINT raster handler rewriting CRAM every
//four lines, a VINT handler running a 68k->VRAM DMA plus VSRAM scroll and PSG volume writes each
//frame, all four PSG channels keyed, a resident Z80 program hammering the YM2612 DAC and status
//port at full speed with its own vblank interrupt handler, and the main loop polling the VDP
//status/HV ports and both halves of a TH-multiplexed control pad.
//
//Exported rather than run: wasm/md-sweep.mjs boots it.

class Asm {
  constructor(origin) {
    this.origin = origin;
    this.bytes = [];
    this.labels = new Map();
  }

  get pc() { return this.origin + this.bytes.length; }

  label(name) { this.labels.set(name, this.pc); return this; }

  //emit 16-bit words
  w(...words) {
    for(const word of words) this.bytes.push(word >> 8 & 0xff, word & 0xff);
    return this;
  }

  b(...bytes) { this.bytes.push(...bytes.map(v => v & 0xff)); return this; }

  l(value) { return this.w(value >>> 16, value & 0xffff); }

  //backward-only branches: the target label must already be defined
  disp(name, next) {
    const target = this.labels.get(name);
    if(target === undefined) throw new Error(`undefined label ${name}`);
    const disp = target - next;
    if(disp < -0x8000 || disp > 0x7fff) throw new Error(`branch out of range: ${name}`);
    return disp & 0xffff;
  }

  //short branches carry an 8-bit displacement; silently truncating one would emit a wrong branch
  //and quietly invalidate every hash this image produces
  short(name) {
    const d = this.disp(name, this.pc + 2) << 16 >> 16;
    if(d < -0x80 || d > 0x7f || d === 0) throw new Error(`short branch out of range: ${name} (${d})`);
    return d & 0xff;
  }

  dbra(reg, name)  { this.w(0x51c8 | reg); return this.w(this.disp(name, this.pc)); }
  bne_s(name)      { return this.w(0x6600 | this.short(name)); }
  beq_s(name)      { return this.w(0x6700 | this.short(name)); }
  bra_s(name)      { return this.w(0x6000 | this.short(name)); }
}

const VDP_CTRL = 0x00c00004;
const VDP_DATA = 0x00c00000;
const PSG      = 0x00c00011;

//move.w #imm,(addr).l
const movewi = (a, imm, addr) => a.w(0x33fc, imm).l(addr);
//move.l #imm,(addr).l
const moveli = (a, imm, addr) => a.w(0x23fc).l(imm).l(addr);
//move.b #imm,(addr).l
const movebi = (a, imm, addr) => a.w(0x13fc, imm & 0xff).l(addr);

export function buildStressRom({noZ80 = false, noHint = false, noDma = false} = {}) {
  const rom = new Uint8Array(32768);
  const view = new DataView(rom.buffer);

  //vector table
  view.setUint32(0x000, 0x00fffe00);  //initial stack
  view.setUint32(0x004, 0x00000200);  //initial pc
  view.setUint32(0x070, 0x00000400);  //level 4 autovector: HINT
  view.setUint32(0x078, 0x00000500);  //level 6 autovector: VINT
  for(const [i, c] of [..."SEGA MEGA DRIVE "].entries()) rom[0x100 + i] = c.charCodeAt(0);

  //z80 program, loaded to sound ram at power-on by the 68k
  const z80 = [
    0xf3,             // di
    0xed, 0x56,       // im 1
    0x31, 0xf0, 0x1f, // ld sp,0x1ff0
    0xc3, 0x40, 0x00, // jp 0x0040
  ];
  const z80Handler = [   //at 0x38: count vblank interrupts in sound ram
    0x21, 0x00, 0x1f,   // ld hl,0x1f00
    0x34,               // inc (hl)
    0xfb,               // ei
    0xc9,               // ret
  ];
  const z80Main = [      //at 0x40: enable the dac, then stream a ramp and poll status forever
    0x3e, 0x2b,          // ld a,0x2b
    0x32, 0x00, 0x40,    // ld (0x4000),a
    0x3e, 0x80,          // ld a,0x80
    0x32, 0x01, 0x40,    // ld (0x4001),a
    0xfb,                // ei
    0x06, 0x00,          // ld b,0
    //loop (0x4d):
    0x3e, 0x2a,          // ld a,0x2a
    0x32, 0x00, 0x40,    // ld (0x4000),a
    0x78,                // ld a,b
    0x32, 0x01, 0x40,    // ld (0x4001),a
    0x04,                // inc b
    0x3a, 0x00, 0x40,    // ld a,(0x4000)
    0xc3, 0x4d, 0x00,    // jp 0x004d
  ];
  const z80Image = new Uint8Array(0x40 + z80Main.length);
  z80Image.set(z80, 0);
  z80Image.set(z80Handler, 0x38);
  z80Image.set(z80Main, 0x40);
  rom.set(z80Image, 0x600);

  //dma source data
  for(let i = 0; i < 0x100; i++) rom[0x700 + i] = (i * 0x1f + 0x33) & 0xff;

  //hint handler: rotate the backdrop color in cram every four lines
  const hint = new Asm(0x400);
  hint.w(0x2f00);                              //move.l d0,-(sp)
  hint.w(0x3039).l(0x00ff0002);                //move.w 0xff0002,d0
  hint.w(0x0640, 0x0111);                      //addi.w #0x111,d0
  hint.w(0x33c0).l(0x00ff0002);                //move.w d0,0xff0002
  moveli(hint, 0xc0000000, VDP_CTRL);          //cram write, address 0
  hint.w(0x33c0).l(VDP_DATA);                  //move.w d0,(data)
  hint.w(0x201f);                              //move.l (sp)+,d0
  hint.w(0x4e73);                              //rte

  //vint handler: frame counter, dma burst, scroll write, psg volume sweep
  const vint = new Asm(0x500);
  vint.w(0x2f00);                              //move.l d0,-(sp)
  vint.w(0x52b9).l(0x00ff0000);                //addq.l #1,0xff0000
  movewi(vint, 0x9340, VDP_CTRL);              //dma length = 0x40 words
  movewi(vint, 0x9400, VDP_CTRL);
  movewi(vint, 0x9580, VDP_CTRL);              //dma source = rom 0x700
  movewi(vint, 0x9603, VDP_CTRL);
  movewi(vint, 0x9700, VDP_CTRL);
  if(!noDma) moveli(vint, 0x40000081, VDP_CTRL);  //vram 0x4000 write + dma start
  moveli(vint, 0x40000010, VDP_CTRL);          //vsram write, address 0
  vint.w(0x3039).l(0x00ff0002);                //move.w 0xff0002,d0 (hint color counter)
  vint.w(0x0240, 0x00ff);                      //andi.w #0xff,d0
  vint.w(0x33c0).l(VDP_DATA);                  //move.w d0,(data): plane a vscroll
  vint.w(0x1039).l(0x00ff0003);                //move.b 0xff0003,d0
  vint.w(0x0200, 0x0007);                      //andi.b #7,d0
  vint.w(0x0000, 0x0090);                      //ori.b #0x90,d0
  vint.w(0x13c0).l(PSG);                       //move.b d0,(psg): channel 0 volume
  vint.w(0x201f);                              //move.l (sp)+,d0
  vint.w(0x4e73);                              //rte

  //init + main loop
  const a = new Asm(0x200);
  a.w(0x46fc, 0x2700);                         //move.w #0x2700,sr
  for(const reg of [
    noHint ? 0x8004 : 0x8014,  //r0: hint enable
    0x8174,        //r1: display on, vint on, dma on, v28
    0x8230,        //r2: plane a 0xc000
    0x8300,        //r3: window 0
    0x8407,        //r4: plane b 0xe000
    0x8578,        //r5: sprites 0xf000
    0x8701,        //r7: backdrop color 1
    0x8a04,        //r10: hint every 4 lines
    0x8b00,        //r11: full-screen scroll
    0x8c81,        //r12: h40
    0x8d3f,        //r13: hscroll table 0xfc00
    0x8f02,        //r15: autoincrement 2
    0x9001,        //r16: 64x32 plane
    0x9100, 0x9200 //r17,r18: window off
  ]) movewi(a, reg, VDP_CTRL);

  //cram: 64 ascending colors
  moveli(a, 0xc0000000, VDP_CTRL);
  a.w(0x203c).l(0x00000123);                   //move.l #0x123,d0
  a.w(0x7a3f);                                 //moveq #63,d5
  a.label("cram");
  a.w(0x33c0).l(VDP_DATA);
  a.w(0x0640, 0x0246);                         //addi.w #0x246,d0
  a.dbra(5, "cram");

  //vram: 64 tiles of deterministic patterns at address 0
  moveli(a, 0x40000000, VDP_CTRL);
  a.w(0x203c).l(0x13579bdf);                   //move.l #...,d0
  a.w(0x3a3c, 0x07ff);                         //move.w #0x7ff,d5
  a.label("vram");
  a.w(0x33c0).l(VDP_DATA);
  a.w(0x0640, 0x1111);                         //addi.w #0x1111,d0
  a.dbra(5, "vram");

  //plane a: cycle tiles 0-63
  moveli(a, 0x40000003, VDP_CTRL);             //vram 0xc000 write
  a.w(0x7000);                                 //moveq #0,d0
  a.w(0x3a3c, 0x07ff);                         //move.w #2047,d5
  a.label("plane");
  a.w(0x33c0).l(VDP_DATA);
  a.w(0x5240);                                 //addq.w #1,d0
  a.w(0x0240, 0x003f);                         //andi.w #0x3f,d0
  a.dbra(5, "plane");

  //upload the z80 program: reset low, request the bus, copy, release
  //the bus is only granted while RES is high, so request it before releasing reset and pulse reset
  //afterwards to start the uploaded program from address zero
  if(!noZ80) {
  movewi(a, 0x0100, 0x00a11100);               //busreq
  movewi(a, 0x0100, 0x00a11200);               //z80 reset release
  a.label("waitbus");
  a.w(0x0839, 0x0000).l(0x00a11100);           //btst #0,0xa11100
  a.bne_s("waitbus");
  a.w(0x41f9).l(0x00000600);                   //lea rom z80 image,a0
  a.w(0x43f9).l(0x00a00000);                   //lea sound ram,a1
  a.w(0x3a3c, z80Image.length - 1);            //move.w #len-1,d5
  a.label("zcopy");
  a.w(0x12d8);                                 //move.b (a0)+,(a1)+
  a.dbra(5, "zcopy");
  movewi(a, 0x0000, 0x00a11200);               //z80 reset assert
  movewi(a, 0x0100, 0x00a11200);               //z80 reset release
  movewi(a, 0x0000, 0x00a11100);               //bus release
  }

  //psg: key three tones and noise
  for(const value of [0x8a, 0x0e, 0x90, 0xac, 0x15, 0xb2, 0xc6, 0x08, 0xb4, 0xe4, 0xf2])
    movebi(a, value, PSG);

  //pad 1: TH as output
  movebi(a, 0x40, 0x00a10009);

  a.w(0x46fc, 0x2000);                         //move.w #0x2000,sr: enable interrupts

  //main loop: poll hv/status, strobe the pad through both TH phases
  a.label("main");
  a.w(0x3039).l(0x00c00008);                   //move.w (hv counter),d0
  a.w(0x3039).l(VDP_CTRL);                     //move.w (status),d0
  a.w(0x1039).l(0x00a10003);                   //move.b (pad data),d0
  movebi(a, 0x00, 0x00a10003);                 //TH low
  a.w(0x1039).l(0x00a10003);
  movebi(a, 0x40, 0x00a10003);                 //TH high
  a.bra_s("main");

  rom.set(new Uint8Array(a.bytes), 0x200);
  rom.set(new Uint8Array(hint.bytes), 0x400);
  rom.set(new Uint8Array(vint.bytes), 0x500);
  if(a.bytes.length > 0x200) throw new Error("init code overflows");
  if(hint.bytes.length > 0x100) throw new Error("hint handler overflows");
  if(vint.bytes.length > 0x100) throw new Error("vint handler overflows");
  return rom;
}
