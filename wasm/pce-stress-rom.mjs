//Builds a PC Engine image that exercises every path the web build's plain-call scheduling can
//affect: the background and sprite renderers running off VRAM the cartridge filled by block move,
//a VDC raster interrupt five times a frame that rewrites BXR, BYR and the VCE dot clock partway
//down the screen, a vblank interrupt that starts a VRAM transfer and queues an SATB one, a timer
//interrupt around a hundred times a frame sweeping the PSG, and a main loop that reads the live
//IRQ status port -- vdp.irqLine() and timer.irqLine(), sampled mid-scanline -- on every pass.
//
//That last case is the point of the ROM. The web build advances the vdp by plain function calls
//from the cpu's cothread rather than by switching to it, so the vdp's position when the cpu looks
//at it is exactly what the two builds have to agree on. $1403 is the cheapest way to look: it
//reports the vdp's interrupt line without clearing anything, so unlike the status port it can be
//read every pass without suppressing the handlers this ROM depends on.
//
//The dot clock sweep is the second point. VCE::io.clock decides how many pixels a chunk of the
//scanline emits and how far it steps, so moving it mid-frame is what proves the web build's
//reconstruction of main()'s `output` pointer from the counters (see VDP::runChunk).
//
//Exported rather than run: wasm/pce-sweep.mjs and wasm/pce-smoke.mjs boot it.
//
//A second image lives at the bottom of this file, sharing the assembler and the constants above:
//buildSuperGrafxRom, which reaches the hardware this one cannot -- the second VDC and the priority
//controller. Editing anything above that divider moves this image's golden hashes.

//zero page, which the HuC6280 reads through MPR1 -- logical $2000 with MPR1 = $f8
const FRAME    = 0x00;  //vblank interrupts taken
const RASTER   = 0x01;  //raster interrupts taken
const TICKS    = 0x02;  //timer interrupts taken
const STATUS   = 0x03;  //most recent VDC status read
const PAD      = 0x04;  //most recent joypad read, from the vblank handler
const SCROLL   = 0x05;  //background scroll, advanced once a frame
const PHASE    = 0x06;  //VCE dot clock phase
const RCR      = 0x07;  //next raster compare line
const BRAML    = 0x08;  //battery cursor, vblank handler
const BRAMH    = 0x09;  //battery cursor, main loop
const RNG      = 0x0a;  //8-bit LFSR
const ROW      = 0x0b;  //scratch for the BAT builder
const IRQPOLL  = 0x0c;  //most recent $1403 read
const PAD2     = 0x0d;  //most recent joypad read, from the main loop
const SCROLL1  = 0x0e;  //second VDC's background scroll, SuperGrafx image only
const WINDOW   = 0x0f;  //VPC window[0] low byte, SuperGrafx image only

//hardware, through MPR0 = $ff at logical $0000
const VDC_AR   = 0x0000, VDC_DL = 0x0002, VDC_DH = 0x0003;
const VCE_CR   = 0x0400, VCE_CTAL = 0x0402, VCE_CTAH = 0x0403, VCE_CTWL = 0x0404, VCE_CTWH = 0x0405;
const PSG_SEL  = 0x0800, PSG_MAIN = 0x0801, PSG_FL = 0x0802, PSG_FH = 0x0803;
const PSG_CTRL = 0x0804, PSG_VOL = 0x0805, PSG_WAVE = 0x0806;
const TIMER_R  = 0x0c00, TIMER_C = 0x0c01;
const JOYPAD   = 0x1000;
const IRQ_MASK = 0x1402, IRQ_ACK = 0x1403;
const CD_CTRL  = 0x1807;
const BRAM     = 0x4000;  //MPR2 = $f7

//SuperGrafx only. The second VDC answers eight ports above the first, and the video priority
//controller that composites the two sits between them. A PC Engine decodes the whole of $0000-$03ff
//as its one VDC on address & 3, so every port below is a mirror of $0000-$0003 there: this block is
//exactly the range a SuperGrafx image writes and a PC Engine misreads.
const VDC1_AR  = 0x0010, VDC1_DL = 0x0012, VDC1_DH = 0x0013;
const VPC_CR0  = 0x0008;  //settings[0] in the low nibble, settings[1] in the high
const VPC_CR1  = 0x0009;  //settings[2] in the low nibble, settings[3] in the high
const VPC_W0L  = 0x000a, VPC_W0H = 0x000b;  //window[0], n10
const VPC_W1L  = 0x000c, VPC_W1H = 0x000d;  //window[1], n10
const VPC_SEL  = 0x000e;  //which VDC the ST0/ST1/ST2 instructions reach

//tables live in ROM bank 1, which MPR3 maps at logical $6000
const T_BAT    = 0x6000;  //1024 BAT words
const T_CHR    = 0x6800;  //256 background pattern words
const T_SPR    = 0x6a00;  //512 sprite pattern words
const T_SATB   = 0x6e00;  //256 SATB words

//VRAM
const V_BAT    = 0x0000;
const V_CHR    = 0x0400;  //tile indices $40-$4f resolve here: pattern address is index << 4
const V_SATB   = 0x0e00;
const V_SPR    = 0x1000;  //sprite pattern $40 resolves here: pattern address is index << 6
const V_SCRATCH= 0x1800;

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

  byte(...values) { for(const value of values) this.bytes.push(value & 0xff); return this; }
  word(value) { return this.byte(value, value >> 8); }

  //absolute or zero-page operands are numbers; a label reference is a string
  abs(opcode, target) {
    this.byte(opcode);
    if(typeof target === "string") {
      this.fixups.push({at: this.bytes.length, name: target, relative: false});
      this.word(0);
    } else {
      this.word(target);
    }
    return this;
  }

  rel(opcode, target) {
    this.byte(opcode);
    this.fixups.push({at: this.bytes.length, name: target, relative: true});
    this.byte(0);
    return this;
  }

  //instructions, named for what they do rather than for the mnemonic table
  sei()          { return this.byte(0x78); }
  cli()          { return this.byte(0x58); }
  cld()          { return this.byte(0xd8); }
  csh()          { return this.byte(0xd4); }
  ldaImm(v)      { return this.byte(0xa9, v); }
  ldaZp(a)       { return this.byte(0xa5, a); }
  ldaAbs(a)      { return this.abs(0xad, a); }
  ldaAbsX(a)     { return this.abs(0xbd, a); }
  staZp(a)       { return this.byte(0x85, a); }
  staZpX(a)      { return this.byte(0x95, a); }
  staAbs(a)      { return this.abs(0x8d, a); }
  staAbsX(a)     { return this.abs(0x9d, a); }
  stzAbs(a)      { return this.abs(0x9c, a); }
  stzZp(a)       { return this.byte(0x64, a); }
  ldxImm(v)      { return this.byte(0xa2, v); }
  ldyImm(v)      { return this.byte(0xa0, v); }
  txs()          { return this.byte(0x9a); }
  txa()          { return this.byte(0x8a); }
  tya()          { return this.byte(0x98); }
  tax()          { return this.byte(0xaa); }
  inx()          { return this.byte(0xe8); }
  iny()          { return this.byte(0xc8); }
  incZp(a)       { return this.byte(0xe6, a); }
  andImm(v)      { return this.byte(0x29, v); }
  oraImm(v)      { return this.byte(0x09, v); }
  eorImm(v)      { return this.byte(0x49, v); }
  eorZp(a)       { return this.byte(0x45, a); }
  adcImm(v)      { return this.byte(0x69, v); }
  clc()          { return this.byte(0x18); }
  aslA()         { return this.byte(0x0a); }
  cmpImm(v)      { return this.byte(0xc9, v); }
  cpyImm(v)      { return this.byte(0xc0, v); }
  bne(l)         { return this.rel(0xd0, l); }
  beq(l)         { return this.rel(0xf0, l); }
  bcc(l)         { return this.rel(0x90, l); }
  bra(l)         { return this.rel(0x80, l); }
  jmp(l)         { return this.abs(0x4c, l); }
  jsr(l)         { return this.abs(0x20, l); }
  rts()          { return this.byte(0x60); }
  rti()          { return this.byte(0x40); }
  pha()          { return this.byte(0x48); }
  pla()          { return this.byte(0x68); }
  phx()          { return this.byte(0xda); }
  plx()          { return this.byte(0xfa); }
  phy()          { return this.byte(0x5a); }
  ply()          { return this.byte(0x7a); }
  tam(mask)      { return this.byte(0x53, mask); }
  //TIA: source increments, target alternates between dst and dst+1 -- the VDC data port pair
  tia(src, dst, len) { return this.byte(0xe3).word(src).word(dst).word(len); }

  //select a VDC register, then write its low and high halves
  vdcReg(r)      { return this.ldaImm(r).staAbs(VDC_AR); }
  //the same for the SuperGrafx's second VDC
  vdc1Reg(r)     { return this.ldaImm(r).staAbs(VDC1_AR); }

  assemble() {
    for(const {at, name, relative} of this.fixups) {
      if(!this.labels.has(name)) throw new Error(`undefined label ${name}`);
      const target = this.labels.get(name);
      if(relative) {
        const delta = target - (this.origin + at + 1);
        if(delta < -128 || delta > 127) throw new Error(`branch to ${name} out of range (${delta})`);
        this.bytes[at] = delta & 0xff;
      } else {
        this.bytes[at] = target & 0xff;
        this.bytes[at + 1] = target >> 8 & 0xff;
      }
    }
    return this.bytes;
  }
}

//a deterministic byte source for the pattern tables: the same LFSR the ROM runs, so the picture and
//the battery contents are reproducible without a data blob in this file
const lfsr = (seed) => {
  let state = seed;
  return () => {
    state = state << 1 & 0xff ^ (state & 0x80 ? 0x1d : 0x00);
    if(!state) state = 0x5a;
    return state;
  };
};

const buildTables = () => {
  const table = new Uint8Array(0x1000);  //logical $6000-$6fff, ROM bank 1
  const at = address => address - 0x6000;

  //BAT: tile index $40-$4f, palette from the tile's position, so neighbouring cells differ
  for(let y = 0; y < 32; y++) {
    for(let x = 0; x < 32; x++) {
      const index = 0x40 | (x + y & 0x0f);
      const palette = (x ^ y) & 0x0f;
      const offset = at(T_BAT) + (y * 32 + x) * 2;
      table[offset + 0] = index & 0xff;
      table[offset + 1] = palette << 4 | index >> 8 & 0x0f;
    }
  }

  const chr = lfsr(0xa5);
  for(let n = 0; n < 512; n++) table[at(T_CHR) + n] = chr();
  const spr = lfsr(0x3c);
  for(let n = 0; n < 1024; n++) table[at(T_SPR) + n] = spr();

  //64 objects, spread down and across so per-line counts run past the 16-sprite limit in the middle
  //of the screen and raise the overflow interrupt, and so the first object overlaps others and
  //raises the collision one
  for(let n = 0; n < 64; n++) {
    const y = 64 + (n % 16) * 12;
    const x = 64 + (n % 16) * 9 + (n >> 4) * 4;
    const pattern = 0x40 + (n & 7);
    const attribute = (n & 0x0f) | 0x80;  //palette, foreground priority, 16x16
    const offset = at(T_SATB) + n * 8;
    table[offset + 0] = y & 0xff;      table[offset + 1] = y >> 8 & 0x03;
    table[offset + 2] = x & 0xff;      table[offset + 3] = x >> 8 & 0x03;
    table[offset + 4] = pattern << 1 & 0xff;
    table[offset + 5] = pattern >> 7 & 0x0f;
    table[offset + 6] = attribute & 0xff;
    table[offset + 7] = attribute >> 8 & 0xff;
  }

  return table;
};

export function buildStressRom() {
  const a = new Asm(0xe000);

  a.label("init");
  a.sei().csh().cld();
  //MPR0 hardware, MPR1 RAM (zero page at $2000, stack at $2100), MPR2 the CD unit's BRAM,
  //MPR3-5 ROM banks 1-3. MPR7 is already ROM bank 0 -- the reset vector was fetched through it.
  a.ldaImm(0xff).tam(0x01);
  a.ldaImm(0xf8).tam(0x02);
  a.ldaImm(0xf7).tam(0x04);
  a.ldaImm(0x01).tam(0x08);
  a.ldaImm(0x02).tam(0x10);
  a.ldaImm(0x03).tam(0x20);
  a.ldxImm(0xff).txs();

  a.ldaImm(0x00).ldxImm(0x00);
  a.label("clearZp").staZpX(0x00).inx().bne("clearZp");
  a.ldaImm(0xa5).staZp(RNG);
  a.ldaImm(0x60).staZp(RCR);

  //the CD unit's BRAM answers at bank $f7 only once this bit is set; ares reports the unit present
  //on every model so that HuCard games can save into it
  a.ldaImm(0x80).staAbs(CD_CTRL);

  //VCE: the slowest of the three dot clocks to start with, so the raster handler's sweep moves it
  a.stzAbs(VCE_CR);

  //512 colour table entries, written as a ramp so a scroll or a palette change is visible in the
  //framebuffer hash rather than being lost in a flat picture
  a.stzAbs(VCE_CTAL).stzAbs(VCE_CTAH);
  a.ldyImm(0x00);
  a.label("cramRow").ldxImm(0x00);
  a.label("cramCell");
  a.txa().staAbs(VCE_CTWL);
  a.tya().andImm(0x01).staAbs(VCE_CTWH);
  a.inx().bne("cramCell");
  a.iny().cpyImm(0x02).bne("cramRow");

  //VDC: 32x32 background, one-word address increment, both renderers on and all four interrupt
  //sources enabled
  a.vdcReg(0x09).stzAbs(VDC_DL).stzAbs(VDC_DH);
  a.vdcReg(0x05).stzAbs(VDC_DH).ldaImm(0xcf).staAbs(VDC_DL);

  //VRAM, blasted through the data port by block move: source increments, target alternates between
  //$0002 and $0003, which is the pair the VDC latches a word from
  const blast = (vramAddress, table, length) => {
    a.vdcReg(0x00);
    a.ldaImm(vramAddress & 0xff).staAbs(VDC_DL);
    a.ldaImm(vramAddress >> 8 & 0xff).staAbs(VDC_DH);
    a.vdcReg(0x02);
    a.tia(table, VDC_DL, length);
  };
  blast(V_BAT, T_BAT, 2048);
  blast(V_CHR, T_CHR, 512);
  blast(V_SPR, T_SPR, 1024);
  blast(V_SATB, T_SATB, 512);

  //DCR: repeat the SATB transfer every frame, and interrupt on both transfer kinds
  a.vdcReg(0x0f).ldaImm(0x13).staAbs(VDC_DL).stzAbs(VDC_DH);
  //RCR: the first raster compare of the frame. the handler walks it down the screen from here.
  a.vdcReg(0x06).ldaImm(0x60).staAbs(VDC_DL).stzAbs(VDC_DH);

  //timer: a reload of 63 fires around a hundred times a frame
  a.ldaImm(0x3f).staAbs(TIMER_R);
  a.ldaImm(0x01).staAbs(TIMER_C);

  //PSG: all six channels on, so every one of them is running when the timer handler sweeps
  a.ldaImm(0xff).staAbs(PSG_MAIN);
  a.ldxImm(0x00);
  a.label("psgInit");
  a.txa().staAbs(PSG_SEL);
  a.ldaImm(0x00).staAbs(PSG_CTRL);          //volume 0, channel off: writes fill the wave buffer
  a.ldyImm(0x00);
  a.label("psgWave");
  a.tya().andImm(0x1f).staAbs(PSG_WAVE);
  a.iny().cpyImm(0x20).bne("psgWave");
  a.txa().aslA().aslA().aslA().aslA().oraImm(0x08).staAbs(PSG_FL);
  a.ldaImm(0x00).staAbs(PSG_FH);
  a.ldaImm(0xff).staAbs(PSG_VOL);
  a.ldaImm(0x9f).staAbs(PSG_CTRL);          //channel on, full volume
  a.inx().txa().cmpImm(0x06).bne("psgInit");

  //IRQ2 masked off, IRQ1 and the timer let through
  a.ldaImm(0x01).staAbs(IRQ_MASK);
  a.staAbs(IRQ_ACK);
  a.cli();

  //main loop: read the live interrupt status -- the vdp's interrupt line, sampled from wherever the
  //vdp has got to on the current scanline -- and the joypad, then stir the battery
  a.label("main");
  a.ldaAbs(IRQ_ACK).staZp(IRQPOLL);
  a.ldaAbs(JOYPAD).staZp(PAD2);
  a.jsr("random");
  a.ldaZp(BRAMH).tax();
  a.ldaZp(RNG).eorZp(IRQPOLL);
  a.staAbsX(BRAM + 0x100);
  a.incZp(BRAMH);
  a.jmp("main");

  a.label("random");
  a.ldaZp(RNG).aslA().bcc("randomDone").eorImm(0x1d);
  a.label("randomDone").staZp(RNG).rts();

  //VDC interrupt: the status read is what clears the pending flags, so it happens once, here, and
  //the two handlers below work off the latched copy
  a.label("irq1");
  a.pha().phx().phy();
  a.ldaAbs(VDC_AR).staZp(STATUS);
  a.andImm(0x20).beq("noVblank");
  a.jsr("onVblank");
  a.label("noVblank");
  a.ldaZp(STATUS).andImm(0x04).beq("noRaster");
  a.jsr("onRaster");
  a.label("noRaster");
  a.ply().plx().pla().rti();

  //partway down the screen: move the background under the renderer and move the dot clock with it,
  //then arm the next compare 32 lines further down
  a.label("onRaster");
  a.incZp(RASTER);
  a.vdcReg(0x07).ldaZp(SCROLL).staAbs(VDC_DL).stzAbs(VDC_DH);
  a.vdcReg(0x08).ldaZp(FRAME).staAbs(VDC_DL).stzAbs(VDC_DH);
  a.ldaZp(PHASE).andImm(0x03).staAbs(VCE_CR);
  a.incZp(PHASE);
  a.ldaZp(RCR).clc().adcImm(0x20).cmpImm(0xe0).bcc("rcrKeep").ldaImm(0x60);
  a.label("rcrKeep").staZp(RCR);
  a.vdcReg(0x06).ldaZp(RCR).staAbs(VDC_DL).stzAbs(VDC_DH);
  a.rts();

  a.label("onVblank");
  a.incZp(FRAME);
  a.ldaImm(0x60).staZp(RCR);
  a.vdcReg(0x06).ldaImm(0x60).staAbs(VDC_DL).stzAbs(VDC_DH);
  a.stzAbs(VCE_CR);
  a.ldaZp(SCROLL).clc().adcImm(0x03).staZp(SCROLL);

  //a VRAM transfer into unused memory, purely so dma.step() is running while the vdp advances
  a.vdcReg(0x10).ldaImm(V_SPR & 0xff).staAbs(VDC_DL).ldaImm(V_SPR >> 8).staAbs(VDC_DH);
  a.vdcReg(0x11).ldaImm(V_SCRATCH & 0xff).staAbs(VDC_DL).ldaImm(V_SCRATCH >> 8).staAbs(VDC_DH);
  a.vdcReg(0x12).ldaImm(0xff).staAbs(VDC_DL).ldaImm(0x00).staAbs(VDC_DH);
  //DVSSR: queues the sprite attribute table transfer, which the VDC runs at the next vblank
  a.vdcReg(0x13).ldaImm(V_SATB & 0xff).staAbs(VDC_DL).ldaImm(V_SATB >> 8).staAbs(VDC_DH);

  //joypad: clear, then select, which is the sequence a game uses to latch both nibbles
  a.ldaImm(0x03).staAbs(JOYPAD);
  a.ldaImm(0x01).staAbs(JOYPAD);
  a.ldaAbs(JOYPAD).staZp(PAD);

  //battery: one byte a frame, so a save blob taken after a few hundred frames is not all zeroes
  a.ldaZp(BRAML).tax();
  a.ldaZp(FRAME).eorZp(PAD);
  a.staAbsX(BRAM);
  a.incZp(BRAML);
  a.rts();

  //timer interrupt: acknowledge, then sweep a PSG channel so the audio stream keeps changing
  a.label("tiq");
  a.pha();
  a.staAbs(IRQ_ACK);
  a.incZp(TICKS);
  a.ldaZp(TICKS).andImm(0x05).staAbs(PSG_SEL);
  a.ldaZp(TICKS).staAbs(PSG_FL);
  a.ldaZp(TICKS).andImm(0x03).staAbs(PSG_FH);
  a.pla().rti();

  //IRQ2 is masked and the PC Engine exposes no NMI; both vectors land here
  a.label("idleIrq");
  a.rti();

  const code = a.assemble();
  if(code.length > 0x1ff6) throw new Error(`code overruns the vector table (${code.length} bytes)`);

  const rom = new Uint8Array(32768);
  rom.set(code, 0);
  rom.set(buildTables(), 0x2000);

  const vector = (offset, name) => {
    const address = a.labels.get(name);
    rom[offset + 0] = address & 0xff;
    rom[offset + 1] = address >> 8 & 0xff;
  };
  vector(0x1ff6, "idleIrq");  //IRQ2
  vector(0x1ff8, "irq1");     //VDC
  vector(0x1ffa, "tiq");      //timer
  vector(0x1ffc, "idleIrq");  //NMI
  vector(0x1ffe, "init");     //reset

  return rom;
}

//---------------------------------------------------------------------------------------------
//A second image, for the hardware the one above cannot reach: the SuperGrafx's second VDC and the
//HuC6202 priority controller in front of both.
//
//Nothing in the image above touches VDC1, and nothing would help if it did -- the VPC powers up with
//settings[].enableVDC0 = 1 and enableVDC1 = 0 (ares/pce/vdp/vpc.hpp), so a SuperGrafx running a
//HuCard image clocks the second VDC and composites none of it. This image programs VDC1 through
//$0010-$0017 and then hands the VPC a window split: left of window[0] both VDCs are resolved
//together at priority 1 (SP0 > SP1 > BG0 > BG1), right of it VDC0 is switched out entirely and the
//picture is VDC1 alone. Blanking VDC1 therefore empties the right of the screen outright and takes
//the second VDC's sprites and the half of its background that shows through VDC0's checkerboard off
//the left.
//
//window[1] is left at 0. VPC::bus only calls a window active when it is at least 64, so window1 is
//false on every dot, mode is !window0 | 2, and only settings[2] (left) and settings[3] (right) are
//ever selected. settings[0] and settings[1] are still written, because a real image writes $0008.

//tables live in ROM bank 1, logical $6000-$7fff, which this image fills exactly
const G_BAT0   = 0x6000;  //1024 BAT words, VDC0
const G_BAT1   = 0x6800;  //1024 BAT words, VDC1
const G_CHR0   = 0x7000;  //16 background tiles, VDC0
const G_CHR1   = 0x7200;  //16 background tiles, VDC1
const G_SPR0   = 0x7400;  //8 sprite patterns, VDC0
const G_SPR1   = 0x7800;  //8 sprite patterns, VDC1
const G_SATB0  = 0x7c00;  //64 objects, VDC0
const G_SATB1  = 0x7e00;  //64 objects, VDC1

const buildSuperGrafxTables = () => {
  const table = new Uint8Array(0x2000);
  const at = address => address - 0x6000;

  //BAT: tile index $40-$4f, palette from the cell's position, seeded so the two VDCs disagree
  const bat = (base, seed) => {
    for(let y = 0; y < 32; y++) {
      for(let x = 0; x < 32; x++) {
        const index = 0x40 | (x + y + seed & 0x0f);
        const palette = (x ^ y ^ seed) & 0x0f;
        const offset = at(base) + (y * 32 + x) * 2;
        table[offset + 0] = index & 0xff;
        table[offset + 1] = palette << 4 | index >> 8 & 0x0f;
      }
    }
  };

  //a background tile is 16 words: word r carries planes 0 and 1 of row r in its low and high bytes,
  //word r+8 carries planes 2 and 3. the leftmost column is the high bit, VDC::Background::run reading
  //bit ~hoffset.
  const chr = (base, colorOf) => {
    for(let tile = 0; tile < 16; tile++) {
      for(let row = 0; row < 8; row++) {
        const plane = [0, 0, 0, 0];
        for(let column = 0; column < 8; column++) {
          const color = colorOf(tile, row, column) & 0x0f;
          for(let bit = 0; bit < 4; bit++) plane[bit] |= (color >> bit & 1) << 7 - column;
        }
        const offset = at(base) + tile * 32 + row * 2;
        table[offset +  0] = plane[0];
        table[offset +  1] = plane[1];
        table[offset + 16] = plane[2];
        table[offset + 17] = plane[3];
      }
    }
  };

  //a 16x16 sprite is 64 words: four planes of 16 rows, one whole row to a word, leftmost column in
  //bit 15 -- VDC::Sprite::run reads bit 15 - (hoffset & 15)
  const spr = (base, colorOf) => {
    for(let pattern = 0; pattern < 8; pattern++) {
      for(let row = 0; row < 16; row++) {
        const plane = [0, 0, 0, 0];
        for(let column = 0; column < 16; column++) {
          const color = colorOf(pattern, row, column) & 0x0f;
          for(let bit = 0; bit < 4; bit++) plane[bit] |= (color >> bit & 1) << 15 - column;
        }
        for(let bit = 0; bit < 4; bit++) {
          const offset = at(base) + (pattern * 64 + bit * 16 + row) * 2;
          table[offset + 0] = plane[bit] & 0xff;
          table[offset + 1] = plane[bit] >> 8 & 0xff;
        }
      }
    }
  };

  //64 objects. the sprite renderer compares against x + 32 and y + 64, so those are the offsets that
  //put an object at the top left of the display window.
  const satb = (base, seed) => {
    for(let n = 0; n < 64; n++) {
      const y = 64 + 8 + seed * 12 + (n >> 3) * 26;
      const x = 32 + 4 + seed * 14 + (n & 7) * 29;
      const pattern = 0x40 + (seed ? n >> 3 & 7 : n & 7);
      const attribute = (n + seed * 5 & 0x0f) | 0x80;  //palette, foreground priority, 16x16
      const offset = at(base) + n * 8;
      table[offset + 0] = y & 0xff;      table[offset + 1] = y >> 8 & 0x03;
      table[offset + 2] = x & 0xff;      table[offset + 3] = x >> 8 & 0x03;
      table[offset + 4] = pattern << 1 & 0xff;
      table[offset + 5] = pattern >> 7 & 0x0f;
      table[offset + 6] = attribute & 0xff;
      table[offset + 7] = attribute >> 8 & 0xff;
    }
  };

  //VDC0's background is a pixel checkerboard: half of it is colour 0, which the VPC treats as
  //"this VDC has nothing here" and resolves down to VDC1. VDC1's is dense, so it fills those gaps.
  bat(G_BAT0, 0);
  bat(G_BAT1, 9);
  chr(G_CHR0, (tile, row, column) => (row + column & 1) ? (tile + row & 0x0f) : 0);
  chr(G_CHR1, (tile, row, column) => tile + row * 2 + column & 0x0f);
  const disc = (radius, tint) => (pattern, row, column) => {
    const dy = row - 8, dx = column - 8;
    return dx * dx + dy * dy < radius ? 1 + (pattern + row + column + tint & 0x0e) : 0;
  };
  spr(G_SPR0, disc(56, 0));
  spr(G_SPR1, disc(40, 7));
  satb(G_SATB0, 0);
  satb(G_SATB1, 1);

  return table;
};

export function buildSuperGrafxRom() {
  const a = new Asm(0xe000);

  //register writes, parameterised by which VDC's port trio they go to. the two VDCs are programmed
  //by the same code with different addresses, which is what a SuperGrafx image actually does.
  const reg = (ar, r) => a.ldaImm(r).staAbs(ar);
  const write16 = (ar, dl, value, r) => {
    reg(ar, r);
    a.ldaImm(value & 0xff).staAbs(dl);
    a.ldaImm(value >> 8 & 0xff).staAbs(dl + 1);
  };
  //VRAM through the data port by block move: source increments, target alternates over the pair
  const blast = (ar, dl, vramAddress, table, length) => {
    write16(ar, dl, vramAddress, 0x00);  //MAWR
    reg(ar, 0x02);                       //VWR
    a.tia(table, dl, length);
  };
  const program = (ar, dl, tables, control) => {
    write16(ar, dl, 0x0000, 0x09);       //MWR: 32x32 background, VRAM mode 0
    blast(ar, dl, V_BAT,  tables.bat,  2048);
    blast(ar, dl, V_CHR,  tables.chr,   512);
    blast(ar, dl, V_SPR,  tables.spr,  1024);
    blast(ar, dl, V_SATB, tables.satb,  512);
    write16(ar, dl, 0x0010, 0x0f);       //DCR: repeat the SATB transfer every frame, no transfer IRQ
    write16(ar, dl, V_SATB, 0x13);       //DVSSR: queue the first one
    //CR last, so the renderers come on only once there is something for them to read. the high half
    //first: it carries the address increment, which the low half's enables must not race.
    reg(ar, 0x05);
    a.stzAbs(dl + 1);
    a.ldaImm(control).staAbs(dl);
  };

  a.label("init");
  a.sei().csh().cld();
  a.ldaImm(0xff).tam(0x01);
  a.ldaImm(0xf8).tam(0x02);
  a.ldaImm(0xf7).tam(0x04);
  a.ldaImm(0x01).tam(0x08);
  a.ldaImm(0x02).tam(0x10);
  a.ldaImm(0x03).tam(0x20);
  a.ldxImm(0xff).txs();

  a.ldaImm(0x00).ldxImm(0x00);
  a.label("clearZp").staZpX(0x00).inx().bne("clearZp");
  a.ldaImm(0xa5).staZp(RNG);
  a.ldaImm(0x40).staZp(RCR);
  a.ldaImm(0x94).staZp(WINDOW);

  a.ldaImm(0x80).staAbs(CD_CTRL);

  //VCE: the slowest dot clock, so a display window is 256 dots of four samples each
  a.stzAbs(VCE_CR);

  //512 colour table entries written as a ramp, so entry n holds n: a palette index and the colour it
  //resolves to are the same number, and entry 0 -- the backdrop, and what the VPC returns when
  //neither VDC has anything -- is black.
  a.stzAbs(VCE_CTAL).stzAbs(VCE_CTAH);
  a.ldyImm(0x00);
  a.label("cramRow").ldxImm(0x00);
  a.label("cramCell");
  a.txa().staAbs(VCE_CTWL);
  a.tya().andImm(0x01).staAbs(VCE_CTWH);
  a.inx().bne("cramCell");
  a.iny().cpyImm(0x02).bne("cramRow");

  //VDC0 keeps the coincidence and vblank interrupts; VDC1 gets none. vdp.irqLine() is the OR of the
  //two, and only VDC0's status port is read, so an enabled VDC1 source would hold IRQ1 asserted for
  //the rest of the run.
  program(VDC_AR,  VDC_DL,  {bat: G_BAT0, chr: G_CHR0, spr: G_SPR0, satb: G_SATB0}, 0xcc);
  program(VDC1_AR, VDC1_DL, {bat: G_BAT1, chr: G_CHR1, spr: G_SPR1, satb: G_SATB1}, 0xc0);

  //RCR: the first raster compare of the frame; the handler walks it down from here
  write16(VDC_AR, VDC_DL, 0x0040, 0x06);

  //VPC. settings[2] is the left of the window: both VDCs, priority 1, so VDC1's sprites come out in
  //front of VDC0's background and VDC1's background fills VDC0's transparent half. settings[3] is
  //the right of it: enableVDC0 clear, so that side of the picture is the second VDC alone.
  a.ldaImm(0x33).staAbs(VPC_CR0);
  a.ldaImm(0x27).staAbs(VPC_CR1);
  a.ldaZp(WINDOW).staAbs(VPC_W0L);
  a.ldaImm(0x01).staAbs(VPC_W0H);
  a.stzAbs(VPC_W1L).stzAbs(VPC_W1H);
  a.stzAbs(VPC_SEL);

  //timer: a reload of 63 fires around a hundred times a frame
  a.ldaImm(0x3f).staAbs(TIMER_R);
  a.ldaImm(0x01).staAbs(TIMER_C);

  //PSG: all six channels on, so every one of them is running when the timer handler sweeps
  a.ldaImm(0xff).staAbs(PSG_MAIN);
  a.ldxImm(0x00);
  a.label("psgInit");
  a.txa().staAbs(PSG_SEL);
  a.ldaImm(0x00).staAbs(PSG_CTRL);
  a.ldyImm(0x00);
  a.label("psgWave");
  a.tya().andImm(0x1f).staAbs(PSG_WAVE);
  a.iny().cpyImm(0x20).bne("psgWave");
  a.txa().aslA().aslA().aslA().aslA().oraImm(0x08).staAbs(PSG_FL);
  a.ldaImm(0x00).staAbs(PSG_FH);
  a.ldaImm(0xff).staAbs(PSG_VOL);
  a.ldaImm(0x9f).staAbs(PSG_CTRL);
  a.inx().txa().cmpImm(0x06).bne("psgInit");

  a.ldaImm(0x01).staAbs(IRQ_MASK);
  a.staAbs(IRQ_ACK);
  a.cli();

  //main loop: the live interrupt line, sampled from wherever the vdp has got to on the current
  //scanline, then the joypad, then a byte of battery
  a.label("main");
  a.ldaAbs(IRQ_ACK).staZp(IRQPOLL);
  a.ldaAbs(JOYPAD).staZp(PAD2);
  a.jsr("random");
  a.ldaZp(BRAMH).tax();
  a.ldaZp(RNG).eorZp(IRQPOLL);
  a.staAbsX(BRAM + 0x100);
  a.incZp(BRAMH);
  a.jmp("main");

  a.label("random");
  a.ldaZp(RNG).aslA().bcc("randomDone").eorImm(0x1d);
  a.label("randomDone").staZp(RNG).rts();

  a.label("irq1");
  a.pha().phx().phy();
  a.ldaAbs(VDC_AR).staZp(STATUS);
  a.andImm(0x20).beq("noVblank");
  a.jsr("onVblank");
  a.label("noVblank");
  a.ldaZp(STATUS).andImm(0x04).beq("noRaster");
  a.jsr("onRaster");
  a.label("noRaster");
  a.ply().plx().pla().rti();

  //partway down the screen: scroll the two backgrounds against each other and walk the window split
  //sideways, so the boundary between "both VDCs" and "VDC1 alone" is a staircase rather than a line
  a.label("onRaster");
  a.incZp(RASTER);
  a.vdcReg(0x07).ldaZp(SCROLL).staAbs(VDC_DL).stzAbs(VDC_DH);
  a.vdc1Reg(0x07).ldaZp(SCROLL1).staAbs(VDC1_DL).stzAbs(VDC1_DH);
  a.ldaZp(WINDOW).clc().adcImm(0x08).staZp(WINDOW).staAbs(VPC_W0L);
  a.ldaZp(RCR).clc().adcImm(0x20).cmpImm(0xe0).bcc("rcrKeep").ldaImm(0x40);
  a.label("rcrKeep").staZp(RCR);
  a.vdcReg(0x06).ldaZp(RCR).staAbs(VDC_DL).stzAbs(VDC_DH);
  a.rts();

  a.label("onVblank");
  a.incZp(FRAME);
  a.ldaImm(0x40).staZp(RCR);
  a.vdcReg(0x06).ldaImm(0x40).staAbs(VDC_DL).stzAbs(VDC_DH);
  a.ldaImm(0x94).staZp(WINDOW).staAbs(VPC_W0L);
  a.ldaZp(SCROLL).clc().adcImm(0x02).staZp(SCROLL);
  a.ldaZp(SCROLL1).clc().adcImm(0xfd).staZp(SCROLL1);  //-3: the two backgrounds pull apart
  a.vdc1Reg(0x08).ldaZp(FRAME).staAbs(VDC1_DL).stzAbs(VDC1_DH);

  //a VRAM transfer on the second VDC, so vdc1.dma.step() is running while the vdp advances -- the
  //arm of VDP::step the HuCard image never reaches
  a.vdc1Reg(0x10).ldaImm(V_SPR & 0xff).staAbs(VDC1_DL).ldaImm(V_SPR >> 8).staAbs(VDC1_DH);
  a.vdc1Reg(0x11).ldaImm(V_SCRATCH & 0xff).staAbs(VDC1_DL).ldaImm(V_SCRATCH >> 8).staAbs(VDC1_DH);
  a.vdc1Reg(0x12).ldaImm(0xff).staAbs(VDC1_DL).ldaImm(0x00).staAbs(VDC1_DH);

  //DVSSR on both, so both sprite attribute tables are refetched at the next vblank
  a.vdcReg(0x13).ldaImm(V_SATB & 0xff).staAbs(VDC_DL).ldaImm(V_SATB >> 8).staAbs(VDC_DH);
  a.vdc1Reg(0x13).ldaImm(V_SATB & 0xff).staAbs(VDC1_DL).ldaImm(V_SATB >> 8).staAbs(VDC1_DH);

  a.ldaImm(0x03).staAbs(JOYPAD);
  a.ldaImm(0x01).staAbs(JOYPAD);
  a.ldaAbs(JOYPAD).staZp(PAD);

  a.ldaZp(BRAML).tax();
  a.ldaZp(FRAME).eorZp(PAD);
  a.staAbsX(BRAM);
  a.incZp(BRAML);
  a.rts();

  a.label("tiq");
  a.pha();
  a.staAbs(IRQ_ACK);
  a.incZp(TICKS);
  a.ldaZp(TICKS).andImm(0x05).staAbs(PSG_SEL);
  a.ldaZp(TICKS).staAbs(PSG_FL);
  a.ldaZp(TICKS).andImm(0x03).staAbs(PSG_FH);
  a.pla().rti();

  a.label("idleIrq");
  a.rti();

  const code = a.assemble();
  if(code.length > 0x1ff6) throw new Error(`code overruns the vector table (${code.length} bytes)`);

  const rom = new Uint8Array(32768);
  rom.set(code, 0);
  rom.set(buildSuperGrafxTables(), 0x2000);

  const vector = (offset, name) => {
    const address = a.labels.get(name);
    rom[offset + 0] = address & 0xff;
    rom[offset + 1] = address >> 8 & 0xff;
  };
  vector(0x1ff6, "idleIrq");  //IRQ2
  vector(0x1ff8, "irq1");     //VDC
  vector(0x1ffa, "tiq");      //timer
  vector(0x1ffc, "idleIrq");  //NMI
  vector(0x1ffe, "init");     //reset

  return rom;
}
