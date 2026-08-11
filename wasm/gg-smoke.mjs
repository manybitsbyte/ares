//Proves the Game Gear path of ares-ms.mjs is alive and that every one of its seven buttons reaches
//the machine.
//
//   node wasm/gg-smoke.mjs [build_wasm/wasm/ares-ms.mjs]
//
//Game Gear is not a separate module: it is the ms core selected with ares_ms_set_model, so this
//loads the same ares-ms.mjs the Master System smoke test does and only the model differs.
//
//The button check is a per-bit frame hash rather than a register read, because a register read would
//prove the harness can see the button and not that the machine can. The image below folds the input
//straight into the picture: it reads port 0xdc for Up/Down/Left/Right/1/2 and port 0x00 for Start
//(ares/ms/cpu/memory.cpp:37-46,154-163), builds one seven-bit value, and writes it to both scroll
//registers every iteration. So a button that reaches the machine moves the background, and a button
//that does not leaves the frame hash exactly where the idle hash was.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {Asm} from "./gg-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "build_wasm/wasm/ares-ms.mjs"));
const {default: createAresMs} = await import(moduleUrl);

const model = "[Sega] Game Gear (NTSC-U)";

//bit order is the ABI's, matching the Button enum in wasm/ms.cpp
const buttons = ["Up", "Down", "Left", "Right", "1", "2", "Start"];

function buildRom() {
  const rom = new Uint8Array(32768);
  const a = new Asm(0x0000);

  a.di().im1().jp("init");
  a.org(0x0038).reti();
  a.org(0x0066).retn();

  a.org(0x0100).label("init");
  a.di().im1().ldSP(0xdff0);

  for(const [register, value] of [
    [0x0, 0x04],  //mode 4, no line interrupt
    [0x1, 0x60],  //display on, 192 lines
    [0x2, 0xff],  //name table 0x3800
    [0x5, 0x7e],  //sprite attribute table 0x3f00
    [0x6, 0xff],  //sprite pattern table 0x2000
    [0x7, 0x00],
    [0x8, 0x00],
    [0x9, 0x00],
    [0xa, 0xff],
  ]) a.vdpRegister(register, value);

  //vram: L xor H rather than a plain L ramp. A plain ramp repeats every 256 bytes, which is every
  //eight 32-byte tiles, so a scroll of 64 pixels lands on a tile with byte-identical pattern data
  //and the picture does not move at all. Bit 6 of the input mask is exactly a 64-pixel scroll, so
  //with a plain ramp the Start button reads as "did not reach the machine" when it did.
  a.vdpAddress(0x0000, 0x40).ldHL(0x0000).ldCi(0x20).label("tileOuter").ldBi(0).label("tileInner");
  a.ldAL().xorH().outi(0xbe).incHL().djnz("tileInner").decC().jrnz("tileOuter");

  //name table 0x3800: 1792 entries, varied the same way and for the same reason
  a.vdpAddress(0x3800, 0x40).ldHL(0x0000).ldCi(0x07).label("nameOuter").ldBi(0).label("nameInner");
  a.ldAL().xorH().andi(0x3f).outi(0xbe).incHL().djnz("nameInner").decC().jrnz("nameOuter");

  //cram: 32 twelve-bit colours as 64 bytes through the even-latch/odd-commit pair
  a.vdpAddress(0x0000, 0xc0).ldHL(0x0400).ldBi(64).label("cram");
  a.ldAHL().outi(0xbe).incHL().djnz("cram");

  //psg: one keyed tone, then split the four channels across the two stereo sides
  for(const value of [0x80, 0x10, 0x90, 0xa0, 0x1e, 0xb2]) a.ldAi(value).outi(0x7f);
  a.ldAi(0x3c).outi(0x06);

  a.ei();

  //main loop: fold all seven buttons into one value and scroll the background by it.
  //Both ports report active-low, so each read is complemented before use.
  a.label("main");
  a.ini(0xdc).cpl().andi(0x3f).ldBA();          //Up/Down/Left/Right/1/2 -> bits 0-5
  a.ini(0x00).cpl().andi(0x80).rrca().orB();    //Start is bit 7 of port 0x00 -> bit 6
  a.ldCA();
  a.outi(0xbf).ldAi(0x88).outi(0xbf);           //register 8: horizontal scroll
  a.ldAC().outi(0xbf).ldAi(0x89).outi(0xbf);    //register 9: vertical scroll
  a.jp("main");

  const code = a.assemble();
  if(code.length > 0x0400) throw new Error("code overruns the palette table");
  rom.set(code, 0);

  for(let index = 0; index < 32; index++) {
    rom[0x0400 + index * 2 + 0] = (index * 37 + 11) & 0xff;
    rom[0x0400 + index * 2 + 1] = (index * 5 + 1) & 0x0f;
  }

  rom.set(new TextEncoder().encode("TMR SEGA"), 0x7ff0);
  rom[0x7fff] = 0x4c;
  return rom;
}

const rom = buildRom();

const checksum = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");

async function create() {
  return await createAresMs({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});
}

async function boot() {
  const module = await create();
  const name = new TextEncoder().encode(`${model}\0`);
  const namePointer = module._ares_ms_alloc(name.length);
  module.HEAPU8.set(name, namePointer);
  module._ares_ms_set_model(namePointer);
  module._ares_ms_free(namePointer);

  const pointer = module._ares_ms_alloc(rom.length);
  module.HEAPU8.set(rom, pointer);
  module._ares_ms_set_audio_frequency(48000);
  const loaded = module._ares_ms_load(pointer, rom.length);
  module._ares_ms_free(pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_ms_error()));
  return module;
}

//---- liveness -------------------------------------------------------------------------------

const module = await boot();

const frameCount = 120;
const switchBase = module._ares_ms_switch_count?.() ?? 0;
let videoHash = 2166136261;
let audioHash = 2166136261;
let coreTime = 0;
let stereoDiffering = 0;
for(let frame = 0; frame < frameCount; frame++) {
  const start = performance.now();
  module._ares_ms_run_frame();
  coreTime += performance.now() - start;
  const width = module._ares_ms_video_width();
  const height = module._ares_ms_video_height();
  const audioFrames = module._ares_ms_audio_frames();
  videoHash = checksum(videoHash, new Uint8Array(module.HEAPU8.buffer, module._ares_ms_video_data(), width * height * 4));
  const samples = new Float32Array(module.HEAPU8.buffer, module._ares_ms_audio_data(), audioFrames * 2);
  audioHash = checksum(audioHash, new Uint8Array(samples.buffer, samples.byteOffset, samples.length * 4));
  //the Game Gear's PSG is the only one in this core with two sides; if they never differ the stereo
  //path is not being exercised and every stereo claim below would be vacuous
  for(let index = 0; index + 1 < samples.length; index += 2) {
    if(samples[index] !== samples[index + 1]) stereoDiffering++;
  }
}
const switchesPerFrame = module._ares_ms_switch_count
  ? (module._ares_ms_switch_count() - switchBase) / frameCount
  : "unavailable (needs -DARES_WASM_DEBUG=ON)";

const result = {
  model,
  videoWidth: module._ares_ms_video_width(),
  videoHeight: module._ares_ms_video_height(),
  audioFrames: module._ares_ms_audio_frames(),
  stereoFramesDiffering: stereoDiffering,
  videoHash: hex(videoHash),
  audioHash: hex(audioHash),
  switchesPerFrame,
  framesPerSecond: frameCount * 1000 / coreTime,
};
module._ares_ms_unload();
console.log(JSON.stringify(result));

const failures = [];
if(result.videoWidth !== 160 || result.videoHeight !== 144) {
  failures.push(`expected a 160x144 picture, got ${result.videoWidth}x${result.videoHeight}`);
}
if(!result.audioFrames) failures.push("no audio was produced");
if(!stereoDiffering) failures.push("both stereo sides are identical; port 0x06 reached nothing");

//---- every button ---------------------------------------------------------------------------

//each bit gets its own freshly booted machine, so a hash difference is that button and not the
//accumulated history of the ones pressed before it
async function hashWithMask(mask) {
  const machine = await boot();
  machine._ares_ms_set_input(0, mask);
  let hash = 2166136261;
  for(let frame = 0; frame < 40; frame++) {
    machine._ares_ms_run_frame();
    const width = machine._ares_ms_video_width(), height = machine._ares_ms_video_height();
    hash = checksum(hash, new Uint8Array(machine.HEAPU8.buffer, machine._ares_ms_video_data(), width * height * 4));
  }
  machine._ares_ms_unload();
  return hex(hash);
}

const idle = await hashWithMask(0);
const inputBits = {none: idle};
for(let bit = 0; bit < buttons.length; bit++) {
  inputBits[buttons[bit]] = await hashWithMask(1 << bit);
}
//bits 7 and 8 are Reset and Rapid, which a Game Gear does not have; player 1 is a second controller
//port a Game Gear does not have either. All three must leave the picture exactly where idle left it.
inputBits.bit7 = await hashWithMask(1 << 7);
inputBits.bit8 = await hashWithMask(1 << 8);
const player1 = await (async () => {
  const machine = await boot();
  machine._ares_ms_set_input(1, 0x1ff);
  let hash = 2166136261;
  for(let frame = 0; frame < 40; frame++) {
    machine._ares_ms_run_frame();
    const width = machine._ares_ms_video_width(), height = machine._ares_ms_video_height();
    hash = checksum(hash, new Uint8Array(machine.HEAPU8.buffer, machine._ares_ms_video_data(), width * height * 4));
  }
  machine._ares_ms_unload();
  return hex(hash);
})();
inputBits.player1 = player1;

console.log(JSON.stringify({inputBits}));

for(const button of buttons) {
  if(inputBits[button] === idle) failures.push(`${button} did not reach the machine`);
}
const pressed = buttons.map(button => inputBits[button]);
if(new Set(pressed).size !== pressed.length) {
  failures.push(`two buttons produced the same picture: ${JSON.stringify(inputBits)}`);
}
for(const inert of ["bit7", "bit8", "player1"]) {
  if(inputBits[inert] !== idle) failures.push(`${inert} moved the picture but reaches nothing on a Game Gear`);
}

//---- overscan is inert on a Game Gear ---------------------------------------------------------

const overscanned = await (async () => {
  const machine = await boot();
  machine._ares_ms_set_overscan(1);
  let hash = 2166136261;
  for(let frame = 0; frame < 40; frame++) {
    machine._ares_ms_run_frame();
    const width = machine._ares_ms_video_width(), height = machine._ares_ms_video_height();
    hash = checksum(hash, new Uint8Array(machine.HEAPU8.buffer, machine._ares_ms_video_data(), width * height * 4));
  }
  const size = {width: machine._ares_ms_video_width(), height: machine._ares_ms_video_height()};
  machine._ares_ms_unload();
  return {hash: hex(hash), ...size};
})();
console.log(JSON.stringify({overscan: overscanned}));
if(overscanned.width !== 160 || overscanned.height !== 144 || overscanned.hash !== idle) {
  failures.push("ares_ms_set_overscan changed a Game Gear picture; the viewport is fixed at 160x144");
}

if(failures.length) {
  for(const failure of failures) console.error(failure);
  process.exit(1);
}
