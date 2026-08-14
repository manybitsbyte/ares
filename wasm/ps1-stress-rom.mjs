//Builds a PlayStation workload that needs no file anybody owns: a PS-X EXE the core side-loads into
//RAM, and the stub BIOS that gets it there.
//
//buildStubBios() emits the 512 KiB image ares_ps1_set_bios wants. A real console's BIOS brings the
//hardware up, draws the logo and hands control to whatever the shell found; ares needs none of that
//to run an executable, because CPU::instructionHook() watches for a taken branch to 0x8003'0000 --
//the address the retail shell enters a game at -- and, if a PS-X EXE is in the tray, copies it into
//RAM and redirects the branch to the executable's own entry point (ares/ps1/cpu/cpu.cpp:134-155).
//Three instructions at the reset vector are therefore the whole BIOS this harness needs: load that
//address into a register, jump to it, and let the hook take over in the delay slot. No Sony image is
//used, referenced or required, and none ever will be.
//
//buildStressRom() emits the executable, hand-assembled MIPS R3000A. It exercises the paths the web
//build's scheduling can reach: the GPU renderer, which the web build runs inline on the GPU's own
//cothread rather than on the render thread ares normally starts (ares/ps1/accuracy.hpp); the SPU's
//per-sample voice mixer; the interrupt controller, polled rather than vectored; and root counter 1,
//read once a frame. Every frame paints a background whose colour steps with the frame counter and
//four gouraud quads whose corners move with it, so no two consecutive frames hash alike, and four
//SPU voices run in noise mode so the stream is never silent.
//
//Noise mode is what keeps the sound simple: a noise voice ignores the decoded ADPCM waveform and
//takes the noise generator's level instead (ares/ps1/spu/voice.cpp:71-75), so no waveform has to be
//built. It does not remove the sample upload, though, and the one block this program does write is
//what makes the audio the same on every power cycle -- see the comment on it below.
//
//Exported rather than run: wasm/ps1-smoke.mjs, wasm/state-smoke.mjs and wasm/save-smoke.mjs boot it.
//wasm/ps1-sweep.mjs does not -- fidelity is measured on real discs, because the disc drive, the CD
//audio path and the MDEC are the parts of this console a synthetic executable cannot reach.

//registers, by the names the MIPS ABI gives them
const zero = 0, t0 = 8, t1 = 9, t2 = 10, t3 = 11;
const s0 = 16, s1 = 17, s2 = 18, s3 = 19, s4 = 20, s5 = 21, s6 = 22, s7 = 23;

//every I/O register below is reached as an offset from 0xbf80'0000, which is the KSEG1 (uncached)
//window onto physical 0x1f80'0000. The offsets are all under 0x8000, so each one fits the signed
//16-bit displacement of a single load or store.
const GP0     = 0x1810;  //GPU command and vertex port
const GP1     = 0x1814;  //GPU control port; reads back GPUSTAT
const I_STAT  = 0x1070;
const T1_VALUE = 0x1110, T1_MODE = 0x1114;
const SPU_VOICE = 0x1c00;  //+0x10 per voice: volume L, volume R, rate, start, ADSR lo, ADSR hi
const SPU_MVOL_L = 0x1d80, SPU_MVOL_R = 0x1d82;
const SPU_KON = 0x1d88, SPU_NON = 0x1d94;
const SPU_TRANSFER_ADDRESS = 0x1da6, SPU_TRANSFER_FIFO = 0x1da8;
const SPU_CONTROL = 0x1daa, SPU_TRANSFER = 0x1dac;
//where the one ADPCM block this program uploads lives, in the 8-byte units the transfer address and
//a voice's start address are both counted in
const blockAddress = 0x0200;

class Asm {
  constructor(origin) {
    this.origin = origin;
    this.words = [];
    this.labels = new Map();
  }

  get pc() { return this.origin + this.words.length * 4; }

  label(name) { this.labels.set(name, this.pc); return this; }

  word(...values) { for(const value of values) this.words.push(value >>> 0); return this; }

  bytes() {
    const image = new Uint8Array(this.words.length * 4);
    const view = new DataView(image.buffer);
    this.words.forEach((word, index) => view.setUint32(index * 4, word, true));
    return image;
  }

  //backward-only branches: the target label must already be defined. Every branch and jump below is
  //followed by an explicit nop, because the delay slot instruction runs whether the branch is taken
  //or not and nothing here has useful work to put in one.
  displacement(name) {
    const target = this.labels.get(name);
    if(target === undefined) throw new Error(`undefined label ${name}`);
    const words = (target - (this.pc + 4)) / 4;
    if(words < -0x8000 || words > 0x7fff) throw new Error(`branch out of range: ${name}`);
    return words & 0xffff;
  }

  lui(rt, imm)         { return this.word(0x3c000000 | rt << 16 | imm & 0xffff); }
  ori(rt, rs, imm)     { return this.word(0x34000000 | rs << 21 | rt << 16 | imm & 0xffff); }
  xori(rt, rs, imm)    { return this.word(0x38000000 | rs << 21 | rt << 16 | imm & 0xffff); }
  andi(rt, rs, imm)    { return this.word(0x30000000 | rs << 21 | rt << 16 | imm & 0xffff); }
  addiu(rt, rs, imm)   { return this.word(0x24000000 | rs << 21 | rt << 16 | imm & 0xffff); }
  sltiu(rt, rs, imm)   { return this.word(0x2c000000 | rs << 21 | rt << 16 | imm & 0xffff); }
  addu(rd, rs, rt)     { return this.word(rs << 21 | rt << 16 | rd << 11 | 0x21); }
  or(rd, rs, rt)       { return this.word(rs << 21 | rt << 16 | rd << 11 | 0x25); }
  xor(rd, rs, rt)      { return this.word(rs << 21 | rt << 16 | rd << 11 | 0x26); }
  sll(rd, rt, sa)      { return this.word(rt << 16 | rd << 11 | sa << 6); }
  lw(rt, offset, base) { return this.word(0x8c000000 | base << 21 | rt << 16 | offset & 0xffff); }
  sw(rt, offset, base) { return this.word(0xac000000 | base << 21 | rt << 16 | offset & 0xffff); }
  sh(rt, offset, base) { return this.word(0xa4000000 | base << 21 | rt << 16 | offset & 0xffff); }
  nop()                { return this.word(0); }
  jr(rs)               { return this.word(rs << 21 | 0x08); }
  beq(rs, rt, name)    { return this.word(0x10000000 | rs << 21 | rt << 16 | this.displacement(name)); }
  bne(rs, rt, name)    { return this.word(0x14000000 | rs << 21 | rt << 16 | this.displacement(name)); }
  //J keeps the top four bits of the delay slot's own address, so this only reaches labels in the
  //same 256 MiB region -- which every line of this program is, all of it inside one RAM image
  j(name) {
    const target = this.labels.get(name);
    if(target === undefined) throw new Error(`undefined label ${name}`);
    return this.word(0x08000000 | target >>> 2 & 0x03ffffff);
  }

  //a 32-bit constant costs one instruction when half of it is zero and two otherwise
  li(rt, value) {
    value >>>= 0;
    if(value < 0x10000) return this.ori(rt, zero, value);
    this.lui(rt, value >>> 16);
    if(value & 0xffff) this.ori(rt, rt, value & 0xffff);
    return this;
  }
}

//the executable is loaded here and entered here; the low 21 bits are what the core masks the
//destination down to, so this is 64 KiB into the console's 2 MiB of RAM
const entry = 0x8001_0000;
//the address the retail shell branches to, which is the only thing the stub BIOS has to reach
const shellEntry = 0x8003_0000;
//a PS-X EXE's payload begins one 2048-byte sector in; the header occupies the whole of the first
const headerSize = 2048;

function buildProgram() {
  const a = new Asm(entry);

  a.lui(s0, 0xbf80);                                  //every register write below is an offset from here

  //--- GPU ---------------------------------------------------------------------------------------
  //a single framebuffer: the display area and the drawing area are the same 320x240 corner of VRAM,
  //which is why the draw mode below has to permit drawing to the displayed area at all.
  a.sw(zero, GP1, s0);                                //GP1(00) reset
  a.li(t0, 0x08000001).sw(t0, GP1, s0);               //GP1(08) 320x240, NTSC, 15bpp
  a.li(t0, 0x05000000).sw(t0, GP1, s0);               //GP1(05) display area at VRAM (0,0)
  a.li(t0, 0x06c60260).sw(t0, GP1, s0);               //GP1(06) horizontal range, 320 pixels wide
  a.li(t0, 0x07040010).sw(t0, GP1, s0);               //GP1(07) vertical range, 240 lines
  a.li(t0, 0x03000000).sw(t0, GP1, s0);               //GP1(03) display enabled
  a.li(t0, 0xe1000400).sw(t0, GP0, s0);               //GP0(e1) draw mode: display area writable
  a.li(t0, 0xe3000000).sw(t0, GP0, s0);               //GP0(e3) draw area top-left (0,0)
  a.li(t0, 0xe403bd3f).sw(t0, GP0, s0);               //GP0(e4) draw area bottom-right (319,239)
  a.li(t0, 0xe5000000).sw(t0, GP0, s0);               //GP0(e5) draw offset (0,0)
  a.li(t0, 0xe6000000).sw(t0, GP0, s0);               //GP0(e6) mask bits off

  //--- SPU ---------------------------------------------------------------------------------------
  //configured with the chip disabled and switched on last, so no voice is ever keyed against a
  //half-written register set
  a.sh(zero, SPU_CONTROL, s0);                        //transfer mode 0, which also flushes the FIFO
  a.li(t0, 0x0004).sh(t0, SPU_TRANSFER, s0);          //sound RAM transfer control, the documented value

  //one 16-byte ADPCM block, written into sound RAM through the transfer FIFO, and the reason the
  //audio this program makes is the same on every power cycle. A noise voice takes its level from
  //the noise generator and never decodes a sample, but it still walks blocks for their loop flags
  //(ares/ps1/spu/voice.cpp:13-19,58-68) -- and sound RAM is randomised at power like main RAM is
  //(ares/ps1/spu/spu.cpp:107), so a voice pointed at unwritten RAM walks into whatever flags the
  //entropy drew and either loops somewhere arbitrary or switches itself off. This block's header
  //sets loopStart, loopRepeat and loopEnd at once (bits 10, 9 and 8): the first read makes the
  //block its own repeat address, the same read's loopEnd sends it straight back there, and the
  //voice loops on these sixteen bytes forever without ever reading a byte it did not write.
  a.li(t0, blockAddress).sh(t0, SPU_TRANSFER_ADDRESS, s0);
  a.li(t0, 0x0700).sh(t0, SPU_TRANSFER_FIFO, s0);
  for(let half = 1; half < 8; half++) a.sh(zero, SPU_TRANSFER_FIFO, s0);  //the 28 unread nibbles
  a.li(t0, 0x0010).sh(t0, SPU_CONTROL, s0);           //transfer mode 1: drain the FIFO into sound RAM
  a.sh(zero, SPU_CONTROL, s0);                        //and back to mode 0

  a.li(t0, 0x3fff).sh(t0, SPU_MVOL_L, s0).sh(t0, SPU_MVOL_R, s0);
  for(let voice = 0; voice < 4; voice++) {
    const at = SPU_VOICE + voice * 0x10;
    a.li(t0, 0x3fff).sh(t0, at + 0, s0).sh(t0, at + 2, s0);
    //a different pitch per voice, so the four LFSR taps land on different samples
    a.li(t0, 0x0800 + voice * 0x180).sh(t0, at + 4, s0);
    //start address: the block uploaded above, which all four voices share and none ever leaves
    a.li(t0, blockAddress).sh(t0, at + 6, s0);
    //ADSR: instant linear attack, sustain level 15 so the decay target is reached at once, and a
    //sustain that increases at the slowest rate there is -- which is to say it holds
    a.li(t0, 0x000f).sh(t0, at + 8, s0);
    a.li(t0, 0x1fc0).sh(t0, at + 10, s0);
  }
  a.li(t0, 0x0000000f).sw(t0, SPU_NON, s0);           //voices 0-3 in noise mode
  a.li(t0, 0x0000e000).sh(t0, SPU_CONTROL, s0);       //enable, unmute, noise shift 8
  a.li(t0, 0x0000000f).sw(t0, SPU_KON, s0);           //key on

  //root counter 1 counts hblanks and is free-running; the main loop reads it every frame, which is
  //the one place this program observes a chip the CPU is not driving
  a.li(t0, 0x0100).sw(t0, T1_MODE, s0);

  a.ori(s1, zero, 0);                                 //frame counter

  a.label("frame");
  //--- wait for vblank ---------------------------------------------------------------------------
  //polled rather than vectored: I_MASK is left at zero, so the CPU never takes the interrupt and
  //this loop is what paces the program against the GPU
  a.label("vblank");
  a.lw(t0, I_STAT, s0);
  //the load delay slot, and it is not optional here. An R3000A load lands one instruction late, and
  //ares models that exactly: a load parks itself in delay.load[1], and an instruction in the slot
  //that writes the same register cancels it outright (ares/ps1/cpu/delay-slots.cpp:8-22,31-37). Fold
  //the andi up into this slot and the poll reads whatever t0 held before the load, forever.
  a.nop();
  a.andi(t0, t0, 0x0001);
  a.beq(t0, zero, "vblank").nop();
  //I_STAT acknowledges a source by having a zero written into its bit, so every other bit stays set
  a.addiu(t0, zero, -2).sw(t0, I_STAT, s0);

  a.addiu(s1, s1, 1);
  a.lw(t0, T1_VALUE, s0);                             //root counter 1
  a.lw(t0, GP1, s0);                                  //GPUSTAT
  a.nop();

  //--- background --------------------------------------------------------------------------------
  //GP0(02) fills VRAM directly, ignoring the draw area and the mask bits, which is what makes it the
  //cheapest way to guarantee every pixel of the frame is rewritten before the quads land on it
  a.andi(t0, s1, 0x00ff);
  a.lui(t1, 0x0200);
  a.or(t0, t0, t1).sw(t0, GP0, s0);
  a.sw(zero, GP0, s0);                                //fill origin (0,0)
  a.li(t0, 0x00f00140).sw(t0, GP0, s0);               //fill size 320x240

  //--- four gouraud quads ------------------------------------------------------------------------
  a.ori(s2, zero, 0);
  a.label("quad");
  a.sll(t0, s2, 6);                                   //quad index * 64
  a.addu(t1, s1, t0);
  a.andi(t1, t1, 0x007f);
  a.addu(t1, t1, t0);                                 //x, sweeping 128 pixels inside its own column
  a.sll(t0, s2, 5);                                   //quad index * 32
  a.addu(t2, s1, t0);
  a.andi(t2, t2, 0x003f);
  a.addu(t2, t2, t0);                                 //y, sweeping 64 lines inside its own band
  a.sll(t3, t2, 16);
  a.or(s4, t3, t1);                                   //vertex 0, packed y:x
  a.addiu(s5, s4, 48);                                //vertex 1: 48 pixels right
  a.lui(t3, 0x0028);
  a.addu(s6, s4, t3);                                 //vertex 2: 40 lines down
  a.addiu(s7, s6, 48);                                //vertex 3
  //one grey per quad per frame, then a corner each of red, green and blue inverted out of it, so
  //the renderer has a real gradient to interpolate rather than a flat fill
  a.addu(t0, s1, s2);
  a.andi(t0, t0, 0x00ff);
  a.sll(t1, t0, 8);
  a.or(t0, t0, t1);
  a.sll(t1, t0, 8);
  a.or(s3, t0, t1);
  a.lui(t0, 0x3800);
  a.or(t0, t0, s3).sw(t0, GP0, s0).sw(s4, GP0, s0);
  a.xori(t0, s3, 0x00ff).sw(t0, GP0, s0).sw(s5, GP0, s0);
  a.xori(t0, s3, 0xff00).sw(t0, GP0, s0).sw(s6, GP0, s0);
  a.lui(t1, 0x00ff);
  a.xor(t0, s3, t1).sw(t0, GP0, s0).sw(s7, GP0, s0);
  a.addiu(s2, s2, 1);
  a.sltiu(t0, s2, 4);
  a.bne(t0, zero, "quad").nop();

  a.j("frame").nop();
  return a;
}

export function buildStressRom() {
  const program = buildProgram().bytes();
  const image = new Uint8Array(headerSize + program.length);
  const view = new DataView(image.buffer);
  image.set(new TextEncoder().encode("PS-X EXE"), 0);
  view.setUint32(0x10, entry, true);            //initial pc
  view.setUint32(0x14, 0, true);                //initial gp
  view.setUint32(0x18, entry, true);            //destination in RAM
  view.setUint32(0x1c, program.length, true);   //payload size
  view.setUint32(0x30, 0x801f_ff00, true);      //initial sp, which ares does not read but a header carries
  image.set(program, headerSize);
  return image;
}

export function buildStubBios() {
  const bios = new Uint8Array(512 * 1024);
  //the reset vector, 0xbfc0'0000. A jump register is the only branch that can reach 0x8003'0000
  //from here: J keeps the top four bits of the program counter, which are 0xb in the BIOS window.
  const a = new Asm(0xbfc0_0000);
  a.lui(t0, shellEntry >>> 16);
  a.jr(t0).nop();
  bios.set(a.bytes(), 0);
  return bios;
}
