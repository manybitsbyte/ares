//Compares the web build's synchronous Game Gear scheduling against the cothread scheduler.
//
//Game Gear is not a core of its own: it is ares/ms/ selected with ares_ms_set_model, so both
//arguments below are ares-ms.mjs and what differs is the build directory they come from. The
//reference is a second wasm build of the same sources with the PLATFORM_WEB fast paths compiled out:
//
//   emcmake cmake -S . -B build_wasm_ms_cothread -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=ms -DCMAKE_CXX_FLAGS=-DARES_MS_COTHREAD
//   cmake --build build_wasm_ms_cothread --target ares-ms-wasm
//
//   node wasm/gg-sweep.mjs build_wasm/wasm/ares-ms.mjs [build_wasm_ms_cothread/wasm/ares-ms.mjs] [frames]
//
//Run from the repo root, with both module arguments.
//
//Whole concatenated sample streams are compared rather than per-frame hashes: where a frame boundary
//falls is a scheduling detail, and a per-frame hash reports a shift as a difference even when the
//waveform is identical. Video is compared frame by frame, which is exact regardless. A control run
//of the web build against itself proves a reported difference is a divergence and not run-to-run
//noise. The golden hashes below are literal so that any future edit to VDP::runCycle() fails loudly.
//
//Two things here that wasm/ms-sweep.mjs does not have, both from the gba sweep:
//  - the bytes of a synchronized save state are compared per row, so a divergence that has not yet
//    reached a pixel is still caught;
//  - an `after-a-save-state` row keeps comparing for the same frame count once a state has been
//    taken, because taking one runs the scheduler to a safe point and that is its own scheduling
//    path.
//
//Naming a single module runs the golden check alone, which needs no reference build.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./gg-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm/wasm/ares-ms.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
const settleFrames = 20;

//region is the whole difference here: a Game Gear's port 0x00 reports the PAL and NTSC-J straps
//(ares/ms/cpu/memory.cpp:37-46), and the stress cartridge reads that port into RAM every iteration,
//so the two configurations reach different machine state through a path the picture alone would not
//show. There is no Master-System-mode row: mia sets that strap from a ".sms" extension
//(mia/medium/game-gear.cpp:57) and this ABI resolves the path from the model, so it is unreachable.
const configurations = [
  {name: "game-gear-ntsc-u", model: "[Sega] Game Gear (NTSC-U)"},
  {name: "game-gear-ntsc-j", model: "[Sega] Game Gear (NTSC-J)"},
];

//recorded at the default 300 frames; the check is skipped for any other frame count.
//the two regions share a picture and a waveform and differ only in machine state, which is what the
//per-row state comparison below is for: port 0x00's region straps reach RAM but never a pixel.
const golden = {
  "game-gear-ntsc-u": {audio: "38681ac5", video: "47f96a45"},
  "game-gear-ntsc-j": {audio: "38681ac5", video: "47f96a45"},
};

const rom = buildStressRom();

function fnv1a(hash, bytes) {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
}

const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");

async function load(path) {
  const url = pathToFileURL(resolve(path));
  const {default: create} = await import(url);
  return () => create({locateFile: name => fileURLToPath(new URL(name, url))});
}

//takeState runs the scheduler to a safe point after settling and keeps the resulting bytes, so the
//frames measured afterwards are the ones a machine that has just been saved produces
async function run(create, model, {takeState = false} = {}) {
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

  for(let frame = 0; frame < settleFrames; frame++) module._ares_ms_run_frame();

  //a synchronized save; the bytes are copied out at once because memory growth invalidates views
  let stateBytes = null;
  if(takeState) {
    module._ares_ms_state_save(1);
    const size = module._ares_ms_state_size();
    const data = module._ares_ms_state_data();
    if(!size || !data) throw new Error("a synchronized save produced no bytes");
    stateBytes = new Uint8Array(module.HEAPU8.buffer, data, size).slice();
  }

  //absent unless built with -DARES_WASM_DEBUG=ON; the delta is then reported as null rather than 0
  const switchesBefore = module._ares_ms_switch_count?.() ?? 0;
  const audio = [];
  const video = [];
  const start = performance.now();
  for(let frame = 0; frame < measureFrames; frame++) {
    module._ares_ms_run_frame();
    const frames = module._ares_ms_audio_frames();
    audio.push(new Float32Array(module.HEAPU8.buffer, module._ares_ms_audio_data(), frames * 2).slice());
    const width = module._ares_ms_video_width(), height = module._ares_ms_video_height();
    video.push(new Uint8Array(module.HEAPU8.buffer, module._ares_ms_video_data(), width * height * 4).slice());
  }
  const elapsed = performance.now() - start;
  const switches = module._ares_ms_switch_count
    ? (module._ares_ms_switch_count() - switchesBefore) >>> 0 : null;

  //the state that ends the run, so a comparison can catch a divergence the pixels have not shown yet
  module._ares_ms_state_save(1);
  const finalSize = module._ares_ms_state_size();
  const finalData = module._ares_ms_state_data();
  const finalState = finalSize && finalData
    ? new Uint8Array(module.HEAPU8.buffer, finalData, finalSize).slice() : null;

  const videoWidth = module._ares_ms_video_width();
  const videoHeight = module._ares_ms_video_height();
  module._ares_ms_unload();

  const samples = new Float32Array(audio.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }

  let videoHash = 2166136261;
  for(const frame of video) videoHash = fnv1a(videoHash, frame);

  //a stress ROM that never ran, compared against a reference build that also never ran it, agrees
  //perfectly and proves nothing. If every measured frame is byte-identical to the first, say so.
  const staticPicture = video.every(frame => frame.length === video[0].length
    && frame.every((byte, index) => byte === video[0][index]));

  return {
    model,
    videoWidth, videoHeight,
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: switches === null ? null : Math.round(switches / measureFrames),
    audioHash: hex(fnv1a(2166136261, new Uint8Array(samples.buffer))),
    videoHash: hex(videoHash),
    stateHash: finalState ? hex(fnv1a(2166136261, finalState)) : null,
    staticPicture,
    samples, video, stateBytes, finalState,
  };
}

const bytesEqual = (a, b) =>
  !!a && !!b && a.length === b.length && a.every((byte, index) => byte === b[index]);

function compare(reference, candidate) {
  const count = Math.min(reference.samples.length, candidate.samples.length);
  let differing = 0, noise = 0, signal = 0;
  for(let index = 0; index < count; index++) {
    const a = reference.samples[index], b = candidate.samples[index];
    if(a !== b) differing++;
    noise += (a - b) ** 2;
    signal += a ** 2;
  }
  let framesDiffering = 0, pixelsDiffering = 0, pixelsTotal = 0, firstFrame = null;
  reference.video.forEach((frame, index) => {
    const other = candidate.video[index];
    pixelsTotal += frame.length / 4;
    if(!other || other.length !== frame.length) { framesDiffering++; return; }
    let differingHere = 0;
    for(let pixel = 0; pixel < frame.length; pixel += 4) {
      if(frame[pixel + 0] !== other[pixel + 0] || frame[pixel + 1] !== other[pixel + 1]
      || frame[pixel + 2] !== other[pixel + 2] || frame[pixel + 3] !== other[pixel + 3]) {
        if(firstFrame === null) firstFrame = {frame: index, pixel: pixel / 4};
        differingHere++;
      }
    }
    if(differingHere) framesDiffering++;
    pixelsDiffering += differingHere;
  });
  //the discriminating half: two builds can paint the same pixels from machines that differ
  const state = bytesEqual(reference.finalState, candidate.finalState) ? "identical"
    : reference.finalState && candidate.finalState
      ? (reference.finalState.length !== candidate.finalState.length
        ? `${reference.finalState.length} vs ${candidate.finalState.length} bytes`
        : `${reference.finalState.reduce((n, byte, i) => n + (byte !== candidate.finalState[i]), 0)} bytes differ`)
      : "unavailable";
  return {
    lengths: reference.samples.length === candidate.samples.length ? "equal"
      : `${reference.samples.length} vs ${candidate.samples.length}`,
    audio: differing === 0 ? "identical"
      : `${(100 * differing / count).toFixed(1)}% differ, ${(10 * Math.log10(signal / noise)).toFixed(1)} dB SNR`,
    screen: framesDiffering === 0 ? "identical"
      : `${framesDiffering}/${reference.video.length} frames, ${(100 * pixelsDiffering / pixelsTotal).toFixed(2)}%`
        + ` of pixels, first at frame ${firstFrame.frame} pixel ${firstFrame.pixel}`,
    state,
  };
}

const report = ({samples, video, stateBytes, finalState, ...rest}) => console.log(JSON.stringify(rest));

const createWeb = await load(webPath);
const createReference = referencePath ? await load(referencePath) : null;
let failures = 0;
const fail = message => { console.log(JSON.stringify({error: message})); failures++; };

for(const {name, model} of configurations) {
  const web = await run(createWeb, model);
  report({configuration: name, build: "web", ...web});

  if(web.videoWidth !== 160 || web.videoHeight !== 144) {
    fail(`${name}: expected a 160x144 picture, got ${web.videoWidth}x${web.videoHeight}`);
  }
  if(web.samples.every(sample => sample === 0)) {
    fail(`${name}: silence; the audio comparison is vacuous`);
  }
  //the Game Gear is the only machine in this core with two sides; if they never differ, port 0x06
  //reached nothing and every stereo claim is vacuous
  let stereoDiffering = 0;
  for(let index = 0; index + 1 < web.samples.length; index += 2) {
    if(web.samples[index] !== web.samples[index + 1]) stereoDiffering++;
  }
  if(!stereoDiffering) fail(`${name}: both stereo sides are identical; port 0x06 reached nothing`);
  if(web.staticPicture) fail(`${name}: every measured frame is identical; the cartridge never ran`);

  const expected = measureFrames === 300 ? golden[name] : null;
  if(expected && expected.audio !== "PENDING") {
    const ok = expected.audio === web.audioHash && expected.video === web.videoHash;
    if(!ok) failures++;
    console.log(JSON.stringify({configuration: name, golden: ok ? "match" : "MISMATCH", expected}));
  }

  //a second web run, to show the comparison below measures scheduling and not run-to-run noise
  report({configuration: name, build: "web-control", ...compare(web, await run(createWeb, model))});

  if(createReference) {
    const reference = await run(createReference, model);
    report({configuration: name, build: "cothread", ...reference});
    const difference = compare(reference, web);
    if(difference.audio !== "identical" || difference.screen !== "identical"
    || difference.state !== "identical") failures++;
    report({configuration: name, build: "web-vs-cothread", ...difference});

    //and again, on machines that have just been run to a safe point and saved
    const webSaved = await run(createWeb, model, {takeState: true});
    const referenceSaved = await run(createReference, model, {takeState: true});
    if(!bytesEqual(webSaved.stateBytes, referenceSaved.stateBytes)) {
      fail(`${name}: the synchronized save states of the two builds differ`);
    }
    const afterSave = compare(referenceSaved, webSaved);
    if(afterSave.audio !== "identical" || afterSave.screen !== "identical"
    || afterSave.state !== "identical") failures++;
    report({configuration: name, build: "after-a-save-state", ...afterSave});
  }
}

if(failures) {
  console.error(`${failures} comparison(s) failed`);
  process.exit(1);
}
