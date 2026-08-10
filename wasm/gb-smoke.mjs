//Liveness for the Game Boy target: the core loads a cartridge, produces a 160x144 picture and a
//non-silent stereo stream, and every one of the eight buttons reaches the machine.
//
//   node wasm/gb-smoke.mjs build_wasm/wasm/ares-gb.mjs
//
//The input probe is the part worth explaining. gb has no controller ports -- the buttons hang off
//a "Controls" object on the system node -- so wasm/gb.cpp resolves them by name with no port walk,
//and a typo there would silently map two buttons to the same bit or none at all. Holding one
//button at a time and hashing the frames it produces turns that into something observable: the ROM
//draws the joypad register, so eight working buttons give eight different pictures.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./gb-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "build_wasm/wasm/ares-gb.mjs"));
const {default: createAresGb} = await import(moduleUrl);
const module = await createAresGb({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

const buttons = ["Up", "Down", "Left", "Right", "B", "A", "Select", "Start"];
const rom = buildStressRom({input: true});

const fnv1a = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");

const pointer = module._ares_gb_alloc(rom.length);
module.HEAPU8.set(rom, pointer);
module._ares_gb_set_audio_frequency(48000);
const loaded = module._ares_gb_load(pointer, rom.length);
module._ares_gb_free(pointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_gb_error()));

//the boot ROM's logo animation outlasts the other cores' settle windows
const settleFrames = 240;
for(let frame = 0; frame < settleFrames; frame++) module._ares_gb_run_frame();

const frameCount = 120;
const switchBase = module._ares_gb_switch_count?.() ?? 0;
let videoHash = 2166136261;
let audioHash = 2166136261;
let audioFrames = 0;
let coreTime = 0;
for(let frame = 0; frame < frameCount; frame++) {
  const start = performance.now();
  module._ares_gb_run_frame();
  coreTime += performance.now() - start;
  const frames = module._ares_gb_audio_frames();
  audioFrames += frames;
  audioHash = fnv1a(audioHash, new Uint8Array(
    module.HEAPU8.buffer, module._ares_gb_audio_data(), frames * 2 * 4));
  const width = module._ares_gb_video_width(), height = module._ares_gb_video_height();
  videoHash = fnv1a(videoHash, new Uint8Array(
    module.HEAPU8.buffer, module._ares_gb_video_data(), width * height * 4));
}

//Every probe below has to start from the same machine, or it measures the machine's own animation
//instead of the input. The ROM scrolls horizontally every frame, so two windows taken back to back
//differ no matter what is held down -- eight buttons would produce eight different hashes even if
//set_input did nothing whatsoever. Saving a state once and restoring it before each probe is what
//makes the input the only variable.
module._ares_gb_state_save(1);
const stateSize = module._ares_gb_state_size();
if(!stateSize) throw new Error(module.UTF8ToString(module._ares_gb_error()));
const state = new Uint8Array(module.HEAPU8.buffer, module._ares_gb_state_data(), stateSize).slice();
const statePointer = module._ares_gb_alloc(stateSize);

const probe = (player, mask) => {
  module.HEAPU8.set(state, statePointer);
  if(!module._ares_gb_state_load(statePointer, stateSize)) {
    throw new Error(module.UTF8ToString(module._ares_gb_error()));
  }
  module._ares_gb_set_input(0, 0);
  module._ares_gb_set_input(1, 0);
  module._ares_gb_set_input(player, mask);
  let hash = 2166136261;
  for(let frame = 0; frame < 20; frame++) {
    module._ares_gb_run_frame();
    const width = module._ares_gb_video_width(), height = module._ares_gb_video_height();
    hash = fnv1a(hash, new Uint8Array(
      module.HEAPU8.buffer, module._ares_gb_video_data(), width * height * 4));
  }
  return hex(hash);
};

const idle = probe(0, 0);
const inputBits = {};
for(const [index, name] of buttons.entries()) inputBits[name] = probe(0, 1 << index);

//a second player would be a mapping bug rather than a feature: ares/gb/system/controls.cpp builds
//one Controls object and no ports, so anything but player 0 has nowhere to go. holding every bit
//on player 1 has to leave the machine exactly where holding nothing does.
const player1 = probe(1, 0xff);
module._ares_gb_free(statePointer);

const switches = module._ares_gb_switch_count
  ? (module._ares_gb_switch_count() - switchBase) >>> 0 : null;

const distinct = new Set(Object.values(inputBits));
const result = {
  videoWidth: module._ares_gb_video_width(),
  videoHeight: module._ares_gb_video_height(),
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
if(result.videoWidth !== 160 || result.videoHeight !== 144) failures.push("picture is not 160x144");
if(result.audioFrames === 0) failures.push("no audio frames were produced");
if(distinct.size !== buttons.length) failures.push(`only ${distinct.size} of 8 buttons are distinguishable`);
if(result.buttonsChangingThePicture !== buttons.length) {
  failures.push(`${buttons.length - result.buttonsChangingThePicture} button(s) left the picture identical to holding nothing`);
}
if(result.player1 !== "none") failures.push("player 1 reached the machine; gb has one controller");

module._ares_gb_unload();

if(failures.length) {
  for(const failure of failures) console.error(failure);
  process.exit(1);
}
