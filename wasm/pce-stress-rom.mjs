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
