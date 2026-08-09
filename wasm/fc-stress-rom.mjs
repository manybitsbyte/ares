//Builds an NROM image that exercises every path the web build's direct PPU/APU catch-up can affect.
//
//The CPU catches the PPU and APU up on register access, so the interesting hazards are the pushes
//that run the other way: the PPU raising NMI, the APU raising its frame-counter IRQ, and the DMC
//requesting a DMA that steals CPU cycles. This ROM drives all three at once -- rendering on with an
//NMI handler doing OAM DMA and mid-frame scroll writes, a sprite-zero split polled from the main
//loop, four APU channels, the frame counter in IRQ mode, and the DMC looping a sample at its
//fastest rate so a DMA request is nearly always outstanding.
//
//Exported rather than run: wasm/fc-sweep.mjs boots it.

//A minimal absolute/immediate/zero-page 6502 assembler; two passes over a flat op list.
class Assembler {
  constructor(origin) {
    this.origin = origin;
    this.ops = [];
    this.labels = new Map();
  }

  label(name) {
    this.labels.set(name, null);
    this.ops.push({label: name});
    return this;
  }

  //`operand` is a number, or a label name for branches and absolute addressing.
  emit(mnemonic, operand) {
    this.ops.push({mnemonic, operand});
    return this;
  }

  assemble(size) {
    //pass one: resolve label addresses
    let address = this.origin;
    for(const op of this.ops) {
      if(op.label !== undefined) { this.labels.set(op.label, address); continue; }
      op.width = this.encode(op, address, false).length;
      address += op.width;
    }

    //pass two: emit
    const bytes = [];
    address = this.origin;
    for(const op of this.ops) {
      if(op.label !== undefined) continue;
      const encoded = this.encode(op, address, true);
      bytes.push(...encoded);
      address += encoded.length;
    }
    if(bytes.length > size) throw new Error(`code overflows ${size} bytes: ${bytes.length}`);
    return bytes;
  }

  resolve(operand, resolveLabels) {
    if(typeof operand === "string") {
      if(!resolveLabels) return 0x8000;  //any two-byte placeholder; widths are label-independent
      const value = this.labels.get(operand);
      if(value === undefined || value === null) throw new Error(`undefined label ${operand}`);
      return value;
    }
    return operand;
  }

  encode(op, address, resolveLabels) {
    const {mnemonic} = op;
    if(IMPLIED[mnemonic]) return [IMPLIED[mnemonic]];

    if(BRANCH[mnemonic]) {
      const target = this.resolve(op.operand, resolveLabels);
      const offset = resolveLabels ? target - (address + 2) : 0;
      if(offset < -128 || offset > 127) throw new Error(`branch out of range: ${mnemonic}`);
      return [BRANCH[mnemonic], offset & 0xff];
    }

    const operand = op.operand;
    if(operand instanceof Immediate) return [IMMEDIATE[mnemonic], operand.value & 0xff];
    if(operand instanceof IndexedX) {
      const value = this.resolve(operand.value, resolveLabels);
      return [ABSOLUTE_X[mnemonic], value & 0xff, value >> 8];
    }
    const value = this.resolve(operand, resolveLabels);
    return [ABSOLUTE[mnemonic], value & 0xff, value >> 8];
  }
}

class Immediate { constructor(value) { this.value = value; } }
class IndexedX { constructor(value) { this.value = value; } }
const imm = value => new Immediate(value);
const absX = value => new IndexedX(value);

const IMPLIED = {
  sei: 0x78, cld: 0xd8, tax: 0xaa, txa: 0x8a, tay: 0xa8, tya: 0x98, txs: 0x9a,
  inx: 0xe8, iny: 0xc8, dex: 0xca, dey: 0x88, pha: 0x48, pla: 0x68, rti: 0x40,
  lsr: 0x4a, cli: 0x58, nop: 0xea,
};
const BRANCH = {bne: 0xd0, beq: 0xf0, bpl: 0x10, bmi: 0x30, bvc: 0x50, bvs: 0x70, bcc: 0x90, bcs: 0xb0};
const IMMEDIATE = {lda: 0xa9, ldx: 0xa2, ldy: 0xa0, cpx: 0xe0, cpy: 0xc0, cmp: 0xc9, and: 0x29, ora: 0x09, adc: 0x69};
const ABSOLUTE = {lda: 0xad, sta: 0x8d, ldx: 0xae, ldy: 0xac, bit: 0x2c, jmp: 0x4c, jsr: 0x20, inc: 0xee, cmp: 0xcd};
const ABSOLUTE_X = {sta: 0x9d, lda: 0xbd};

const SCROLL = 0x0010;

//`dmc` enables the looping DMC sample. It is the one APU feature that steals CPU cycles, so it is
//separable: with it off, the APU can only move the IRQ line, and any divergence is that alone.
export function buildStressRom({dmc = true} = {}) {
  const a = new Assembler(0xc000);

  a.label("reset")
   .emit("sei").emit("cld")
   .emit("lda", imm(0x40)).emit("sta", 0x4017)     //frame counter: 5-step, IRQ inhibited for now
   .emit("ldx", imm(0xff)).emit("txs")
   .emit("lda", imm(0x00)).emit("sta", 0x2000).emit("sta", 0x2001).emit("sta", 0x4010)

   .label("vblank1").emit("bit", 0x2002).emit("bpl", "vblank1")
   .label("vblank2").emit("bit", 0x2002).emit("bpl", "vblank2")

   //palette: $3f00..$3f1f
   .emit("lda", imm(0x3f)).emit("sta", 0x2006)
   .emit("lda", imm(0x00)).emit("sta", 0x2006)
   .emit("ldx", imm(0x00))
   .label("palLoop")
     .emit("txa").emit("ora", imm(0x01)).emit("and", imm(0x3f)).emit("sta", 0x2007)
     .emit("inx").emit("cpx", imm(0x20)).emit("bne", "palLoop")

   //nametable + attributes: 1024 bytes of varying tile indices
   .emit("lda", imm(0x20)).emit("sta", 0x2006)
   .emit("lda", imm(0x00)).emit("sta", 0x2006)
   .emit("ldy", imm(0x04))
   .label("ntOuter").emit("ldx", imm(0x00))
   .label("ntInner")
     .emit("txa").emit("sta", 0x2007).emit("inx").emit("bne", "ntInner")
     .emit("dey").emit("bne", "ntOuter")

   //OAM staging at $0200: sprite zero high on screen so the split lands mid-frame
   .emit("lda", imm(0x40)).emit("sta", 0x0200)
   .emit("lda", imm(0x01)).emit("sta", 0x0201)
   .emit("lda", imm(0x00)).emit("sta", 0x0202)
   .emit("lda", imm(0x40)).emit("sta", 0x0203)
   .emit("ldx", imm(0x04))
   .label("oamLoop")
     .emit("txa").emit("sta", absX(0x0200)).emit("inx")
     .emit("lda", imm(0x01)).emit("sta", absX(0x0200)).emit("inx")
     .emit("lda", imm(0x00)).emit("sta", absX(0x0200)).emit("inx")
     .emit("txa").emit("sta", absX(0x0200)).emit("inx")
     .emit("bne", "oamLoop")

   //square 1 and 2, triangle, noise
   .emit("lda", imm(0xbf)).emit("sta", 0x4000)
   .emit("lda", imm(0x08)).emit("sta", 0x4001)
   .emit("lda", imm(0x40)).emit("sta", 0x4002)
   .emit("lda", imm(0x08)).emit("sta", 0x4003)
   .emit("lda", imm(0xbd)).emit("sta", 0x4004)
   .emit("lda", imm(0x08)).emit("sta", 0x4005)
   .emit("lda", imm(0x60)).emit("sta", 0x4006)
   .emit("lda", imm(0x08)).emit("sta", 0x4007)
   .emit("lda", imm(0x81)).emit("sta", 0x4008)
   .emit("lda", imm(0x30)).emit("sta", 0x400a)
   .emit("lda", imm(0x08)).emit("sta", 0x400b)
   .emit("lda", imm(0x3f)).emit("sta", 0x400c)
   .emit("lda", imm(0x04)).emit("sta", 0x400e)
   .emit("lda", imm(0x08)).emit("sta", 0x400f)

   //DMC: looping, fastest rate, sampling the PRG image itself
   .emit("lda", imm(0x40)).emit("sta", 0x4010)
   .emit("lda", imm(0x00)).emit("sta", 0x4012)
   .emit("lda", imm(0x10)).emit("sta", 0x4013)
   .emit("lda", imm(dmc ? 0x1f : 0x0f)).emit("sta", 0x4015)

   //frame counter into 4-step mode with the IRQ enabled
   .emit("lda", imm(0x00)).emit("sta", 0x4017)
   .emit("lda", imm(0x00)).emit("sta", SCROLL)
   .emit("cli")

   //rendering and NMI on
   .emit("lda", imm(0x1e)).emit("sta", 0x2001)
   .emit("lda", imm(0x80)).emit("sta", 0x2000)

   //main loop: poll sprite zero and change scroll at the hit
   .label("main")
     .label("waitClear").emit("bit", 0x2002).emit("bvs", "waitClear")
     .label("waitHit").emit("bit", 0x2002).emit("bvc", "waitHit")
     .emit("lda", SCROLL).emit("sta", 0x2005)
     .emit("lda", imm(0x00)).emit("sta", 0x2005)
     .emit("jmp", "main")

   //NMI: OAM DMA, scroll update, and a moving APU period
   .label("nmi")
     .emit("pha").emit("txa").emit("pha").emit("tya").emit("pha")
     .emit("lda", imm(0x00)).emit("sta", 0x2003)
     .emit("lda", imm(0x02)).emit("sta", 0x4014)
     .emit("inc", SCROLL)
     .emit("lda", SCROLL).emit("sta", 0x2005)
     .emit("lda", imm(0x00)).emit("sta", 0x2005)
     .emit("lda", imm(0x80)).emit("sta", 0x2000)
     .emit("lda", SCROLL).emit("and", imm(0x7f)).emit("ora", imm(0x20)).emit("sta", 0x4002)
     .emit("lda", SCROLL).emit("and", imm(0x0f)).emit("sta", 0x400e)
     .emit("pla").emit("tay").emit("pla").emit("tax").emit("pla").emit("rti")

   //IRQ: acknowledge the frame counter
   .label("irq")
     .emit("pha").emit("lda", 0x4015).emit("pla").emit("rti");

  const code = a.assemble(0x3ff0);

  const prg = new Uint8Array(16 * 1024).fill(0xea);
  prg.set(code, 0);
  const vector = (offset, label) => {
    const address = a.labels.get(label);
    prg[offset + 0] = address & 0xff;
    prg[offset + 1] = address >> 8;
  };
  vector(0x3ffa, "nmi");
  vector(0x3ffc, "reset");
  vector(0x3ffe, "irq");

  //CHR: tile n gets a pattern derived from n so the rendered image is busy rather than flat
  const chr = new Uint8Array(8 * 1024);
  for(let tile = 0; tile < 512; tile++) {
    for(let row = 0; row < 8; row++) {
      chr[tile * 16 + row] = (tile * 7 + row * 13) & 0xff;
      chr[tile * 16 + 8 + row] = (tile * 3 + row * 5) & 0xff;
    }
  }

  const rom = new Uint8Array(16 + prg.length + chr.length);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 0x01, 0x01, 0x00, 0x00], 0);
  rom.set(prg, 16);
  rom.set(chr, 16 + prg.length);
  return rom;
}
