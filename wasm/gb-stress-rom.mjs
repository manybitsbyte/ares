//Builds a 32 KiB Game Boy cartridge image that keeps the ppu, all four sound channels and the
//cpu's view of LY moving, so a scheduling change surfaces as a picture or a waveform difference.
//
//The header is load-bearing rather than decoration. The boot ROM compares $0104-$0133 against its
//own copy of the Nintendo logo and verifies the $014D checksum, and it locks up on either
//mismatch. A locked-up boot ROM still yields a stable picture and a stable silence, so every
//comparison in the sweep would pass while measuring nothing at all -- which is exactly the failure
//a golden-hash harness cannot tell from success. gb-sweep.mjs asserts the four configurations
//produce four distinct video hashes for that reason.

//verbatim from the Pan Docs cartridge-header page; the boot ROM's own copy is what it is checked
//against, so this cannot be regenerated or approximated
const LOGO = Uint8Array.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

//Only the opcodes this ROM uses. Named after what they do rather than after a disassembler's
//syntax, because the caller below reads as a program and not as a byte table.
class Assembler {
  constructor(origin) {
    this.origin = origin;
    this.bytes = [];
    this.labels = new Map();
    this.fixups = [];
  }

  get pc() { return this.origin + this.bytes.length; }

  label(name) {
    if(this.labels.has(name)) throw new Error(`duplicate label: ${name}`);
    this.labels.set(name, this.pc);
    return this;
  }

  db(...values) { for(const value of values) this.bytes.push(value & 0xff); return this; }

  //16-bit absolute operand; a string is resolved once every label is known
  aw(value) {
    if(typeof value === "string") {
      this.fixups.push({at: this.bytes.length, name: value, relative: false});
      this.bytes.push(0, 0);
    } else {
      this.bytes.push(value & 0xff, (value >> 8) & 0xff);
    }
    return this;
  }

  //8-bit operand measured from the address after it
  ab(value) {
    if(typeof value === "string") {
      this.fixups.push({at: this.bytes.length, name: value, relative: true});
      this.bytes.push(0);
    } else {
      this.bytes.push(value & 0xff);
    }
    return this;
  }

  nop()        { return this.db(0x00); }
  di()         { return this.db(0xf3); }
  stop()       { return this.db(0x10, 0x00); }
  ldSP(nn)     { return this.db(0x31).aw(nn); }
  ldHL(nn)     { return this.db(0x21).aw(nn); }
  ldA(n)       { return this.db(0x3e, n & 0xff); }
  ldB(n)       { return this.db(0x06, n & 0xff); }
  ldAB()       { return this.db(0x78); }
  ldAC()       { return this.db(0x79); }
  ldAH()       { return this.db(0x7c); }
  ldAL()       { return this.db(0x7d); }
  ldBA()       { return this.db(0x47); }
  ldCA()       { return this.db(0x4f); }
  ldHLIA()     { return this.db(0x22); }              //ld (hl+),a
  ldhTo(n)     { return this.db(0xe0, n & 0xff); }    //ld ($ff00+n),a
  ldhFrom(n)   { return this.db(0xf0, n & 0xff); }    //ld a,($ff00+n)
  xorA()       { return this.db(0xaf); }
  addA(n)      { return this.db(0xc6, n & 0xff); }
  addAA()      { return this.db(0x87); }
  addAB()      { return this.db(0x80); }
  addAC()      { return this.db(0x81); }
  addAH()      { return this.db(0x84); }
  andN(n)      { return this.db(0xe6, n & 0xff); }
  orN(n)       { return this.db(0xf6, n & 0xff); }
  cp(n)        { return this.db(0xfe, n & 0xff); }
  incA()       { return this.db(0x3c); }
  incB()       { return this.db(0x04); }
  decB()       { return this.db(0x05); }
  jp(target)   { return this.db(0xc3).aw(target); }
  jr(target)   { return this.db(0x18).ab(target); }
  jrNZ(target) { return this.db(0x20).ab(target); }
  jrZ(target)  { return this.db(0x28).ab(target); }

  assemble() {
    for(const {at, name, relative} of this.fixups) {
      const target = this.labels.get(name);
      if(target === undefined) throw new Error(`undefined label: ${name}`);
      if(relative) {
        const delta = target - (this.origin + at + 1);
        if(delta < -128 || delta > 127) throw new Error(`jr out of range: ${name} (${delta})`);
        this.bytes[at] = delta & 0xff;
      } else {
        this.bytes[at] = target & 0xff;
        this.bytes[at + 1] = (target >> 8) & 0xff;
      }
    }
    return Uint8Array.from(this.bytes);
  }
}

//`color` sets the $0143 flag the Game Boy Color boots differently on. `doubleSpeed` arms KEY1 and
//executes STOP, which on a colour machine switches the cpu to 8 MiHz against an unchanged ppu.
//`lcdOff` drops and restores LCDC bit 7 twice per frame, which is the only path in the core that
//re-derives a thread at runtime.
export function buildStressRom({color = false, doubleSpeed = false, lcdOff = false, input = false} = {}) {
  const a = new Assembler(0x0150);

  a.di().ldSP(0xfffe)

   //lcd off, so vram and oam can be written without waiting for a blanking period
   .xorA().ldhTo(0x40)

   //tile data $8000..$8fff
   .ldHL(0x8000)
   .label("tiles")
     .ldAL().addAH().ldHLIA()
     .ldAH().cp(0x90).jrNZ("tiles")

   //tilemap $9800..$9bff
   .ldHL(0x9800)
   .label("map")
     .ldAL().addAH().ldHLIA()
     .ldAH().cp(0x9c).jrNZ("map")

   //oam $fe00..$fe9f: 40 sprites walked down and across the picture, so sprite evaluation has
   //work on most scanlines rather than on none
   .ldHL(0xfe00).ldB(0x00)
   .label("oam")
     .ldAB().addA(0x10).ldHLIA()   //y
     .ldAB().addA(0x08).ldHLIA()   //x
     .ldAB().ldHLIA()              //tile
     .xorA().ldHLIA()              //attributes
     .incB().ldAB().cp(0x28).jrNZ("oam")

   //palettes
   .ldA(0xe4).ldhTo(0x47).ldhTo(0x48)
   .ldA(0x1b).ldhTo(0x49);

  if(color) {
    //a colour machine ignores BGP/OBP0/OBP1 above and resolves every pixel through palette ram,
    //which powers up uniform. a scrolling background over a uniform palette is invisible: the
    //picture is byte-identical frame to frame however far the map has moved, which reads as a
    //locked-up machine and makes the whole colour half of the sweep measure nothing.
    a.ldA(0x80).ldhTo(0x68)   //BGPI, auto-increment from index 0
     .ldB(0x00)
     .label("bgpd")
       .ldAB().addAB().addA(0x1f).ldhTo(0x69)
       .incB().ldAB().cp(0x40).jrNZ("bgpd")
     .ldA(0x80).ldhTo(0x6a)   //OBPI, auto-increment from index 0
     .ldB(0x00)
     .label("obpd")
       .ldAB().addA(0x53).ldhTo(0x6b)
       .incB().ldAB().cp(0x40).jrNZ("obpd");
  }

  a

   //sound: master enable, every channel to both sides, full volume
   .ldA(0x80).ldhTo(0x26)
   .ldA(0xff).ldhTo(0x25)
   .ldA(0x77).ldhTo(0x24)
   //channel 1: sweep, duty, envelope -- the only channel whose frequency moves on its own
   .ldA(0x16).ldhTo(0x10).ldA(0x80).ldhTo(0x11).ldA(0xf3).ldhTo(0x12)
   .ldA(0x83).ldhTo(0x13).ldA(0x87).ldhTo(0x14)
   //channel 2: a second square at a different period, so the mix is not a single tone
   .ldA(0x40).ldhTo(0x16).ldA(0xd7).ldhTo(0x17).ldA(0x11).ldhTo(0x18).ldA(0x86).ldhTo(0x19)
   //channel 3: wave ram is loaded with the dac off, then the channel is triggered
   .xorA().ldhTo(0x1a)
   .ldHL(0xff30).ldB(0x00)
   .label("wave")
     .ldAB().addAB().ldHLIA()
     .incB().ldAB().cp(0x10).jrNZ("wave")
   .ldA(0x80).ldhTo(0x1a).xorA().ldhTo(0x1b).ldA(0x20).ldhTo(0x1c)
   .ldA(0xc1).ldhTo(0x1d).ldA(0x85).ldhTo(0x1e)
   //channel 4: noise, whose lfsr advances on a divider of its own
   .xorA().ldhTo(0x20).ldA(0xf2).ldhTo(0x21).ldA(0x35).ldhTo(0x22).ldA(0x80).ldhTo(0x23)

   //stat: lyc and mode sources enabled with lyc mid-picture. interrupts stay masked at the cpu,
   //so this moves the stat line and the interrupt flags without changing control flow -- the
   //point is that the ppu's position becomes observable, not that it is acted on.
   .ldA(0x48).ldhTo(0x41)
   .ldA(0x48).ldhTo(0x45);

  if(doubleSpeed) {
    //SM83::instructionSTOP returns early when a switch is armed, so this doubles the cpu clock
    //and carries on rather than halting: the ppu then runs at half the cpu's rate
    a.ldA(0x01).ldhTo(0x4d).stop();
  }

  a.ldA(0x93).ldhTo(0x40);   //lcd on, background and objects on, tile data at $8000

  a.label("loop")
   //scroll horizontally, so consecutive frames differ and a per-frame hash is not a constant
   .ldhFrom(0x43).incA().ldhTo(0x43);

  if(input) {
    //put the joypad on screen: both halves of P1 are read and packed into the vertical scroll, so
    //each button produces a different picture. without this the buttons are unobservable and a
    //name-matching mistake in wasm/gb.cpp's input() -- which resolves them by string, with no
    //controller port to disambiguate -- would pass every check the harness makes.
    a.ldA(0x20).ldhTo(0x00).ldhFrom(0x00).andN(0x0f).ldCA()   //directions: down, up, left, right
     .ldA(0x10).ldhTo(0x00).ldhFrom(0x00).andN(0x0f).ldBA()   //actions: start, select, b, a
     .ldAC().addAA().addAA().addAA().addAA()
     .addAB().ldhTo(0x42);
  } else {
    a.ldhFrom(0x42).addA(0x03).ldhTo(0x42);
  }

  a
   //read LY in a tight loop. this is the cpu observing the ppu's position mid-unit, which is
   //precisely what the flat stepper has to reproduce clock for clock.
   .ldB(0x00)
   .label("ly")
     .ldhFrom(0x44).ldCA()
     .incB().ldAB().cp(0x40).jrNZ("ly");

  if(lcdOff) {
    //drop the lcd and bring it back twice a frame. while it is off the ppu is on its display-off
    //arm, and the write that re-enables it re-derives the ppu cothread -- discarding whatever
    //unit was in flight, which the flat stepper has to discard too.
    for(const pass of [0, 1]) {
      a.ldhFrom(0x40).andN(0x7f).ldhTo(0x40)
       .ldB(0x30)
       .label(`off${pass}`).decB().jrNZ(`off${pass}`)
       .ldhFrom(0x40).orN(0x80).ldhTo(0x40)
       .ldB(0x30)
       .label(`on${pass}`).decB().jrNZ(`on${pass}`);
    }
  }

  //pace the loop to the frame: wait for vblank to open, then for it to close
  a.label("vblankIn").ldhFrom(0x44).cp(0x90).jrNZ("vblankIn")
   .label("vblankOut").ldhFrom(0x44).cp(0x90).jrZ("vblankOut")
   .jp("loop");

  const program = a.assemble();

  const rom = new Uint8Array(0x8000);
  rom[0x0100] = 0x00;                                     //nop
  rom[0x0101] = 0xc3; rom[0x0102] = 0x50; rom[0x0103] = 0x01;  //jp $0150
  rom.set(LOGO, 0x0104);
  rom.set(new TextEncoder().encode("ARESSTRESS"), 0x0134);
  rom[0x0143] = color ? 0x80 : 0x00;                      //cgb flag
  rom[0x0147] = 0x00;                                     //rom only, no mapper
  rom[0x0148] = 0x00;                                     //32 KiB
  rom[0x0149] = 0x00;                                     //no cartridge ram

  //every byte the checksum covers must already be in place
  let checksum = 0;
  for(let address = 0x0134; address <= 0x014c; address++) checksum = (checksum - rom[address] - 1) & 0xff;
  rom[0x014d] = checksum;

  if(0x0150 + program.length > 0x4000) throw new Error("program overruns the first bank");
  rom.set(program, 0x0150);
  return rom;
}
