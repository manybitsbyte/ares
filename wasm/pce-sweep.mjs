//Compares the web build's plain-call PC Engine scheduling against the cothread scheduler.
//
//This core has no batching granularity to sweep: the vdp, the psg and the CD unit are advanced by
//plain function calls from the cpu's cothread instead of by switching to them, and that is either
//exact or it is not. The reference is therefore a second wasm build of the same sources with the
//PLATFORM_WEB fast paths compiled out:
//
//   emcmake cmake -S . -B build_wasm_pce_co -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=pce -DARES_ENABLE_CHD=OFF \
//     -DCMAKE_CXX_FLAGS=-DARES_PCE_COTHREAD
//   cmake --build build_wasm_pce_co --target ares-pce-wasm
//
//   node wasm/pce-sweep.mjs build_wasm_pce/wasm/ares-pce.mjs [build_wasm_pce_co/wasm/ares-pce.mjs] [frames]
//
//Whole concatenated sample streams are compared rather than per-frame hashes: where a frame boundary
//falls is a scheduling detail, and a per-frame hash reports a shift as a difference even when the
//waveform is identical. Video is compared frame by frame, which is exact regardless. The golden
//hashes below are literal so that any future edit to VDP::runChunk() fails loudly.
//
//Both builds are started from one synchronized state rather than from power. This machine is
//randomised at power-on -- HuC6280::power draws A, X, Y, S and MPR0-6 from a Random seeded off
//clock(), and VDC::power fills the sprite attribute table the same way -- so no two power cycles
//produce the same machine, in one build or across two, and a synchronized state records the
//difference down to the byte. Seeding from a state the web build wrote is the interchange a desktop
//build has to honour anyway, and it leaves scheduling as the only thing the comparison can see.
//
//Naming a single module runs the golden check alone, which needs no reference build.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./pce-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm_pce/wasm/ares-pce.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
const settleFrames = 20;

//region decides nothing but the model name here -- both HuCard machines are the same silicon at the
//same clock -- but the SuperGrafx has a second VDC and a video priority controller in front of both,
//which is the other arm of VDP::runChunk's template. the two HuCard models therefore share one seed:
//nothing in a state names the model, so one power-on drives both, and every hash they report has to
//agree byte for byte. that equality is this harness's own check on itself.
const configurations = [
  {name: "turbografx-16", model: "[NEC] TurboGrafx 16 (NTSC-U)", silicon: "hucard"},
  {name: "pc-engine", model: "[NEC] PC Engine (NTSC-J)", silicon: "hucard"},
  {name: "supergrafx", model: "[NEC] SuperGrafx (NTSC-J)", silicon: "supergrafx"},
];

//recorded at the default 300 frames; the check is skipped for any other frame count.
const golden = {
  "turbografx-16": {audio: "8aea580d", video: "75704399"},
  "pc-engine": {audio: "8aea580d", video: "75704399"},
  "supergrafx": {audio: "8aea580d", video: "e02816bd"},
};

const rom = buildStressRom();

//a module factory, so every configuration gets a fresh instance rather than re-powering one. this
//core carries per-frame audio and video buffers, a resampler and two screen canvases that a second
//power cycle inherits, and none of that is what the comparison is trying to see.
const load = async (path) => {
  const moduleUrl = pathToFileURL(resolve(path));
  const {default: createAresPce} = await import(moduleUrl);
  return () => createAresPce({locateFile: file => fileURLToPath(new URL(file, moduleUrl))});
};

const setModel = (core, name) => {
  const bytes = new TextEncoder().encode(name);
  const pointer = core._ares_pce_alloc(bytes.length + 1);
  core.HEAPU8.set(bytes, pointer);
  core.HEAPU8[pointer + bytes.length] = 0;
  core._ares_pce_set_model(pointer);
  core._ares_pce_free(pointer);
};

const checksum = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = value => (value >>> 0).toString(16).padStart(8, "0");

const boot = async (instantiate, model) => {
  const core = await instantiate();
  setModel(core, model);
  core._ares_pce_set_audio_frequency(48000);
  const pointer = core._ares_pce_alloc(rom.length);
  core.HEAPU8.set(rom, pointer);
  const loaded = core._ares_pce_load(pointer, rom.length);
  core._ares_pce_free(pointer);
  if(!loaded) throw new Error(core.UTF8ToString(core._ares_pce_error()));
  return core;
};

//the machine both builds start the measured frames from, one per silicon: the SuperGrafx's is a
//different size for its second VDC, and nothing else here is a different machine.
const seeds = new Map();
const seedState = async (instantiate, {model, silicon}) => {
  if(seeds.has(silicon)) return seeds.get(silicon);
  const core = await boot(instantiate, model);
  for(let frame = 0; frame < settleFrames; frame++) core._ares_pce_run_frame();
  core._ares_pce_state_save(1);
  const size = core._ares_pce_state_size();
  if(!size) throw new Error(core.UTF8ToString(core._ares_pce_error()));
  const seed = new Uint8Array(core.HEAPU8.buffer, core._ares_pce_state_data(), size).slice();
  core._ares_pce_unload();
  seeds.set(silicon, seed);
  return seed;
};

//a run returns per-frame video hashes and one hash over the whole audio stream, plus the core time
const run = async (instantiate, model, frames, seed) => {
  const core = await boot(instantiate, model);
  const seedPointer = core._ares_pce_alloc(seed.length);
  core.HEAPU8.set(seed, seedPointer);
  const restored = core._ares_pce_state_load(seedPointer, seed.length);
  core._ares_pce_free(seedPointer);
  if(!restored) throw new Error(core.UTF8ToString(core._ares_pce_error()));

  const video = [];
  let audio = 2166136261;
  let audioFrames = 0;
  let elapsed = 0;
  for(let frame = 0; frame < frames; frame++) {
    const start = performance.now();
    core._ares_pce_run_frame();
    elapsed += performance.now() - start;

    const width = core._ares_pce_video_width();
    const height = core._ares_pce_video_height();
    video.push(checksum(2166136261, new Uint8Array(
      core.HEAPU8.buffer, core._ares_pce_video_data(), width * height * 4)) >>> 0);

    const count = core._ares_pce_audio_frames();
    audioFrames += count;
    audio = checksum(audio, new Uint8Array(core.HEAPU8.buffer, core._ares_pce_audio_data(), count * 8));
  }

  core._ares_pce_state_save(1);
  const stateSize = core._ares_pce_state_size();
  const state = stateSize
    ? checksum(2166136261, new Uint8Array(core.HEAPU8.buffer, core._ares_pce_state_data(), stateSize))
    : 0;

  core._ares_pce_save_ram_save();
  const saveSize = core._ares_pce_save_ram_size();
  const saveRam = saveSize
    ? checksum(2166136261, new Uint8Array(core.HEAPU8.buffer, core._ares_pce_save_ram_data(), saveSize))
    : 0;

  core._ares_pce_unload();
  return {
    video, audio: audio >>> 0, audioFrames, stateSize, state: state >>> 0,
    saveSize, saveRam: saveRam >>> 0, ms: elapsed / frames,
  };
};

const web = await load(webPath);
const reference = referencePath ? await load(referencePath) : null;

let failures = 0;
for(const configuration of configurations) {
  const {name, model} = configuration;
  const seed = await seedState(web, configuration);
  const a = await run(web, model, measureFrames, seed);
  const line = [
    `${name.padEnd(14)} ${a.ms.toFixed(2)} ms/frame (${(1000 / a.ms).toFixed(1)} fps)`,
    `audio ${hex(a.audio)} (${(a.audioFrames / measureFrames).toFixed(1)}/frame)`,
    `state ${a.stateSize}:${hex(a.state)}`,
    `battery ${a.saveSize}:${hex(a.saveRam)}`,
  ];
  console.log(line.join("  "));

  if(measureFrames === 300) {
    const want = golden[name];
    const videoHash = hex(a.video.reduce((hash, frame) => checksum(hash, [
      frame & 0xff, frame >> 8 & 0xff, frame >> 16 & 0xff, frame >>> 24,
    ]), 2166136261) >>> 0);
    const audioOk = hex(a.audio).endsWith(want.audio);
    const videoOk = videoHash.endsWith(want.video);
    console.log(`  golden  audio ${audioOk ? "ok" : `MISMATCH ${hex(a.audio)} != ${want.audio}`}`
              + `  video ${videoOk ? "ok" : `MISMATCH ${videoHash} != ${want.video}`}`);
    if(!audioOk || !videoOk) failures++;
  }

  if(!reference) continue;
  const b = await run(reference, model, measureFrames, seed);
  const differing = a.video.findIndex((hash, frame) => hash !== b.video[frame]);
  const same = differing < 0 && a.audio === b.audio && a.stateSize === b.stateSize
            && a.state === b.state && a.saveSize === b.saveSize && a.saveRam === b.saveRam;
  console.log(`  vs cothread ${b.ms.toFixed(2)} ms/frame  speedup ${(b.ms / a.ms).toFixed(2)}x  `
            + (same ? "identical" : "DIVERGED"));
  if(!same) {
    failures++;
    if(differing >= 0) console.log(`    first differing video frame ${differing}`);
    if(a.audio !== b.audio) console.log(`    audio ${hex(a.audio)} vs ${hex(b.audio)}`);
    if(a.state !== b.state || a.stateSize !== b.stateSize) {
      console.log(`    state ${a.stateSize}:${hex(a.state)} vs ${b.stateSize}:${hex(b.state)}`);
    }
    if(a.saveRam !== b.saveRam || a.saveSize !== b.saveSize) {
      console.log(`    battery ${a.saveSize}:${hex(a.saveRam)} vs ${b.saveSize}:${hex(b.saveRam)}`);
    }
  }
}

if(failures) {
  console.log(`\n${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exitCode = 1;
}
