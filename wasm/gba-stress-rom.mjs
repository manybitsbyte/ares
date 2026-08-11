//Builds a Game Boy Advance cartridge that keeps the ppu, all four PSG channels, both sound FIFOs,
//the DMA controller and the interrupt path moving, so a scheduling change surfaces as a picture or
//a waveform difference. It also builds the BIOS that runs it, for the reason below.
//
//THE BIOS IS A STUB, AND IT HAS TO BE. ares refuses to bring the machine up without one
//(mia/system/game-boy-advance.cpp:7-14 returns romNotFound on an empty read) and cannot substitute
//for it: ARM7TDMI::power() ends in exception(PSR::SVC, 0x00), so the processor starts executing at
//0x0000'0000, inside the BIOS, and 16 KiB of zeroes decode as `andeq r0,r0,r0` forever. Nintendo's
//BIOS is not in this repository and will not be, so the harness writes its own: the eight exception
//vectors, the three stack pointers the real one installs, the IRQ dispatch through [0x03FFFFFC],
//and a jump to the cartridge. That is the whole contract this cartridge depends on.
//
//What a stub costs is worth naming. It is not Nintendo's BIOS, so anything a commercial game gets
//from that ROM -- the SWI table, the boot logo check, the exact register state at handoff -- is
//absent here. It costs the fidelity comparison nothing, because both sides of that comparison run
//this same BIOS: the sweep measures the web build against a cothread build of the same sources, and
//the BIOS is just program bytes to both. It is not a substitute for running a real game.

const ROM_BASE   = 0x08000000;
const BIOS_BASE  = 0x00000000;
const IO         = 0x04000000;
const PRAM       = 0x05000000;
const VRAM       = 0x06000000;
const OAM        = 0x07000000;
const EWRAM      = 0x02000000;
const IWRAM      = 0x03000000;

//data-processing opcodes, in the encoding's own order
const AND = 0, EOR = 1, SUB = 2, RSB = 3, ADD = 4, ADC = 5, SBC = 6, RSC = 7;
const TST = 8, TEQ = 9, CMP = 10, CMN = 11, ORR = 12, MOV = 13, BIC = 14, MVN = 15;

//condition codes
const EQ = 0x0, NE = 0x1, CS = 0x2, CC = 0x3, MI = 0x4, PL = 0x5, LT = 0xb, GT = 0xc, AL = 0xe;

//shift types
const LSL = 0, LSR = 1, ASR = 2, ROR = 3;

//an ARM immediate is an 8-bit value rotated right by an even amount, so most constants do not fit
//and have to come out of a literal pool instead
function immediateField(value) {
  value >>>= 0;
  for(let rotate = 0; rotate < 16; rotate++) {
    const shift = rotate * 2;
    const rotated = shift === 0 ? value : ((value << shift) | (value >>> (32 - shift))) >>> 0;
    if(rotated <= 0xff) return (rotate << 8) | rotated;
  }
  return null;
}

//Only the ARM subset this ROM uses. Named after what each instruction does rather than after a
//disassembler's syntax, because the program below reads as a program and not as a word table.
class Assembler {
  constructor(origin) {
    this.origin = origin;
    this.words = [];
    this.labels = new Map();
    this.branches = [];   //{index, name}
    this.constants = [];  //{index, value?, name?} — pending until the next pool()
  }

  get pc() { return this.origin + this.words.length * 4; }

  emit(word) { this.words.push(word >>> 0); return this; }

  label(name) {
    if(this.labels.has(name)) throw new Error(`duplicate label: ${name}`);
    this.labels.set(name, this.pc);
    return this;
  }

  //rd = rn <op> #value
  dpi(op, rd, rn, value, {cond = AL, s = false} = {}) {
    const field = immediateField(value);
    if(field === null) throw new Error(`immediate does not fit an ARM rotate: 0x${(value >>> 0).toString(16)}`);
    return this.emit((cond << 28) | (1 << 25) | (op << 21) | (s ? 1 << 20 : 0) | (rn << 16) | (rd << 12) | field);
  }

  //rd = rn <op> (rm shifted)
  dpr(op, rd, rn, rm, {cond = AL, s = false, shift = LSL, amount = 0} = {}) {
    return this.emit((cond << 28) | (op << 21) | (s ? 1 << 20 : 0) | (rn << 16) | (rd << 12)
      | (amount << 7) | (shift << 5) | rm);
  }

  mov(rd, value, options) { return this.dpi(MOV, rd, 0, value, options); }
  movr(rd, rm, options) { return this.dpr(MOV, rd, 0, rm, options); }
  add(rd, rn, value, options) { return this.dpi(ADD, rd, rn, value, options); }
  addr(rd, rn, rm, options) { return this.dpr(ADD, rd, rn, rm, options); }
  sub(rd, rn, value, options) { return this.dpi(SUB, rd, rn, value, options); }
  and(rd, rn, value, options) { return this.dpi(AND, rd, rn, value, options); }
  andr(rd, rn, rm, options) { return this.dpr(AND, rd, rn, rm, options); }
  orr(rd, rn, value, options) { return this.dpi(ORR, rd, rn, value, options); }
  orrr(rd, rn, rm, options) { return this.dpr(ORR, rd, rn, rm, options); }
  eorr(rd, rn, rm, options) { return this.dpr(EOR, rd, rn, rm, options); }
  cmp(rn, value, options) { return this.dpi(CMP, 0, rn, value, {...options, s: true}); }
  tst(rn, value, options) { return this.dpi(TST, 0, rn, value, {...options, s: true}); }

  //word and byte transfers; a negative offset encodes as the down direction
  mem(load, rd, rn, offset = 0, {cond = AL, byte = false, pre = true, writeback = false} = {}) {
    const magnitude = Math.abs(offset);
    if(magnitude > 0xfff) throw new Error(`transfer offset out of range: ${offset}`);
    return this.emit((cond << 28) | (1 << 26) | (pre ? 1 << 24 : 0) | (offset >= 0 ? 1 << 23 : 0)
      | (byte ? 1 << 22 : 0) | (writeback ? 1 << 21 : 0) | (load ? 1 << 20 : 0)
      | (rn << 16) | (rd << 12) | magnitude);
  }

  //halfword transfers use the other addressing format entirely, with the offset split in two
  memHalf(load, rd, rn, offset = 0, {cond = AL, pre = true, writeback = false} = {}) {
    const magnitude = Math.abs(offset);
    if(magnitude > 0xff) throw new Error(`halfword offset out of range: ${offset}`);
    return this.emit((cond << 28) | (pre ? 1 << 24 : 0) | (offset >= 0 ? 1 << 23 : 0) | (1 << 22)
      | (writeback ? 1 << 21 : 0) | (load ? 1 << 20 : 0) | (rn << 16) | (rd << 12)
      | (((magnitude >> 4) & 0xf) << 8) | (0xb << 4) | (magnitude & 0xf));
  }

  ldr(rd, rn, offset, options) { return this.mem(true, rd, rn, offset, options); }
  str(rd, rn, offset, options) { return this.mem(false, rd, rn, offset, options); }
  ldrh(rd, rn, offset, options) { return this.memHalf(true, rd, rn, offset, options); }
  strh(rd, rn, offset, options) { return this.memHalf(false, rd, rn, offset, options); }
  //post-indexed: the base always writes back, and the W bit means something else here
  ldrPost(rd, rn, step) { return this.mem(true, rd, rn, step, {pre: false}); }
  strPost(rd, rn, step) { return this.mem(false, rd, rn, step, {pre: false}); }
  strhPost(rd, rn, step) { return this.memHalf(false, rd, rn, step, {pre: false}); }

  //rd = #value, from a rotated immediate when one exists and from the literal pool when not
  set(rd, value, {cond = AL} = {}) {
    if(immediateField(value) !== null) return this.mov(rd, value, {cond});
    if(immediateField((~value) >>> 0) !== null) return this.dpi(MVN, rd, 0, (~value) >>> 0, {cond});
    return this.poolLoad(rd, {value: value >>> 0}, cond);
  }

  //rd = &label; always a pool entry, because the address is not known until everything is placed
  setLabel(rd, name, {cond = AL} = {}) { return this.poolLoad(rd, {name}, cond); }

  poolLoad(rd, entry, cond) {
    this.constants.push({index: this.words.length, ...entry});
    return this.emit((cond << 28) | (1 << 26) | (1 << 24) | (1 << 23) | (1 << 20) | (15 << 16) | (rd << 12));
  }

  //places every constant requested since the last pool() and patches its loads. a pool has to sit
  //within 4 KiB of its loads and must not be executed, so callers put one after each unconditional
  //branch.
  pool() {
    const entries = [];
    const keyOf = entry => entry.name !== undefined ? `L:${entry.name}` : `V:${entry.value}`;
    const placement = new Map();
    for(const constant of this.constants) {
      const key = keyOf(constant);
      if(!placement.has(key)) {
        placement.set(key, this.words.length + entries.length);
        entries.push(constant);
      }
    }
    const base = this.words.length;
    for(const entry of entries) {
      if(entry.name !== undefined) this.branches.push({index: this.words.length, name: entry.name, absolute: true});
      this.emit(entry.name !== undefined ? 0 : entry.value);
    }
    for(const constant of this.constants) {
      const target = this.origin + placement.get(keyOf(constant)) * 4;
      const offset = target - (this.origin + constant.index * 4 + 8);
      if(offset < 0 || offset > 0xfff) throw new Error(`literal pool out of reach: ${offset}`);
      this.words[constant.index] |= offset;
    }
    this.constants = [];
    void base;
    return this;
  }

  branch(name, {cond = AL, link = false} = {}) {
    this.branches.push({index: this.words.length, name});
    return this.emit((cond << 28) | (5 << 25) | (link ? 1 << 24 : 0));
  }

  call(name, options) { return this.branch(name, {...options, link: true}); }
  bx(rm, {cond = AL} = {}) { return this.emit((cond << 28) | 0x012fff10 | rm); }

  push(registers) { return this.emit(0xe92d0000 | registers); }  //stmfd sp!, {…}
  pop(registers) { return this.emit(0xe8bd0000 | registers); }   //ldmfd sp!, {…}

  //msr cpsr_c, #mode — the control byte only, which is what mode switching needs
  mode(value) {
    const field = immediateField(value);
    if(field === null) throw new Error(`mode does not fit an ARM rotate: ${value}`);
    return this.emit(0xe321f000 | field);
  }

  returnFromIRQ() { return this.emit(0xe25ef004); }  //subs pc, lr, #4
  returnFromSWI() { return this.emit(0xe1b0f00e); }  //movs pc, lr

  assemble() {
    if(this.constants.length) throw new Error("literal pool was never placed");
    for(const {index, name, absolute} of this.branches) {
      if(!this.labels.has(name)) throw new Error(`undefined label: ${name}`);
      const target = this.labels.get(name);
      if(absolute) { this.words[index] = target >>> 0; continue; }
      const offset = (target - (this.origin + index * 4 + 8)) >> 2;
      this.words[index] |= offset & 0x00ffffff;
    }
    const bytes = new Uint8Array(this.words.length * 4);
    const view = new DataView(bytes.buffer);
    this.words.forEach((word, index) => view.setUint32(index * 4, word, true));
    return bytes;
  }
}

//registers, by the names the program uses them under
const r0 = 0, r1 = 1, r2 = 2, r3 = 3, r4 = 4, r12 = 12, sp = 13, lr = 14;
const R4 = 1 << 4, LR = 1 << 14;

//The BIOS. Vectors, stacks, IRQ dispatch, and a jump to the cartridge — nothing else, because the
//cartridge below asks for nothing else. A game that called SWI would find every call returning
//immediately, which is why this cannot run one.
export function buildStubBios() {
  const a = new Assembler(BIOS_BASE);

  a.branch("reset");     //0x00 reset
  a.branch("hang");      //0x04 undefined instruction
  a.branch("swi");       //0x08 software interrupt
  a.branch("hang");      //0x0c prefetch abort
  a.branch("hang");      //0x10 data abort
  a.branch("hang");      //0x14 reserved
  a.branch("irq");       //0x18 interrupt request
  a.branch("hang");      //0x1c fast interrupt request

  a.label("reset");
  a.mode(0xd2); a.set(sp, 0x03007fa0);  //IRQ mode
  a.mode(0xd3); a.set(sp, 0x03007fe0);  //supervisor mode
  a.mode(0x1f); a.set(sp, 0x03007f00);  //system mode, interrupts enabled at the processor
  a.set(r0, ROM_BASE);
  a.bx(r0);
  a.pool();

  //the real BIOS reads the user handler out of 0x03007ffc, which is what every game installs one
  //into; 0x03fffffc is the same word through IWRAM's mirror, and reaching it from the I/O base is
  //how the original does it
  a.label("irq");
  a.push((1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 12) | LR);
  a.set(r0, IO);
  a.add(lr, 15, 0);              //lr = the pop below
  a.ldr(15, r0, -4);             //pc = [0x03fffffc]
  a.pop((1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 12) | LR);
  a.returnFromIRQ();
  a.pool();

  a.label("swi");
  a.returnFromSWI();

  a.label("hang");
  a.branch("hang");

  const code = a.assemble();
  const bios = new Uint8Array(16 * 1024);
  bios.set(code.subarray(0, bios.length));
  return bios;
}

//The GBA header. The stub BIOS checks none of it, but mia reads the game code at 0xac to pick a
//save type override and ares reads the same four bytes for its Advance Wars render-cycle quirk, so
//it is filled in properly rather than left blank.
function writeHeader(rom, {gameCode}) {
  const ascii = (offset, text, length) => {
    for(let index = 0; index < length; index++) {
      rom[offset + index] = index < text.length ? text.charCodeAt(index) : 0x00;
    }
  };
  ascii(0xa0, "ARESSTRESS", 12);
  ascii(0xac, gameCode, 4);
  ascii(0xb0, "00", 2);
  rom[0xb2] = 0x96;  //fixed value
  let check = 0;
  for(let offset = 0xa0; offset <= 0xbc; offset++) check += rom[offset];
  rom[0xbd] = (-(0x19 + check)) & 0xff;
}

//mia decides a cartridge's save type by scanning the whole image for one of these strings
//(mia/medium/game-boy-advance.cpp:126-138). It takes the first match in its own list order rather
//than the first in the image, so exactly one is embedded.
const saveIdentifiers = {
  none: null,
  sram: "SRAM_V113",
  eeprom: "EEPROM_V122",
  flash: "FLASH_V126",
  flash1m: "FLASH1M_V103",
};

export function buildStressRom({
  save = "none",     //none | sram | eeprom | flash | flash1m
  rtc = false,       //embed the real-time clock identifier as well
  raster = true,     //hblank interrupt rewriting the backdrop and the scroll every scanline
  dma = true,        //vblank DMA of a shadow OAM table
  fifo = true,       //timer-driven DMA into sound FIFO A
  sprites = true,    //128 sprites, filling every object line
  window = true,     //window 0 clipping the display
} = {}) {
  const a = new Assembler(ROM_BASE);

  a.branch("main");
  //0x04-0xbf is the header; the assembler emits words, so it is reserved here and filled in below.
  //an RTC cartridge additionally answers reads and writes at ROM offsets 0xc4, 0xc6 and 0xc8 from
  //its GPIO port rather than from the ROM (ares/gba/cartridge/cartridge.hpp:35-39,56-60), so on
  //those carts the first two instructions after the header would never be fetched. real RTC
  //cartridges leave that window alone; this one starts past it.
  const entry = rtc ? 0xcc : 0xc0;
  for(let offset = 4; offset < entry; offset += 4) a.emit(0);

  a.label("main");

  //the handler pointer the BIOS dispatches through
  a.setLabel(r1, "irqHandler");
  a.set(r0, 0x03007ffc);
  a.str(r1, r0, 0);

  //palettes: 512 entries covering both the background and object halves
  a.set(r1, PRAM);
  a.mov(r2, 0);
  a.label("paletteLoop");
  a.movr(r3, r2, {shift: LSL, amount: 10});
  a.eorr(r3, r3, r2, {shift: LSL, amount: 5});
  a.eorr(r3, r3, r2);
  a.strhPost(r3, r1, 2);
  a.add(r2, r2, 1);
  a.cmp(r2, 0x200);
  a.branch("paletteLoop", {cond: NE});

  //background tiles: 256 four-bit tiles at character base 0
  a.set(r1, VRAM);
  a.mov(r2, 0);
  a.label("tileLoop");
  a.eorr(r3, r2, r2, {shift: LSL, amount: 7});
  a.addr(r3, r3, r2, {shift: LSL, amount: 3});
  a.strPost(r3, r1, 4);
  a.add(r2, r2, 1);
  a.cmp(r2, 0x800);
  a.branch("tileLoop", {cond: NE});

  //object tiles, which live in their own VRAM region
  a.set(r1, VRAM + 0x10000);
  a.mov(r2, 0);
  a.label("objectTileLoop");
  a.eorr(r3, r2, r2, {shift: LSR, amount: 3});
  a.orrr(r3, r3, r2, {shift: LSL, amount: 12});
  a.strPost(r3, r1, 4);
  a.add(r2, r2, 1);
  a.cmp(r2, 0x800);
  a.branch("objectTileLoop", {cond: NE});

  //the 32x32 tile map, at screen base block 8
  a.set(r1, VRAM + 0x4000);
  a.mov(r2, 0);
  a.label("mapLoop");
  a.and(r3, r2, 0xff);
  a.and(r12, r2, 0x0f);
  a.orrr(r3, r3, r12, {shift: LSL, amount: 12});
  a.strhPost(r3, r1, 2);
  a.add(r2, r2, 1);
  a.cmp(r2, 0x400);
  a.branch("mapLoop", {cond: NE});

  //160 object entries in EWRAM: 128 are copied into OAM each frame, and the 32 spare rows are what
  //the copy slides through to animate them
  a.set(r1, EWRAM + 0x400);
  a.mov(r2, 0);
  a.label("objectLoop");
  a.and(r3, r2, 7);
  a.movr(r3, r3, {shift: LSL, amount: 4});
  a.add(r3, r3, 8);                                  //attribute 0: y, square, sixteen colours
  a.strhPost(r3, r1, 2);
  a.movr(r12, r2, {shift: LSR, amount: 3});
  a.movr(r12, r12, {shift: LSL, amount: 4});
  a.add(r12, r12, 8);
  a.orr(r12, r12, 0x4000);                           //attribute 1: x, size 1 (16x16)
  a.strhPost(r12, r1, 2);
  a.movr(r3, r2, {shift: LSL, amount: 2});
  a.and(r12, r2, 0x0f);
  a.orrr(r3, r3, r12, {shift: LSL, amount: 12});     //attribute 2: tile, palette bank
  a.strhPost(r3, r1, 2);
  a.add(r1, r1, 2);                                  //the affine halfword is not ours to set
  a.add(r2, r2, 1);
  a.cmp(r2, 160);
  a.branch("objectLoop", {cond: NE});

  //the sound FIFO's sample buffer: a sawtooth, four signed bytes to the word
  a.set(r1, EWRAM);
  a.mov(r2, 0);
  a.label("sampleLoop");
  a.movr(r3, r2, {shift: LSL, amount: 2});
  a.eorr(r3, r3, r2, {shift: LSL, amount: 10});
  a.orrr(r3, r3, r2, {shift: LSL, amount: 18});
  a.strPost(r3, r1, 4);
  a.add(r2, r2, 1);
  a.cmp(r2, 0x100);
  a.branch("sampleLoop", {cond: NE});

  a.set(r0, IO);

  //background 0: character base 0, screen base 8, priority 0
  a.set(r1, 0x0800);
  a.strh(r1, r0, 0x08);

  if(window) {
    a.set(r1, (16 << 8) | 200);  a.strh(r1, r0, 0x40);  //WIN0H
    a.set(r1, (16 << 8) | 140);  a.strh(r1, r0, 0x44);  //WIN0V
    a.set(r1, 0x3f3f);           a.strh(r1, r0, 0x48);  //WININ
    a.set(r1, 0x001f);           a.strh(r1, r0, 0x4a);  //WINOUT
  }

  //master sound enable has to come first: with it clear, every register below reads back as zero
  a.set(r1, 0x0080); a.strh(r1, r0, 0x84);  //SOUNDCNT_X
  a.set(r1, 0xff77); a.strh(r1, r0, 0x80);  //SOUNDCNT_L: all four channels, both sides
  a.set(r1, fifo ? 0x0b0e : 0x0002); a.strh(r1, r0, 0x82);  //SOUNDCNT_H

  a.set(r1, 0x0000); a.strh(r1, r0, 0x60);  //square 1: no sweep
  a.set(r1, 0xf080); a.strh(r1, r0, 0x62);  //duty 2, full volume, no envelope decay
  a.set(r1, 0x8700); a.strh(r1, r0, 0x64);  //restart
  a.set(r1, 0xa040); a.strh(r1, r0, 0x68);  //square 2: duty 1, volume 10
  a.set(r1, 0x8600); a.strh(r1, r0, 0x6c);

  //wave RAM is banked, and writes land in the bank that is *not* playing, so the bank bit is set
  //while the pattern goes in and cleared to play it back
  a.set(r1, 0x0040); a.strh(r1, r0, 0x70);
  a.mov(r2, 0);
  a.label("waveLoop");
  a.eorr(r3, r2, r2, {shift: LSL, amount: 4});
  a.orrr(r3, r3, r2, {shift: LSL, amount: 8});
  a.addr(r12, r0, r2, {shift: LSL, amount: 1});
  a.strh(r3, r12, 0x90);
  a.add(r2, r2, 1);
  a.cmp(r2, 8);
  a.branch("waveLoop", {cond: NE});
  a.set(r1, 0x0080); a.strh(r1, r0, 0x70);  //play bank 0
  a.set(r1, 0x2000); a.strh(r1, r0, 0x72);  //full volume
  a.set(r1, 0x8700); a.strh(r1, r0, 0x74);  //restart
  a.set(r1, 0xf000); a.strh(r1, r0, 0x78);  //noise: full volume, no envelope decay
  a.set(r1, 0x8003); a.strh(r1, r0, 0x7c);  //restart

  if(fifo) {
    //timer 0 clocks FIFO A at 32768 Hz, and DMA 1 in its special timing mode refills the FIFO four
    //words at a time whenever the timer asks for them
    a.set(r1, EWRAM);        a.str(r1, r0, 0xbc);   //DMA1SAD
    a.set(r1, IO + 0xa0);    a.str(r1, r0, 0xc0);   //DMA1DAD, sound FIFO A
    a.set(r1, 0xb6400000);   a.str(r1, r0, 0xc4);   //length ignored; fixed destination, repeat, word, special
    a.set(r1, 65536 - 512);
    a.set(r2, IO + 0x100);
    a.strh(r1, r2, 0x00);                           //TM0CNT_L
    a.set(r1, 0x0080);
    a.strh(r1, r2, 0x02);                           //TM0CNT_H: enable, no prescaler
  }

  //display control last, so nothing above is visible half-configured
  let dispcnt = 0x0100;                     //background 0
  if(sprites) dispcnt |= 0x1040;            //objects, one-dimensional mapping
  if(window) dispcnt |= 0x2000;             //window 0
  a.set(r1, dispcnt); a.strh(r1, r0, 0x00);

  //interrupts: vblank always, hblank only when the raster effect is wanted
  a.set(r1, raster ? 0x0018 : 0x0008); a.strh(r1, r0, 0x04);   //DISPSTAT
  a.set(r2, IO + 0x200);
  a.set(r1, raster ? 0x0003 : 0x0001); a.strh(r1, r2, 0x00);   //IE
  a.set(r1, 0x0001);                   a.strh(r1, r2, 0x08);   //IME

  //the frame counter the handlers animate from. it lives in IWRAM because the cartridge is read
  //only: a counter kept in the image would never move and every animation below would stand still.
  a.set(r1, IWRAM);
  a.mov(r2, 0);
  a.str(r2, r1, 0);

  //a main loop that keeps the bus busy rather than parking in a branch-to-self: it reads I/O, reads
  //ROM through the prefetch unit, and writes IWRAM, so the wait-state paths stay exercised. its
  //palette write is what separates the two renderers: it lands wherever the loop happens to be,
  //which is to say in the middle of a scanline, and only the per-cycle renderer can see that.
  a.set(r0, IO);
  a.set(r1, IWRAM);
  a.set(r4, PRAM);
  a.label("mainLoop");
  a.ldrh(r2, r0, 0x06);        //VCOUNT
  a.ldr(r3, r1, 0);
  a.eorr(r3, r3, r2, {shift: LSL, amount: 3});
  a.add(r3, r3, 1);
  a.str(r3, r1, 4);            //a scratch word, not the counter the handlers own
  a.strh(r3, r4, 10);          //background colour 5, mid-scanline
  a.branch("mainLoop");
  a.pool();

  //---- interrupt handler, entered from the BIOS in IRQ mode with r0-r3, r12 and lr already saved
  a.label("irqHandler");
  a.push(R4 | LR);
  a.set(r0, IO);
  a.set(r4, IO + 0x200);
  a.ldrh(r1, r4, 0x02);        //IF

  a.tst(r1, 0x0001);
  a.call("vblank", {cond: NE});
  if(raster) {
    a.tst(r1, 0x0002);
    a.call("hblank", {cond: NE});
  }

  a.strh(r1, r4, 0x02);        //acknowledge every flag that was raised
  a.pop(R4 | LR);
  a.bx(lr);
  a.pool();

  //---- vblank: scroll the background, slide the object table through OAM, re-arm the sound DMA
  a.label("vblank");
  a.push(LR);
  a.set(r2, IWRAM);
  a.ldr(r3, r2, 0);
  a.add(r3, r3, 1);
  a.str(r3, r2, 0);

  a.strh(r3, r0, 0x10);                              //BG0HOFS
  a.movr(r12, r3, {shift: LSR, amount: 1});
  a.strh(r12, r0, 0x12);                             //BG0VOFS

  //the joypad, painted straight into the low background colours. KEYINPUT is active low and ten
  //bits wide, so it fits a fifteen-bit colour whole and every button moves a different bit of it --
  //which is what lets the smoke test tell ten buttons apart by picture alone.
  a.set(r2, IO + 0x100);       //halfword offsets are eight bits, so 0x130 needs its own base
  a.ldrh(r12, r2, 0x30);
  a.set(r2, PRAM);
  a.strh(r12, r2, 2);
  a.strh(r12, r2, 4);
  a.strh(r12, r2, 6);
  a.strh(r12, r2, 8);

  if(dma && sprites) {
    //source slides one object entry per frame through the spare rows, so the whole table moves
    a.and(r12, r3, 0x1f);
    a.movr(r12, r12, {shift: LSL, amount: 3});
    a.set(r2, EWRAM + 0x400);
    a.addr(r2, r2, r12);
    a.str(r2, r0, 0xd4);                             //DMA3SAD
    a.set(r2, OAM);
    a.str(r2, r0, 0xd8);                             //DMA3DAD
    a.set(r2, 0x84000100);                           //enable, word, 256 words
    a.str(r2, r0, 0xdc);
  }

  if(fifo) {
    //a repeating FIFO transfer reloads its length but never its source, so left alone it walks off
    //the end of the sample buffer and the channel goes quiet after an eighth of a second. re-arming
    //it once a frame is what a game does, and it keeps the audio comparison measuring something.
    a.mov(r2, 0);
    a.str(r2, r0, 0xc4);                             //disable
    a.set(r2, EWRAM);
    a.str(r2, r0, 0xbc);
    a.set(r2, 0xb6400000);
    a.str(r2, r0, 0xc4);
  }

  a.pop(LR);
  a.bx(lr);
  a.pool();

  if(raster) {
    //---- hblank: rewrite the backdrop and the scroll from the line counter. this is the write a
    //whole-scanline renderer cannot see and a per-cycle one can, so it is what separates the two
    //pixel-accuracy configurations from each other.
    a.label("hblank");
    a.ldrh(r2, r0, 0x06);                            //VCOUNT
    a.movr(r3, r2, {shift: LSL, amount: 5});
    a.eorr(r3, r3, r2, {shift: LSL, amount: 10});
    a.orrr(r3, r3, r2);
    a.set(r12, PRAM);
    a.strh(r3, r12, 0);                              //backdrop
    a.andr(r3, r2, r2, {shift: LSR, amount: 2});
    a.strh(r3, r0, 0x10);                            //BG0HOFS, mid-frame
    a.bx(lr);
    a.pool();
  }

  //the save-type marker mia scans for, as a word-aligned run of bytes
  const identifier = saveIdentifiers[save];
  if(identifier === undefined) throw new Error(`unknown save type: ${save}`);
  const markers = [];
  if(identifier) markers.push(identifier);
  if(rtc) markers.push("SIIRTC_V001");
  for(const marker of markers) {
    for(let index = 0; index < marker.length; index += 4) {
      let word = 0;
      for(let byte = 0; byte < 4; byte++) {
        const code = index + byte < marker.length ? marker.charCodeAt(index + byte) : 0;
        word |= code << (byte * 8);
      }
      a.emit(word);
    }
    a.emit(0);
  }

  const code = a.assemble();
  //32 KiB, comfortably above mia's minimum and a size the cartridge's mirror logic is happy with
  const rom = new Uint8Array(Math.max(32 * 1024, (code.length + 3) & ~3));
  rom.set(code);
  writeHeader(rom, {gameCode: "ASTE"});
  return rom;
}
