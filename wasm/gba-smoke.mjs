//Liveness for the Game Boy Advance target: the core loads a BIOS and a cartridge, produces a
//240x160 picture and a non-silent stereo stream, and every one of the ten buttons reaches the
//machine.
//
//   node wasm/gba-smoke.mjs build_wasm/wasm/ares-gba.mjs
//
//Two things here have no counterpart in the other cores' smoke tests. The BIOS is supplied by the
//harness rather than shipped, because ares cannot start the machine without one and Nintendo's is
//not in this tree; see gba-stress-rom.mjs. And the input probe exists for the same reason gb's
//does: the advance has no controller ports, so wasm/gba.cpp resolves ten buttons by name with no
//port to disambiguate them, and a typo there would map two to the same bit in silence. The ROM
//paints KEYINPUT into the low background colours, so ten working buttons give ten pictures.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom, buildStubBios} from "./gba-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "build_wasm/wasm/ares-gba.mjs"));
const {default: createAresGba} = await import(moduleUrl);
const module = await createAresGba({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

const buttons = ["Up", "Down", "Left", "Right", "B", "A", "L", "R", "Select", "Start"];
const rom = buildStressRom();
const bios = buildStubBios();

const fnv1a = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");

const upload = (bytes, call) => {
  const pointer = module._ares_gba_alloc(bytes.length);
  module.HEAPU8.set(bytes, pointer);
  const result = call(pointer, bytes.length);
  module._ares_gba_free(pointer);
  return result;
};

//a load with no BIOS has to be refused rather than run a machine that would sit at 0x00000000
//executing zeroes, which is what it would do
if(module._ares_gba_load(0, 0)) throw new Error("an empty ROM loaded");
upload(rom, (pointer, size) => {
  if(module._ares_gba_load(pointer, size)) throw new Error("a cartridge loaded with no BIOS");
});
const biosRefusal = module.UTF8ToString(module._ares_gba_error());

upload(bios, (pointer, size) => module._ares_gba_set_bios(pointer, size));
module._ares_gba_set_audio_frequency(48000);
const loaded = upload(rom, (pointer, size) => module._ares_gba_load(pointer, size));
if(!loaded) throw new Error(module.UTF8ToString(module._ares_gba_error()));

//the setup code fills two VRAM regions, both palettes, the map and the object table before it ever
//enables the display; thirty frames is several times what that costs
const settleFrames = 30;
for(let frame = 0; frame < settleFrames; frame++) module._ares_gba_run_frame();

const frameCount = 120;
const switchBase = module._ares_gba_switch_count?.() ?? 0;
let videoHash = 2166136261;
let audioHash = 2166136261;
let audioFrames = 0;
let coreTime = 0;
for(let frame = 0; frame < frameCount; frame++) {
  const start = performance.now();
  module._ares_gba_run_frame();
  coreTime += performance.now() - start;
  const frames = module._ares_gba_audio_frames();
  audioFrames += frames;
  audioHash = fnv1a(audioHash, new Uint8Array(
    module.HEAPU8.buffer, module._ares_gba_audio_data(), frames * 2 * 4));
  const width = module._ares_gba_video_width(), height = module._ares_gba_video_height();
  videoHash = fnv1a(videoHash, new Uint8Array(
    module.HEAPU8.buffer, module._ares_gba_video_data(), width * height * 4));
}

//Every probe below has to start from the same machine, or it measures the machine's own animation
//instead of the input. The ROM scrolls every frame, so two windows taken back to back differ no
//matter what is held down. Saving a state once and restoring it before each probe is what makes the
//input the only variable.
module._ares_gba_state_save(1);
const stateSize = module._ares_gba_state_size();
if(!stateSize) throw new Error(module.UTF8ToString(module._ares_gba_error()));
const state = new Uint8Array(module.HEAPU8.buffer, module._ares_gba_state_data(), stateSize).slice();
const statePointer = module._ares_gba_alloc(stateSize);

const probe = (player, mask) => {
  module.HEAPU8.set(state, statePointer);
  if(!module._ares_gba_state_load(statePointer, stateSize)) {
    throw new Error(module.UTF8ToString(module._ares_gba_error()));
  }
  module._ares_gba_set_input(0, 0);
  module._ares_gba_set_input(1, 0);
  module._ares_gba_set_input(player, mask);
  let hash = 2166136261;
  for(let frame = 0; frame < 20; frame++) {
    module._ares_gba_run_frame();
    const width = module._ares_gba_video_width(), height = module._ares_gba_video_height();
    hash = fnv1a(hash, new Uint8Array(
      module.HEAPU8.buffer, module._ares_gba_video_data(), width * height * 4));
  }
  return hex(hash);
};

const idle = probe(0, 0);
const inputBits = {};
for(const [index, name] of buttons.entries()) inputBits[name] = probe(0, 1 << index);

//a second player would be a mapping bug rather than a feature: ares/gba/system/controls.cpp builds
//one Controls object and no ports, so anything but player 0 has nowhere to go
const player1 = probe(1, 0x3ff);
module._ares_gba_free(statePointer);

const switches = module._ares_gba_switch_count
  ? (module._ares_gba_switch_count() - switchBase) >>> 0 : null;

const distinct = new Set(Object.values(inputBits));
const result = {
  biosRefusal,
  videoWidth: module._ares_gba_video_width(),
  videoHeight: module._ares_gba_video_height(),
  audioFrames,
  msPerFrame: +(coreTime / frameCount).toFixed(2),
  fps: +(frameCount * 1000 / coreTime).toFixed(1),
  switchesPerFrame: switches === null ? null : Math.round(switches / frameCount),
  videoHash: hex(videoHash),
  audioHash: hex(audioHash),
  idle,
  inputBits,
  distinctInputHashes: distinct.size,
  buttonsChangingThePicture: Object.values(inputBits).filter(hash => hash !== idle).length,
  player1: player1 === idle ? "none" : "REACHED THE MACHINE",
};
console.log(JSON.stringify(result));

const failures = [];
if(!biosRefusal.includes("BIOS")) failures.push("a cartridge with no BIOS was not refused for that reason");
if(result.videoWidth !== 240 || result.videoHeight !== 160) failures.push("picture is not 240x160");
if(result.audioFrames === 0) failures.push("no audio frames were produced");
if(distinct.size !== buttons.length) {
  failures.push(`only ${distinct.size} of ${buttons.length} buttons are distinguishable`);
}
if(result.buttonsChangingThePicture !== buttons.length) {
  failures.push(`${buttons.length - result.buttonsChangingThePicture} button(s) left the picture identical to holding nothing`);
}
if(result.player1 !== "none") failures.push("player 1 reached the machine; the advance has one controller");

module._ares_gba_unload();

if(failures.length) {
  for(const failure of failures) console.error(failure);
  process.exit(1);
}
