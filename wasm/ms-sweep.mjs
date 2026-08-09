//Compares the web build's synchronous Master System scheduling against the cothread scheduler.
//
//The other cores sweep a batching granularity; this one has none to sweep, so the reference is a
//second wasm build of the same sources with the PLATFORM_WEB fast paths compiled out:
//
//   emcmake cmake -S . -B build_wasm_cothread -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=ms -DCMAKE_CXX_FLAGS=-DARES_MS_COTHREAD
//   cmake --build build_wasm_cothread --target ares-ms-wasm
//
//   node wasm/ms-sweep.mjs build_wasm/wasm/ares-ms.mjs [build_wasm_cothread/wasm/ares-ms.mjs] [frames]
//
//Whole concatenated sample streams are compared rather than per-frame hashes: where a frame boundary
//falls is a scheduling detail, and a per-frame hash reports a shift as a difference even when the
//waveform is identical. Video is compared frame by frame, which is exact regardless. A control run
//of the web build against itself proves a reported difference is a divergence and not run-to-run
//noise. The golden hashes below are literal so that any future edit to VDP::runCycle() fails loudly.
//
//Naming a single module runs the golden check alone, which needs no reference build.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./ms-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm/wasm/ares-ms.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
const settleFrames = 20;

//region and model both matter: only the NTSC-J machines carry an OPLL, and only the revision-2 VDP
//they lack has a vlines() that a mid-scanline register write can move.
const configurations = [
  {name: "master-system-ntsc-u", model: "[Sega] Master System (NTSC-U)"},
  {name: "master-system-pal", model: "[Sega] Master System (PAL)"},
  {name: "mark-iii-ntsc-j-fm", model: "[Sega] Mark III (NTSC-J)"},
  {name: "master-system-ntsc-j-fm", model: "[Sega] Master System (NTSC-J)"},
];

//recorded at the default 300 frames; the check is skipped for any other frame count
const golden = {
  "master-system-ntsc-u": {audio: "aef31709", video: "1c9d313d"},
  "master-system-pal": {audio: "e08791d9", video: "cc09e945"},
  "mark-iii-ntsc-j-fm": {audio: "1100c20d", video: "b2da3675"},
  "master-system-ntsc-j-fm": {audio: "c93b1dad", video: "b2da3675"},
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

async function run(create, model) {
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

  const switchesBefore = module._ares_ms_switch_count();
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
  const switches = (module._ares_ms_switch_count() - switchesBefore) >>> 0;
  module._ares_ms_unload();

  const samples = new Float32Array(audio.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }

  let videoHash = 2166136261;
  for(const frame of video) videoHash = fnv1a(videoHash, frame);

  return {
    model,
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: Math.round(switches / measureFrames),
    audioHash: hex(fnv1a(2166136261, new Uint8Array(samples.buffer))),
    videoHash: hex(videoHash),
    samples, video,
  };
}

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
  return {
    lengths: reference.samples.length === candidate.samples.length ? "equal"
      : `${reference.samples.length} vs ${candidate.samples.length}`,
    audio: differing === 0 ? "identical"
      : `${(100 * differing / count).toFixed(1)}% differ, ${(10 * Math.log10(signal / noise)).toFixed(1)} dB SNR`,
    screen: framesDiffering === 0 ? "identical"
      : `${framesDiffering}/${reference.video.length} frames, ${(100 * pixelsDiffering / pixelsTotal).toFixed(2)}%`
        + ` of pixels, first at frame ${firstFrame.frame} pixel ${firstFrame.pixel}`,
  };
}

const report = ({samples, video, ...rest}) => console.log(JSON.stringify(rest));

const createWeb = await load(webPath);
const createReference = referencePath ? await load(referencePath) : null;
let failures = 0;

for(const {name, model} of configurations) {
  const web = await run(createWeb, model);
  report({configuration: name, build: "web", ...web});

  if(web.samples.every(sample => sample === 0)) {
    console.log(JSON.stringify({configuration: name, error: "silence; the audio comparison is vacuous"}));
    failures++;
  }

  const expected = measureFrames === 300 ? golden[name] : null;
  if(expected) {
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
    if(difference.audio !== "identical" || difference.screen !== "identical") failures++;
    report({configuration: name, build: "web-vs-cothread", ...difference});
  }
}

if(failures) {
  console.error(`${failures} comparison(s) failed`);
  process.exit(1);
}
