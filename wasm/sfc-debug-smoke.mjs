import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "build_wasm/wasm/ares-sfc.mjs"));
const {default: createAresSfc} = await import(moduleUrl);
const module = await createAresSfc({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

let failures = 0;
const hex = (value, digits = 6) => `$${value.toString(16).padStart(digits, "0")}`;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const checkThat = (label, ok, detail) => {
  if(!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}: ${detail}`);
};

//a LoROM cartridge whose reset vector is $008000. It disables interrupts, widens A and the index
//registers, writes two known 16-bit values into the low end of WRAM with long stores, and parks in
//a one-instruction branch. The instruction lengths after REP #$30 are 2, 3, 4, 3, 4, 2 bytes, which
//is what makes a stepped PC sequence proof of a real single step rather than a fixed increment.
const RESET = 0x008000;
const program = [
  0x78,                    //8000  SEI
  0x18,                    //8001  CLC
  0xfb,                    //8002  XCE
  0xc2, 0x30,              //8003  REP #$30
  0xa9, 0x34, 0x12,        //8005  LDA #$1234
  0x8f, 0x00, 0x00, 0x7e,  //8008  STA $7e0000
  0xa9, 0x78, 0x56,        //800c  LDA #$5678
  0x8f, 0x02, 0x00, 0x7e,  //800f  STA $7e0002
  0x80, 0xfe,              //8013  BRA $8013
];
const BOUNDARIES = [0x008001, 0x008002, 0x008003, 0x008005, 0x008008, 0x00800c, 0x00800f, 0x008013];
const WRAM = 0x7e0000;
const WRAM_EXPECTED = [0x34, 0x12, 0x78, 0x56];

const buildRom = () => {
  const rom = new Uint8Array(32 * 1024).fill(0xff);
  rom.set(program, 0);
  const header = 0x7fc0;
  rom.set(new TextEncoder().encode("ARES WASM DEBUG      "), header);
  rom.set([0x20, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00], header + 0x15);
  for(let vector = 0x7fe4; vector <= 0x7ffe; vector += 2) {
    rom[vector + 0] = 0x00;
    rom[vector + 1] = 0x80;
  }
  rom.fill(0, header + 0x1c, header + 0x20);
  const checksum = (rom.reduce((sum, byte) => sum + byte, 0) + 0x1fe) & 0xffff;
  const complement = checksum ^ 0xffff;
  rom[header + 0x1c] = complement & 0xff;
  rom[header + 0x1d] = complement >> 8;
  rom[header + 0x1e] = checksum & 0xff;
  rom[header + 0x1f] = checksum >> 8;
  return rom;
};

const rom = buildRom();
const boot = () => {
  module._ares_sfc_unload();
  module._ares_sfc_set_audio_frequency(44100);
  const pointer = module._ares_sfc_alloc(rom.length);
  module.HEAPU8.set(rom, pointer);
  const loaded = module._ares_sfc_load(pointer, rom.length);
  module._ares_sfc_free(pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_sfc_error()));
};

const peek = (address, size) => {
  const pointer = module._ares_sfc_alloc(size);
  const ok = module._ares_sfc_debug_peek(address, size, pointer);
  const bytes = ok ? [...module.HEAPU8.subarray(pointer, pointer + size)] : null;
  module._ares_sfc_free(pointer);
  return bytes;
};

const registers = () => {
  const count = module._ares_sfc_debug_register_count();
  const pointer = module._ares_sfc_alloc(count * 4);
  const ok = module._ares_sfc_debug_registers(pointer);
  const words = ok ? [...new Uint32Array(module.HEAPU8.buffer, pointer, count)] : null;
  module._ares_sfc_free(pointer);
  if(!words) return null;
  const [a, x, y, s, d, db, pb, pc, p, e] = words;
  return {a, x, y, s, d, db, pb, pc, p, e};
};

console.log("-- disarmed: the same breakpoint must do nothing --");
boot();
module._ares_sfc_debug_set_enabled(0);
module._ares_sfc_debug_clear_breakpoints();
module._ares_sfc_debug_add_breakpoint(RESET);
//the control run. The first frame after power is short because the ppu starts part way through one,
//so a resumed frame is compared against this rather than against a whole-frame sample count.
const control = [];
for(let frame = 0; frame < 5; frame++) {
  module._ares_sfc_run_frame();
  control.push(module._ares_sfc_audio_frames());
}
check("never halted", module._ares_sfc_debug_halted(), 0);
check("no stop reason", module._ares_sfc_debug_stop_reason(), 0);
checkThat("every frame ran whole", control.slice(1).every(samples => samples > 700), `${JSON.stringify(control)} audio frames per frame`);
check("the breakpoint is still registered, just inert", module._ares_sfc_debug_breakpoint_count(), 1);

console.log("-- armed: a breakpoint on the reset vector must stop the machine --");
boot();
module._ares_sfc_debug_set_enabled(1);
module._ares_sfc_debug_clear_breakpoints();
module._ares_sfc_debug_add_breakpoint(RESET);
check("breakpoint count", module._ares_sfc_debug_breakpoint_count(), 1);

module._ares_sfc_run_frame();
check("halted after the first frame", module._ares_sfc_debug_halted(), 1);
check("stop reason is breakpoint", module._ares_sfc_debug_stop_reason(), 1);
check("halted pc is the breakpoint", hex(module._ares_sfc_debug_pc()), hex(RESET));
const haltedFrameSamples = module._ares_sfc_audio_frames();
checkThat("the frame returned early", haltedFrameSamples < 100, `${haltedFrameSamples} audio frames, a whole frame is ~735`);

const atReset = registers();
checkThat("registers read at the halt", atReset !== null, JSON.stringify(atReset));
check("pb:pc agrees with the reported pc", hex((atReset.pb << 16) | atReset.pc), hex(RESET));
check("the machine is in emulation mode at reset", atReset.e, 1);

console.log("-- stepping: one instruction per step, by real instruction length --");
const stepped = [];
for(const _ of BOUNDARIES) {
  module._ares_sfc_debug_step();
  module._ares_sfc_run_frame();
  if(!module._ares_sfc_debug_halted()) { failures++; console.log("FAIL  the machine ran away during a step"); break; }
  stepped.push(module._ares_sfc_debug_pc());
}
check("stepped pc sequence", stepped.map(pc => hex(pc)), BOUNDARIES.map(pc => hex(pc)));
check("still halted after stepping", module._ares_sfc_debug_halted(), 1);
check("stop reason is step", module._ares_sfc_debug_stop_reason(), 2);

const stepping = registers();
check("a holds the last value the rom loaded", hex(stepping.a, 4), hex(0x5678, 4));
check("the index registers widened at REP #$30", stepping.e, 0);

console.log("-- peek: wram must hold what the rom wrote, read without touching the bus --");
check("wram at $7e0000", peek(WRAM, 4), WRAM_EXPECTED);
checkThat("an mmio range with no safe read fails whole", peek(0x002137, 1) === null,
  peek(0x002137, 1) === null ? module.UTF8ToString(module._ares_sfc_error()) : "it returned a byte");
checkThat("a peek past the address space fails", peek(0xffffff, 2) === null, "24-bit bound");

console.log("-- resume: the frame must run to completion again --");
module._ares_sfc_debug_resume();
module._ares_sfc_run_frame();
check("no longer halted", module._ares_sfc_debug_halted(), 0);
check("stop reason cleared", module._ares_sfc_debug_stop_reason(), 0);
const resumed = [module._ares_sfc_audio_frames()];
for(let frame = 1; frame < 5; frame++) {
  module._ares_sfc_run_frame();
  resumed.push(module._ares_sfc_audio_frames());
}
check("still not halted after four more frames", module._ares_sfc_debug_halted(), 0);
check("the resumed frames match the control run", resumed, control);

module._ares_sfc_debug_clear_breakpoints();
module._ares_sfc_unload();

if(failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
