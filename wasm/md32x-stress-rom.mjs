//Builds a Mega 32X image that drives the paths the web build's synchronous scheduling shares with
//the 32X: the adapter enabled with the 68000 executing from the 0x880000 ROM window, the 32X VDP
//compositing a packed-pixel framebuffer over an animated Mega Drive plane every scanline, a
//framebuffer flip inside vblank, 32X CRAM writes from the HINT handler (which spin on
//paletteEngaged() and therefore only complete if the Mega Drive VDP keeps advancing), and a main
//loop that folds the 32X frame buffer control register -- whose bit 1 exposes MegaDrive::vdp
//.refreshing() -- into a counter the VINT handler writes to Mega Drive CRAM, making the Mega Drive
//VDP's refresh phase at the exact 68000 access clock observable in the video hash.
//
//No SH2 program is uploaded. The SH2s, the PWM thread and the Mega Drive's own auxiliary threads
//still run as cothreads, which is the point: this image exercises the coprocessor half of
//CPU::catchUpAuxiliary(), throttled by minCyclesBetweenSyncs, from the 68000's side.
//
//Exported rather than run: wasm/md32x-sweep.mjs boots it.

class Asm {
  constructor(origin) {
    this.origin = origin;
    this.bytes = [];
    this.labels = new Map();
  }

  get pc() { return this.origin + this.bytes.length; }

  label(name) { this.labels.set(name, this.pc); return this; }

  w(...words) {
    for(const word of words) this.bytes.push(word >> 8 & 0xff, word & 0xff);
    return this;
  }

  l(value) { return this.w(value >>> 16, value & 0xffff); }

  disp(name, next) {
    const target = this.labels.get(name);
    if(target === undefined) throw new Error(`undefined label ${name}`);
    const disp = target - next;
    if(disp < -0x8000 || disp > 0x7fff) throw new Error(`branch out of range: ${name}`);
    return disp & 0xffff;
  }

  short(name) {
    const d = this.disp(name, this.pc + 2) << 16 >> 16;
    if(d < -0x80 || d > 0x7f || d === 0) throw new Error(`short branch out of range: ${name} (${d})`);
    return d & 0xff;
  }

  dbra(reg, name)  { this.w(0x51c8 | reg); return this.w(this.disp(name, this.pc)); }
  bne_s(name)      { return this.w(0x6600 | this.short(name)); }
  bra_s(name)      { return this.w(0x6000 | this.short(name)); }
}

const VDP_CTRL = 0x00c00004;
const VDP_DATA = 0x00c00000;
const PSG      = 0x00c00011;

//the 68000 runs from the 0x880000 ROM window once the adapter is enabled: with adapterEnable set,
//0x000000-0x3fffff reads only the 32X vector table and returns zero everywhere else.
const WINDOW = 0x00880000;

const M32X_ADAPTER = 0x00a15100;
const M32X_COMM0   = 0x00a15120;
const M32X_BITMAP  = 0x00a15180;
const M32X_FBCTL   = 0x00a1518a;
const M32X_CRAM    = 0x00a15200;
const M32X_FB      = 0x00840000;

//move.w #imm,(addr).l
const movewi = (a, imm, addr) => a.w(0x33fc, imm).l(addr);
//move.l #imm,(addr).l
const moveli = (a, imm, addr) => a.w(0x23fc).l(imm).l(addr);
//move.b #imm,(addr).l
const movebi = (a, imm, addr) => a.w(0x13fc, imm & 0xff).l(addr);

const FRAME  = 0x00ff0000;  //long: frame counter
const COLOR  = 0x00ff0004;  //word: hint colour counter
const SELECT = 0x00ff0006;  //word: 32X framebuffer select
const POLL   = 0x00ff0008;  //word: accumulated frame buffer control polls
const STUB   = 0x00ff0010;  //the adapter-enable stub, executed from ram

export function build32xRom({sh2 = false, no32xPalette = false, no32xLayer = false, dmaFromIO = false} = {}) {
  const rom = new Uint8Array(32768);
  const view = new DataView(rom.buffer);

  //mega drive vector table: used only until the adapter is enabled, after which the 32X vector
  //rom answers 0x000000-0x0000ff instead
  view.setUint32(0x000, 0x00fffe00);  //initial stack
  view.setUint32(0x004, 0x00000380);  //initial pc: stage 0, still reading rom directly
  for(const [i, c] of [..."SEGA 32X        "].entries()) rom[0x100 + i] = c.charCodeAt(0);
  rom[0x1f0] = "U".charCodeAt(0);     //region: NTSC-U

  //the 32X vector rom sends every autovector to a six-byte slot in the cartridge at 0x880200 +
  //6*(vector-1); level 6 is vector 30, so its slot is 0x2ae. level 4 is special-cased to the
  //writable io.vectorLevel4 register instead, which stage 1 programs directly.
  view.setUint16(0x2ae, 0x4ef9);      //jmp (vint).l
  view.setUint32(0x2b0, WINDOW + 0x500);

  //stage 0 copies this stub to work ram and jumps to it: the instruction after the adapter is
  //enabled can no longer be prefetched from 0x000000-0x3fffff
  const stub = new Asm(0x3c0);
  movewi(stub, sh2 ? 0x0003 : 0x0001, M32X_ADAPTER);
  stub.w(0x4ef9).l(WINDOW + 0x800);   //jmp (stage 1).l

  //stage 0: still executing from the cartridge at 0x000380
  const boot = new Asm(0x380);
  boot.w(0x46fc, 0x2700);             //move.w #0x2700,sr
  boot.w(0x41f9).l(0x000003c0);       //lea (stub).l,a0
  boot.w(0x43f9).l(STUB);             //lea (ram stub).l,a1
  boot.w(0x7a07);                     //moveq #7,d5
  boot.label("stub");
  boot.w(0x32d8);                     //move.w (a0)+,(a1)+
  boot.dbra(5, "stub");
  boot.w(0x4ef9).l(STUB);             //jmp (ram stub).l

  //32X palette source: 256 entries, half of them with the through bit set so the Mega Drive plane
  //stays visible underneath at priority 0
  for(let i = 0; i < 256; i++) {
    view.setUint16(0x700 + i * 2, (i & 1 ? 0x8000 : 0) | (i * 0x0111 & 0x7fff));
  }

  //stage 1: everything from here runs at WINDOW + its rom offset
  const a = new Asm(WINDOW + 0x800);
  for(const reg of [
    0x8014,        //r0: hint enable
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

  //psg: key three tones and noise
  for(const value of [0x8a, 0x0e, 0x90, 0xac, 0x15, 0xb2, 0xc6, 0x08, 0xb4, 0xe4, 0xf2])
    movebi(a, value, PSG);

  //32X palette: bitmap mode is still 0 here, so paletteEngaged() is false and these do not spin
  a.w(0x41f9).l(WINDOW + 0x700);               //lea (palette source).l,a0
  a.w(0x43f9).l(M32X_CRAM);                    //lea (32x cram).l,a1
  a.w(0x3a3c, 0x00ff);                         //move.w #255,d5
  a.label("m32xcram");
  a.w(0x32d8);                                 //move.w (a0)+,(a1)+
  a.dbra(5, "m32xcram");

  //fill both framebuffer banks: the cpu side is always the bank the vdp is not displaying, so the
  //fill runs twice with a flip in between. bitmap mode 0 lets selectFramebuffer() take effect
  //outside vblank, which is why the mode register is programmed after this.
  a.w(0x7c01);                                 //moveq #1,d6
  a.label("bank");
  a.w(0x43f9).l(M32X_FB);                      //lea (framebuffer).l,a1
  a.w(0x303c, 0x0100);                         //move.w #0x100,d0: every line points at word 0x100
  a.w(0x3a3c, 0x00df);                         //move.w #223,d5
  a.label("linetable");
  a.w(0x32c0);                                 //move.w d0,(a1)+
  a.dbra(5, "linetable");
  a.w(0x43f9).l(M32X_FB + 0x200);              //lea (word 0x100).l,a1
  a.w(0x7000);                                 //moveq #0,d0
  a.w(0x3a3c, 32 * 160 - 1);                   //move.w #32 rows of 160 words - 1,d5
  a.label("pixels");
  a.w(0x32c0);                                 //move.w d0,(a1)+
  a.w(0x0640, 0x0101);                         //addi.w #0x101,d0
  a.dbra(5, "pixels");
  a.w(0x3039).l(SELECT);                       //move.w (select).l,d0
  a.w(0x0a40, 0x0001);                         //eori.w #1,d0
  a.w(0x33c0).l(SELECT);                       //move.w d0,(select).l
  a.w(0x33c0).l(M32X_FBCTL);                   //move.w d0,(fb control).l
  a.dbra(6, "bank");

  //bitmap mode 1 (packed pixel), 224 lines, Mega Drive priority
  if(!no32xLayer) movewi(a, 0x0001, M32X_BITMAP);

  //level 4 autovector: the 32X answers 0x000070 from a writable register
  moveli(a, WINDOW + 0x600, 0x00000070);

  a.w(0x46fc, 0x2000);                         //move.w #0x2000,sr: enable interrupts

  //main loop: poll the vdp and the 32X frame buffer control register, whose bit 1 carries
  //MegaDrive::vdp.refreshing() at the exact clock of this access
  a.label("main");
  a.w(0x3039).l(0x00c00008);                   //move.w (hv counter).l,d0
  a.w(0x3039).l(VDP_CTRL);                     //move.w (status).l,d0
  a.w(0x3039).l(M32X_FBCTL);                   //move.w (fb control).l,d0
  a.w(0x0240, 0x0002);                         //andi.w #2,d0
  a.w(0xd179).l(POLL);                         //add.w d0,(poll).l
  a.bra_s("main");

  //vint: flip the framebuffer inside vblank, where selectFramebuffer() applies immediately, then
  //rewrite the line table so the 32X layer scrolls, and publish the poll counter to Mega Drive cram
  const vint = new Asm(WINDOW + 0x500);
  vint.w(0x48e7, 0xc0c0);                      //movem.l d0-d1/a0-a1,-(sp)
  vint.w(0x52b9).l(FRAME);                     //addq.l #1,(frame).l
  vint.w(0x3039).l(SELECT);                    //move.w (select).l,d0
  vint.w(0x0a40, 0x0001);                      //eori.w #1,d0
  vint.w(0x33c0).l(SELECT);                    //move.w d0,(select).l
  vint.w(0x33c0).l(M32X_FBCTL);                //move.w d0,(fb control).l
  //line base = 0x100 + (frame & 15) * 160
  vint.w(0x3039).l(FRAME + 2);                 //move.w (frame low).l,d0
  vint.w(0x0240, 0x000f);                      //andi.w #15,d0
  vint.w(0x3200);                              //move.w d0,d1
  vint.w(0xef48);                              //lsl.w #7,d0
  vint.w(0xeb49);                              //lsl.w #5,d1
  vint.w(0xd041);                              //add.w d1,d0
  vint.w(0x0640, 0x0100);                      //addi.w #0x100,d0
  vint.w(0x43f9).l(M32X_FB);                   //lea (framebuffer).l,a1
  vint.w(0x3a3c, 0x00df);                      //move.w #223,d5
  vint.label("linetable");
  vint.w(0x32c0);                              //move.w d0,(a1)+
  vint.dbra(5, "linetable");
  //publish the accumulated frame buffer control polls to mega drive cram entry 1
  moveli(vint, 0xc0020000, VDP_CTRL);          //cram write, address 2
  vint.w(0x3039).l(POLL);                      //move.w (poll).l,d0
  vint.w(0x0240, 0x0eee);                      //andi.w #0xeee,d0
  vint.w(0x33c0).l(VDP_DATA);                  //move.w d0,(data).l
  //a 68k->vram dma sourced from the i/o region: the fetch reaches Bus::read 0xa10000-0xbfffff from
  //inside the vdp's own catch-up, which is the one path by which a vdp dma can drive
  //CPU::catchUpAuxiliary() and with it a synchronizeExcept() into the sh2 cothreads
  if(dmaFromIO) {
    movewi(vint, 0x9340, VDP_CTRL);            //dma length = 0x40 words
    movewi(vint, 0x9400, VDP_CTRL);
    movewi(vint, 0x9500, VDP_CTRL);            //dma source = 0xa10000
    movewi(vint, 0x9680, VDP_CTRL);
    movewi(vint, 0x9750, VDP_CTRL);
    moveli(vint, 0x40000081, VDP_CTRL);        //vram 0x4000 write + dma start
  }

  //vsram scroll
  moveli(vint, 0x40000010, VDP_CTRL);          //vsram write, address 0
  vint.w(0x3039).l(COLOR);                     //move.w (color).l,d0
  vint.w(0x0240, 0x00ff);                      //andi.w #0xff,d0
  vint.w(0x33c0).l(VDP_DATA);
  //hand the frame counter to the sh2s through a communication register
  vint.w(0x3039).l(FRAME + 2);                 //move.w (frame low).l,d0
  vint.w(0x33c0).l(M32X_COMM0);                //move.w d0,(comm0).l
  vint.w(0x4cdf, 0x0303);                      //movem.l (sp)+,d0-d1/a0-a1
  vint.w(0x4e73);                              //rte

  //hint: rotate the mega drive backdrop and one 32X palette entry. the 32X write spins on
  //paletteEngaged() until the mega drive vdp reaches hblank, so it only retires if cpu.wait(1)
  //keeps advancing the vdp.
  const hint = new Asm(WINDOW + 0x600);
  hint.w(0x48e7, 0xc0c0);                      //movem.l d0-d1/a0-a1,-(sp)
  hint.w(0x3039).l(COLOR);                     //move.w (color).l,d0
  hint.w(0x0640, 0x0111);                      //addi.w #0x111,d0
  hint.w(0x33c0).l(COLOR);                     //move.w d0,(color).l
  moveli(hint, 0xc0000000, VDP_CTRL);          //cram write, address 0
  hint.w(0x33c0).l(VDP_DATA);                  //move.w d0,(data).l
  if(!no32xPalette) {
    hint.w(0x43f9).l(M32X_CRAM);               //lea (32x cram).l,a1
    hint.w(0x3200);                            //move.w d0,d1
    hint.w(0xe849);                            //lsr.w #4,d1
    hint.w(0x0241, 0x00ff);                    //andi.w #0xff,d1
    hint.w(0xd241);                            //add.w d1,d1
    hint.w(0x3380, 0x1000);                    //move.w d0,(a1,d1.w)
  }
  hint.w(0x4cdf, 0x0303);                      //movem.l (sp)+,d0-d1/a0-a1
  hint.w(0x4e73);                              //rte

  rom.set(new Uint8Array(stub.bytes), 0x3c0);
  rom.set(new Uint8Array(boot.bytes), 0x380);
  rom.set(new Uint8Array(a.bytes), 0x800);
  rom.set(new Uint8Array(vint.bytes), 0x500);
  rom.set(new Uint8Array(hint.bytes), 0x600);
  if(stub.bytes.length > 0x20) throw new Error("stub overflows");
  if(boot.bytes.length > 0x40) throw new Error("stage 0 overflows");
  if(a.bytes.length > 0x1000) throw new Error("stage 1 overflows");
  if(vint.bytes.length > 0x100) throw new Error("vint handler overflows");
  if(hint.bytes.length > 0x100) throw new Error("hint handler overflows");
  return rom;
}
