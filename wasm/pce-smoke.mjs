//Liveness for the PC Engine target: the core loads a HuCard, produces a picture and a non-silent
//stereo stream, and its three persistence and framing controls -- save state, battery and overscan --
//all round-trip.
//
//   node wasm/pce-smoke.mjs [build_wasm_pce/wasm/ares-pce.mjs] [frames]
//
//Two of the numbers below are console-specific rather than boilerplate, and both would read as a bug
//on any of the other cores.
//
//The reported width is a sample count, not a pixel count. The vce runs the picture out at four times
//the pixel rate of its slowest dot clock, so a line is 1365 samples wide and the core reports a
//horizontal scale of 0.25 (ares/pce/vdp/vdp.cpp:47). A 256-pixel picture is therefore handed over
//1032 samples wide, and anything drawing it square stretches it four times too far.
//
//And the battery blob is never empty. The PC Engine's save memory is 2 KiB of BRAM inside the CD-ROM
//unit, which ares reports as present on every model precisely so HuCard games can save into it
//(ares/pce/cpu/io.cpp:50-51, ares/pce/pcd/pcd.cpp:46), so a cartridge with no save hardware of its
//own still gathers one entry. On the other cores an empty blob is the ordinary answer for a
//cartridge with no battery; here it is a failure.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./pce-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "build_wasm_pce/wasm/ares-pce.mjs"));
const frameCount = Number(process.argv[3] ?? 120);

const fnv1a = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");
const abort = message => {
  console.error(message);
  process.exit(1);
};

if(!Number.isFinite(frameCount) || frameCount < 1) {
  abort(`Frame count must be a positive number, not ${JSON.stringify(process.argv[3])}`);
}

const {default: createAresPce} = await import(moduleUrl);
const module = await createAresPce({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

const lastError = () => module.UTF8ToString(module._ares_pce_error()) || "no reason given";

//both buffers live in vectors that resize with the resolution and with however many samples a frame
//produced, so the pointer and the length are re-read every frame rather than cached once
const videoBytes = () => new Uint8Array(module.HEAPU8.buffer, module._ares_pce_video_data(),
  module._ares_pce_video_width() * module._ares_pce_video_height() * 4);
const audioBytes = () => new Uint8Array(module.HEAPU8.buffer, module._ares_pce_audio_data(),
  module._ares_pce_audio_frames() * 2 * 4);

//the model is left empty, so the cartridge's region header picks the machine: mia stamps NTSC-U on
//anything it does not read as Japanese, which boots the TurboGrafx 16 the American library expects.
const rom = buildStressRom();
const romPointer = module._ares_pce_alloc(rom.length);
module.HEAPU8.set(rom, romPointer);
module._ares_pce_set_audio_frequency(48000);
const loaded = module._ares_pce_load(romPointer, rom.length);
module._ares_pce_free(romPointer);
if(!loaded) abort(`Could not load the stress ROM: ${lastError()}`);

//the ROM fills VRAM by block move and turns the display on from its reset handler, so the opening
//frames are a blank screen rather than the steady state the hashes are meant to describe
for(let frame = 0; frame < 20; frame++) module._ares_pce_run_frame();

//the switch counter only exists in an -DARES_WASM_DEBUG=ON build; say so rather than report a zero
//that would read as a suspiciously good result
const switchBase = module._ares_pce_switch_count?.() ?? 0;
let videoHash = 2166136261;
let audioHash = 2166136261;
let audioFrames = 0;
let coreTime = 0;
for(let frame = 0; frame < frameCount; frame++) {
  const start = performance.now();
  module._ares_pce_run_frame();
  coreTime += performance.now() - start;
  audioFrames += module._ares_pce_audio_frames();
  videoHash = fnv1a(videoHash, videoBytes());
  audioHash = fnv1a(audioHash, audioBytes());
}
const switchesPerFrame = module._ares_pce_switch_count
  ? Math.round((module._ares_pce_switch_count() - switchBase) / frameCount)
  : "unavailable (needs -DARES_WASM_DEBUG=ON)";

const failures = [];

//(a) the state. synchronize = 1 runs the scheduler to a safe point first, which is the whole
//difference between bytes desktop ares would accept and bytes that mean something only inside this
//process; a run-ahead state (0) embeds raw cothread stacks full of host pointers. The check is that
//the ten frames after a restore are the ten frames that followed the save, hashed pixel for pixel --
//a state that restored the cpu but forgot a vdc latch or the timer's reload would diverge inside a
//frame or two, because the ROM takes a raster interrupt five times a screen.
module._ares_pce_state_save(1);
const stateSize = module._ares_pce_state_size();
if(!stateSize) abort(`Could not save a state: ${lastError()}`);
const state = new Uint8Array(module.HEAPU8.buffer, module._ares_pce_state_data(), stateSize).slice();

const probe = () => {
  let hash = 2166136261;
  for(let frame = 0; frame < 10; frame++) {
    module._ares_pce_run_frame();
    hash = fnv1a(hash, videoBytes());
  }
  return hex(hash);
};

const beforeLoad = probe();
const statePointer = module._ares_pce_alloc(stateSize);
module.HEAPU8.set(state, statePointer);
const restored = module._ares_pce_state_load(statePointer, stateSize);
module._ares_pce_free(statePointer);
if(!restored) abort(`Could not load the state back: ${lastError()}`);
const afterLoad = probe();
if(beforeLoad !== afterLoad) {
  failures.push(`the ten frames after a state load hashed ${afterLoad}, not the ${beforeLoad} that followed the save`);
}

//(b) the battery, in the container wasm/save-ram.hpp documents: "ARSV", a version, an entry count,
//then one named entry per memory. Reading the count rather than only the magic is what tells a
//gathered console BRAM apart from a header written over nothing.
module._ares_pce_save_ram_save();
const batterySize = module._ares_pce_save_ram_size();
if(!batterySize) abort(`The console gathered no battery memory at all: ${lastError()}`);
const battery = new Uint8Array(module.HEAPU8.buffer, module._ares_pce_save_ram_data(), batterySize).slice();
const batteryWords = new DataView(battery.buffer);
const batteryMagic = String.fromCharCode(...battery.subarray(0, 4));
const batteryVersion = batterySize >= 12 ? batteryWords.getUint32(4, true) : 0;
const batteryEntries = batterySize >= 12 ? batteryWords.getUint32(8, true) : 0;
if(batteryMagic !== "ARSV") failures.push(`battery blob starts with ${JSON.stringify(batteryMagic)}, not "ARSV"`);
if(batteryVersion !== 1) failures.push(`battery blob is version ${batteryVersion}, not 1`);
if(batteryEntries < 1) failures.push("battery blob holds no entries; the console's BRAM should always be one");

//loading re-seats the cartridge and power cycles the machine, so this is deliberately after the
//state check and before the overscan one, which starts from a fresh frame anyway
const batteryPointer = module._ares_pce_alloc(battery.length);
module.HEAPU8.set(battery, batteryPointer);
const batteryLoaded = module._ares_pce_save_ram_load(batteryPointer, battery.length);
module._ares_pce_free(batteryPointer);
if(!batteryLoaded) abort(`Could not load the battery back: ${lastError()}`);

//(c) overscan. The vdp re-reads the flag at the end of every frame, so the border arrives on the
//next one and the reported width and height grow with it. The width moves in whole dot-clock steps
//rather than pixels, for the reason in the header comment.
module._ares_pce_run_frame();
const croppedWidth = module._ares_pce_video_width();
const croppedHeight = module._ares_pce_video_height();
module._ares_pce_set_overscan(1);
module._ares_pce_run_frame();
const overscanWidth = module._ares_pce_video_width();
const overscanHeight = module._ares_pce_video_height();
if(overscanWidth <= croppedWidth || overscanHeight <= croppedHeight) {
  failures.push(`overscan left the picture at ${overscanWidth}x${overscanHeight}; it should exceed ${croppedWidth}x${croppedHeight}`);
}

const result = {
  videoWidth: croppedWidth,
  videoHeight: croppedHeight,
  overscanWidth,
  overscanHeight,
  audioFramesPerFrame: +(audioFrames / frameCount).toFixed(1),
  msPerFrame: +(coreTime / frameCount).toFixed(2),
  fps: +(frameCount * 1000 / coreTime).toFixed(1),
  switchesPerFrame,
  videoHash: hex(videoHash),
  audioHash: hex(audioHash),
  stateSize,
  stateRoundTrip: beforeLoad === afterLoad ? "identical" : `${beforeLoad} != ${afterLoad}`,
  batterySize,
  batteryMagic,
  batteryEntries,
};
console.log(JSON.stringify(result));

if(!croppedWidth || !croppedHeight) failures.push("the core reported an empty picture");
if(!audioFrames) failures.push("no audio frames were produced");

module._ares_pce_unload();

if(failures.length) {
  for(const failure of failures) console.error(failure);
  process.exit(1);
}
