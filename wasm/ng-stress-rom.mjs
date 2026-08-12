//Builds a Neo Geo AES cartridge that exercises every path the web build's synchronous scheduling
//can affect: the fix layer and five sprites (one animated, one flipped, one shrunk, one chained
//sticky) rendered every line from the C and S ROMs, the LSPC timer interrupt reloading on vblank
//and on zero, a vblank handler rewriting PRAM and moving a sprite through the VRAM port, a resident
//Z80 program taking NMIs from the 68000's command port and IRQs from the YM2610's timer A, and the
//YM2610 running FM, SSG, ADPCM-A and ADPCM-B at once so its sample loop reads both voice ROMs.
//
//It is emitted as a MAME-format zip because that is the shape every real cartridge arrives in:
//mia keys the romset on the zip's basename, so the archive must be named after a database entry and
//its members must carry that entry's file names and sizes. `looptris` is the smallest entry in
//"Neo Geo.bml" -- six files, 2.25 MiB -- and its CRCs are not checked, only its names and sizes.
//
//buildStubBios() emits the AES BIOS the harness boots with: the real console's BIOS seats the
//cartridge and jumps into it, but ares only requires the vector table, so 128 KiB holding the reset
//and autovector entries is enough and no SNK image is needed. Vectors below 0x80 are fetched
//through the NEO-E0 swap while REG_SWPROM is untouched, so they come from this file; everything
//else, handlers included, lives in the cartridge's P ROM.
//
//Exported rather than run: wasm/ng-sweep.mjs and wasm/ng-smoke.mjs boot it.

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

  l(value) { return this.w(value >>> 16, value & 0xffff); }

  //backward-only branches: the target label must already be defined
  disp(name, next) {
    const target = this.labels.get(name);
    if(target === undefined) throw new Error(`undefined label ${name}`);
    const disp = target - next;
    if(disp < -0x8000 || disp > 0x7fff) throw new Error(`branch out of range: ${name}`);
    return disp & 0xffff;
  }

  dbra(reg, name)  { this.w(0x51c8 | reg); return this.w(this.disp(name, this.pc)); }
  bra_w(name)      { this.w(0x6000); return this.w(this.disp(name, this.pc)); }
}

const VRAMADDR = 0x003c0000;
const VRAMRW   = 0x003c0002;
const VRAMMOD  = 0x003c0004;
const LSPCMODE = 0x003c0006;
const TIMERHI  = 0x003c0008;
const TIMERLO  = 0x003c000a;
const IRQACK   = 0x003c000c;
const SOUND    = 0x00320000;

//move.w #imm,(addr).l
const movewi = (a, imm, addr) => a.w(0x33fc, imm).l(addr);
//move.b #imm,(addr).l
const movebi = (a, imm, addr) => a.w(0x13fc, imm & 0xff).l(addr);
//move.w (addr).l,d0
const movewd0 = (a, addr) => a.w(0x3039).l(addr);
//move.w d0,(addr).l
const moved0w = (a, addr) => a.w(0x33c0).l(addr);

function build68k({noTimer = false, noNmi = false} = {}) {
  //vblank handler (level 1): counters, a Z80 command (which is an NMI), a palette write, a sprite
  //move through the VRAM port, and re-arming every interrupt
  const vblank = new Asm(0x400);
  vblank.w(0x2f00);                            //move.l d0,-(sp)
  vblank.w(0x52b9).l(0x00100000);              //addq.l #1,(frame counter)
  movewd0(vblank, 0x00100002);                 //move.w (counter low),d0
  if(!noNmi) vblank.w(0x13c0).l(SOUND);        //move.b d0,REG_SOUND: Z80 NMI + command byte
  moved0w(vblank, 0x00400022);                 //pram palette 1 color 1
  movewi(vblank, 0x8401, VRAMADDR);            //SCB4 sprite 1: x position
  vblank.w(0x0240, 0x00ff);                    //andi.w #0xff,d0
  vblank.w(0x0640, 0x0040);                    //addi.w #0x40,d0
  vblank.w(0xef48);                            //lsl.w #7,d0
  moved0w(vblank, VRAMRW);
  movewi(vblank, 0x0007, IRQACK);              //re-arm vblank, timer and power
  vblank.w(0x201f);                            //move.l (sp)+,d0
  vblank.w(0x4e73);                            //rte

  //timer handler (level 2): rotate the backdrop color, re-arm the timer alone
  const timer = new Asm(0x440);
  timer.w(0x2f00);                             //move.l d0,-(sp)
  timer.w(0x52b9).l(0x00100008);               //addq.l #1,(timer counter)
  movewd0(timer, 0x0010000a);
  timer.w(0x0640, 0x0421);                     //addi.w #0x421,d0
  moved0w(timer, 0x0010000a);
  moved0w(timer, 0x00401ffe);                  //pram 0xfff: the backdrop
  //REG_IRQACK sets all three acknowledge flags from the data bits, so every handler re-arms every
  //interrupt: a partial write here would silently disarm the others
  movewi(timer, 0x0007, IRQACK);
  timer.w(0x201f);
  timer.w(0x4e73);                             //rte

  //power handler (level 3): raised once by LSPC::power, taken when SR drops below 3
  const power = new Asm(0x4c0);
  power.w(0x52b9).l(0x0010000c);               //addq.l #1,(power counter)
  movewi(power, 0x0007, IRQACK);
  power.w(0x4e73);                             //rte

  //init + main loop
  const a = new Asm(0x500);
  a.w(0x46fc, 0x2700);                         //move.w #0x2700,sr
  for(const address of [0x00100000, 0x00100004, 0x00100008, 0x0010000c]) {
    a.w(0x42b9).l(address);                    //clr.l (counters)
  }

  movewi(a, 0x0001, VRAMMOD);                  //auto-increment 1

  //fix map: 40 columns x 32 rows at vram 0x7000, tiles and palettes swept deterministically
  movewi(a, 0x7000, VRAMADDR);
  a.w(0x303c, 0x1101);                         //move.w #0x1101,d0
  a.w(0x3a3c, 1279);                           //move.w #1279,d5
  a.label("fix");
  moved0w(a, VRAMRW);
  a.w(0x0640, 0x0011);                         //addi.w #0x11,d0
  a.dbra(5, "fix");

  //sprites 0-3 independent, sprite 4 sticky-chained to sprite 3. sprite 0 animates from the LSPC
  //animation counter, sprite 2 flips, sprite 3 shrinks through the vscale/hscale tables.
  const sh = 6;
  for(let sprite = 0; sprite < 5; sprite++) {
    movewi(a, sprite << 6, VRAMADDR);          //SCB1: the tilemap, auto-incrementing
    for(let tile = 0; tile < sh; tile++) {
      const animate = sprite === 0 ? 1 : 0;
      const hflip   = sprite === 2 ? 1 : 0;
      const vflip   = sprite === 2 ? 2 : 0;
      movewi(a, (sprite * 16 + tile * 2) & 0xffff, VRAMRW);
      movewi(a, (sprite + 1) << 8 | animate << 2 | vflip | hflip, VRAMRW);
    }
    const shrink = sprite === 3 ? 0x077f : 0x0fff;
    const sticky = sprite === 4;
    const top = 40 + 44 * sprite;
    movewi(a, 0x8000 | sprite, VRAMADDR);      //SCB2: shrink
    movewi(a, shrink, VRAMRW);
    movewi(a, 0x8200 | sprite, VRAMADDR);      //SCB3: y, sticky, height
    movewi(a, sticky ? 0x0040 | sh : (512 - top) << 7 | sh, VRAMRW);
    movewi(a, 0x8400 | sprite, VRAMADDR);      //SCB4: x
    movewi(a, (40 + 60 * sprite) << 7, VRAMRW);
  }

  //palette ram bank 0: 256 ascending colors
  a.w(0x41f9).l(0x00400000);                   //lea 0x400000,a0
  a.w(0x303c, 0x0f21);                         //move.w #0x0f21,d0
  a.w(0x3a3c, 255);                            //move.w #255,d5
  a.label("pram");
  a.w(0x30c0);                                 //move.w d0,(a0)+
  a.w(0x0640, 0x0357);                         //addi.w #0x357,d0
  a.dbra(5, "pram");
  movewi(a, 0x5a5a, 0x00401ffe);               //the backdrop, until the timer handler rotates it

  //LSPC timer: reload 0x6000 lspc clocks (~244 Hz), reload on vblank and on zero, irq enabled;
  //animation speed 2 so sprite 0's animate bits change visibly
  movewi(a, 0x0000, TIMERHI);
  movewi(a, 0x6000, TIMERLO);
  movewi(a, noTimer ? 0x0200 : 0x02d0, LSPCMODE);
  movewi(a, 0x0007, IRQACK);                   //arm everything

  if(!noNmi) movebi(a, 0x01, SOUND);           //first Z80 command
  a.w(0x46fc, 0x2000);                         //move.w #0x2000,sr: interrupts on

  //main loop: poll the LSPC and I/O registers, animate one fix cell, read VRAM back
  a.label("main");
  movewd0(a, LSPCMODE);                        //vcounter + animation frame
  movewd0(a, 0x00300000);                      //P1CNT + DIPSW
  movewd0(a, SOUND);                           //Z80 reply + STATUS_A
  movewd0(a, 0x00380000);                      //STATUS_B
  movewi(a, 0x7010, VRAMADDR);
  movewd0(a, 0x00100002);
  moved0w(a, VRAMRW);
  movewi(a, 0x7010, VRAMADDR);
  movewd0(a, VRAMADDR);                        //REG_VRAMADDR reads vram back
  movewd0(a, 0x0010000a);
  moved0w(a, 0x00400042);                      //pram palette 2 color 1
  a.bra_w("main");

  return {vblank, timer, power, main: a};
}

function buildZ80({noAdpcm = false} = {}) {
  const rom = new Uint8Array(131072);

  //reset: stack into the 2 KiB work ram, then the setup program
  rom.set([
    0xf3,             //di
    0xed, 0x56,       //im 1
    0x31, 0xc0, 0xff, //ld sp,0xffc0
    0xc3, 0x00, 0x01, //jp 0x0100
  ], 0x0000);

  //im1 handler: the YM2610's timer A. count it, read the status flags, then clear them at the chip
  //or the level-triggered line interrupts every following instruction.
  rom.set([
    0xf5,             //push af
    0x21, 0x10, 0xf9, //ld hl,0xf910
    0x34,             //inc (hl)
    0xdb, 0x04,       //in a,(4): status 0
    0x32, 0x11, 0xf9, //ld (0xf911),a
    0x3e, 0x27,       //ld a,0x27
    0xd3, 0x04,       //out (4),a
    0x3e, 0x3f,       //ld a,0x3f: load, enable and reset both timers
    0xd3, 0x05,       //out (5),a
    0xf1,             //pop af
    0xfb,             //ei
    0xc9,             //ret
  ], 0x0038);

  //nmi handler: the 68000's command port. reading port 0 clears the pending NMI.
  rom.set([
    0xf5,             //push af
    0xdb, 0x00,       //in a,(0): the command
    0x32, 0x00, 0xf9, //ld (0xf900),a
    0xc6, 0x01,       //add a,1
    0xd3, 0x0c,       //out (0x0c),a: the reply
    0xf1,             //pop af
    0xed, 0x45,       //retn
  ], 0x0066);

  //the YM2610 register writes, table-driven: port, value pairs
  const writes = [];
  const fm = (register, value) => writes.push([4, register], [5, value]);
  const pcma = (register, value) => writes.push([6, register], [7, value]);

  //SSG: two tones and a third with noise mixed in
  fm(0x00, 0x5c); fm(0x01, 0x01);              //channel A period
  fm(0x02, 0x8f); fm(0x03, 0x00);              //channel B period
  fm(0x04, 0x44); fm(0x05, 0x01);              //channel C period
  fm(0x06, 0x10);                              //noise period
  fm(0x07, 0x18);                              //mixer: tones A B C, noise on C
  fm(0x08, 0x0d); fm(0x09, 0x0b); fm(0x0a, 0x09);

  //FM: one patch on every valid channel of part 1, algorithm 7 so all operators carry
  for(const channel of [1, 2]) {
    for(const op of [0, 4, 8, 12]) {
      fm(0x30 + op + channel, 0x01);           //DT/MUL
      fm(0x40 + op + channel, op === 12 ? 0x00 : 0x18);  //TL
      fm(0x50 + op + channel, 0x1f);           //AR
      fm(0x60 + op + channel, 0x00);
      fm(0x70 + op + channel, 0x00);
      fm(0x80 + op + channel, 0x00);
      fm(0x90 + op + channel, 0x00);
    }
    fm(0xb0 + channel, 0x07);                  //feedback/algorithm
    fm(0xb4 + channel, 0xc0);                  //both speakers
    fm(0xa4 + channel, 0x22 + channel);        //block/fnum high, then low
    fm(0xa0 + channel, 0x69);
  }
  fm(0x28, 0xf1);                              //key on channel 1
  fm(0x28, 0xf2);                              //key on channel 2

  //ADPCM-B streams from the voice ROM through readPCMB
  if(!noAdpcm) {
  fm(0x11, 0xc0);                              //both speakers
  fm(0x12, 0x00); fm(0x13, 0x00);              //start
  fm(0x14, 0xff); fm(0x15, 0x00);              //end
  fm(0x19, 0x50); fm(0x1a, 0x40);              //delta-n
  fm(0x1b, 0xc0);                              //volume
  fm(0x10, 0x90);                              //start, repeat

  //ADPCM-A channel 0 streams from the voice ROM through readPCMA
  pcma(0x01, 0x3f);                            //master volume
  pcma(0x08, 0xdf);                            //both speakers, full level
  pcma(0x10, 0x00); pcma(0x18, 0x00);          //start address
  pcma(0x20, 0xff); pcma(0x28, 0x03);          //end address
  pcma(0x00, 0x01);                            //key on
  }

  //timer A at its slowest, ~108 Hz: the IRQ source the im1 handler answers
  fm(0x24, 0x00); fm(0x25, 0x00);
  fm(0x27, 0x3f);

  const table = 0x0200;
  rom.set(writes.flat(), table);

  //main program at 0x100: enable NMIs, play the table, then poll status and sweep an SSG volume
  rom.set([
    0xaf,             //xor a
    0xd3, 0x08,       //out (8),a: nmi enable
    0x21, table & 0xff, table >> 8,  //ld hl,table
    0x06, writes.length,             //ld b,count
    //writeLoop (0x108):
    0x4e,             //ld c,(hl)
    0x23,             //inc hl
    0x7e,             //ld a,(hl)
    0x23,             //inc hl
    0xed, 0x79,       //out (c),a
    0x10, 0xf9,       //djnz writeLoop
    0xfb,             //ei
    //loop (0x111):
    0xdb, 0x04,       //in a,(4): status
    0x21, 0x20, 0xf9, //ld hl,0xf920
    0x34,             //inc (hl)
    0x7e,             //ld a,(hl)
    0xe6, 0x0f,       //and 0x0f
    0x4f,             //ld c,a
    0x3e, 0x08,       //ld a,8: SSG volume A register
    0xd3, 0x04,       //out (4),a
    0x79,             //ld a,c
    0xd3, 0x05,       //out (5),a
    0xc3, 0x11, 0x01, //jp loop
  ], 0x0100);
  if(writes.length > 255) throw new Error("YM2610 write table exceeds one djnz count");
  if(0x0200 + writes.flat().length > 0x1000) throw new Error("YM2610 write table overflows");

  return rom;
}

//deterministic tile data. color 0 is transparent per pixel, so the generators avoid long runs of
//zero nibbles rather than avoiding zero anywhere.
function buildStatic() {
  const rom = new Uint8Array(131072);
  for(let index = 0; index < rom.length; index++) {
    rom[index] = (index * 0x9d + (index >> 5) * 0x17 + 0x11) & 0xff;
  }
  return rom;
}

function buildCharacter() {
  const rom = new Uint8Array(1048576);
  for(let index = 0; index < rom.length; index++) {
    rom[index] = (index * 0x1f + (index >> 7) * 0x2b + 0x05) & 0xff;
  }
  return rom;
}

function buildVoice() {
  const rom = new Uint8Array(524288);
  for(let index = 0; index < rom.length; index++) {
    rom[index] = (index * 0x0d + 0x07) & 0xff;
  }
  return rom;
}

//the database entry stores 68000 words little-endian, as every MAME dump does, and mia's
//load16_word_swap turns them big-endian on the way into the pak
function swapWords(bytes) {
  const swapped = new Uint8Array(bytes.length);
  for(let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index + 0] = bytes[index + 1];
    swapped[index + 1] = bytes[index + 0];
  }
  return swapped;
}

const crcTable = new Uint32Array(256).map((_, n) => {
  for(let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for(const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

//a minimal zip: stored entries, no compression. mia's Decode::ZIP reads names and inflates or
//copies; sizes are what the database checks the members against.
function buildZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for(const [name, data] of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const record = new Uint8Array(46 + nameBytes.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, data.length, true);
    recordView.setUint32(24, data.length, true);
    recordView.setUint16(28, nameBytes.length, true);
    recordView.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    central.push(record);

    offset += local.length + data.length;
  }
  const centralSize = central.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const zip = new Uint8Array(offset + centralSize + 22);
  let position = 0;
  for(const chunk of [...chunks, ...central, end]) { zip.set(chunk, position); position += chunk.length; }
  return zip;
}

//the romset name is the database key the zip must be loaded under
export const romsetName = "looptris";

export function buildStressRom({noTimer = false, noNmi = false, noAdpcm = false} = {}) {
  const program = new Uint8Array(524288).fill(0xff);
  const {vblank, timer, power, main} = build68k({noTimer, noNmi});
  program.set(new Uint8Array(vblank.bytes), 0x400);
  program.set(new Uint8Array(timer.bytes), 0x440);
  program.set(new Uint8Array(power.bytes), 0x4c0);
  program.set(new Uint8Array(main.bytes), 0x500);
  if(vblank.bytes.length > 0x40) throw new Error("vblank handler overflows");
  if(timer.bytes.length > 0x40) throw new Error("timer handler overflows");
  if(power.bytes.length > 0x40) throw new Error("power handler overflows");
  if(main.bytes.length > 0xb00) throw new Error("init code overflows");

  const character = buildCharacter();
  const c1 = new Uint8Array(524288);
  const c2 = new Uint8Array(524288);
  for(let index = 0; index < 524288; index++) {
    c1[index] = character[index * 2 + 0];
    c2[index] = character[index * 2 + 1];
  }

  return buildZip([
    ["looptris.p1", swapWords(program)],
    ["looptris.s1", buildStatic()],
    ["looptris.m1", buildZ80({noAdpcm})],
    ["looptris.v1", buildVoice()],
    ["looptris.c1", c1],
    ["looptris.c2", c2],
  ]);
}

export function buildStubBios() {
  const bios = new Uint8Array(131072).fill(0xff);
  const view = new DataView(bios.buffer);
  view.setUint32(0x00, 0x0010f400);  //initial stack, in work ram
  view.setUint32(0x04, 0x00000500);  //initial pc, in the cartridge's P ROM
  view.setUint32(0x64, 0x00000400);  //level 1 autovector: vblank
  view.setUint32(0x68, 0x00000440);  //level 2 autovector: LSPC timer
  view.setUint32(0x6c, 0x000004c0);  //level 3 autovector: power
  //mia byte-swaps a raw BIOS image on load, as a real neo-epo.bin dump is stored
  return swapWords(bios);
}
