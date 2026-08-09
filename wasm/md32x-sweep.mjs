//Compares the web build's synchronous Mega Drive scheduling against the cothread scheduler with a
//32X attached. Same shape as wasm/md-sweep.mjs -- a second wasm build of the same sources with the
//PLATFORM_WEB fast paths compiled out is the reference:
//
//   emcmake cmake -S . -B build_wasm_md_cothread -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=md -DCMAKE_CXX_FLAGS=-DARES_MD_COTHREAD
//   cmake --build build_wasm_md_cothread --target ares-md-wasm
//
//   node wasm/md32x-sweep.mjs build_wasm/wasm/ares-md.mjs [build_wasm_md_cothread/wasm/ares-md.mjs] [frames]
//
//The 32X question the web build raises is whether a chip advanced by plain calls on the 68000's
//cothread is still observed correctly by a coprocessor that is on its own cothread, and whether
//CPU::catchUpAuxiliary()'s minCyclesBetweenSyncs throttle (14 on a 32X, 0 on a plain Mega Drive)
//paces the coprocessor threads the way the native full synchronize does. The workload has no SH2
//program, so the audio here is Mega Drive PSG only and bit-equality is demanded of both streams.
//
//The variants exist to prove the comparison discriminates: dropping the 32X layer, the 32X palette
//writes, or the i/o-sourced dma must change the hashes, and the sweep fails if any of them does not.
//
//Known limit: "sh2" only releases the SH2s from reset. ares supplies the SH2 boot roms but the
//68000 half of the MARS security handshake lives in the cartridge, so with no such program both
//SH2s sit in the boot rom's wait loop at PC 0x190 and never read the cartridge. Their cothreads are
//scheduled -- 92,000 switches per frame against 1,726 -- but no SH2-initiated access to the 32X
//vdp, framebuffer or palette is covered by this harness.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {build32xRom} from "./md32x-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm/wasm/ares-md.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
const settleFrames = 20;

const configurations = [
  {name: "full", options: {}},
  {name: "sh2", options: {sh2: true}},
  {name: "dma-from-io", options: {dmaFromIO: true}},
  {name: "no-32x-palette", options: {no32xPalette: true}},
  {name: "no-32x-layer", options: {no32xLayer: true}},
];

//recorded at the default 300 frames; the check is skipped for any other frame count
const golden = {
  "full":           {audio: "b45f42f1", video: "29e912fd"},
  "sh2":            {audio: "b45f42f1", video: "29e912fd"},
  "dma-from-io":    {audio: "b45f42f1", video: "c2a0ca25"},
  "no-32x-palette": {audio: "b45f42f1", video: "6762e1cd"},
  "no-32x-layer":   {audio: "b45f42f1", video: "d7b7c3cd"},
};

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

async function run(create, options) {
  const module = await create();
  const rom = build32xRom(options);

  const pointer = module._ares_md_alloc(rom.length);
  module.HEAPU8.set(rom, pointer);
  module._ares_md_set_audio_frequency(48000);
  const loaded = module._ares_md_load_32x(pointer, rom.length);
  module._ares_md_free(pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_md_error()));

  for(let frame = 0; frame < settleFrames; frame++) module._ares_md_run_frame();

  //absent unless built with -DARES_WASM_DEBUG=ON; the delta is then reported as null rather than 0
  const switchesBefore = module._ares_md_switch_count?.() ?? 0;
  const audio = [];
  const video = [];
  const start = performance.now();
  for(let frame = 0; frame < measureFrames; frame++) {
    module._ares_md_set_input(0, frame & 32 ? (frame & 16 ? 0x71 : 0x86) : 0);
    module._ares_md_run_frame();
    const frames = module._ares_md_audio_frames();
    audio.push(new Float32Array(module.HEAPU8.buffer, module._ares_md_audio_data(), frames * 2).slice());
    const width = module._ares_md_video_width(), height = module._ares_md_video_height();
    video.push({width, height,
      pixels: new Uint8Array(module.HEAPU8.buffer, module._ares_md_video_data(), width * height * 4).slice()});
  }
  const elapsed = performance.now() - start;
  const switches = module._ares_md_switch_count
    ? (module._ares_md_switch_count() - switchesBefore) >>> 0 : null;
  module._ares_md_unload();

  const samples = new Float32Array(audio.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }

  let videoHash = 2166136261;
  for(const frame of video) {
    videoHash = fnv1a(videoHash, new Uint8Array(Uint32Array.of(frame.width, frame.height).buffer));
    videoHash = fnv1a(videoHash, frame.pixels);
  }

  return {
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: switches === null ? null : Math.round(switches / measureFrames),
    audioHash: hex(fnv1a(2166136261, new Uint8Array(samples.buffer))),
    videoHash: hex(videoHash),
    samples, video,
  };
}

const alignments = [0, -2, 2, -4, 4, -6, 6, -8, 8];

function align(reference, candidate) {
  let best = null;
  for(const shift of alignments) {
    let differing = 0, noise = 0, signal = 0, count = 0;
    for(let index = Math.max(0, -shift); index < reference.length; index++) {
      const b = candidate[index + shift];
      if(b === undefined) break;
      const a = reference[index];
      if(a !== b) differing++;
      noise += (a - b) ** 2;
      signal += a ** 2;
      count++;
    }
    if(!best || noise < best.noise) best = {shift, differing, noise, signal, count};
  }
  return best;
}

function compare(reference, candidate) {
  const {shift, differing, noise, signal, count} = align(reference.samples, candidate.samples);
  const snr = 10 * Math.log10(signal / noise);
  let framesDiffering = 0, pixelsDiffering = 0, pixelsTotal = 0, firstFrame = null;
  reference.video.forEach((frame, index) => {
    const other = candidate.video[index];
    pixelsTotal += frame.pixels.length / 4;
    if(!other || other.width !== frame.width || other.height !== frame.height) { framesDiffering++; return; }
    let differingHere = 0;
    for(let pixel = 0; pixel < frame.pixels.length; pixel += 4) {
      if(frame.pixels[pixel + 0] !== other.pixels[pixel + 0] || frame.pixels[pixel + 1] !== other.pixels[pixel + 1]
      || frame.pixels[pixel + 2] !== other.pixels[pixel + 2] || frame.pixels[pixel + 3] !== other.pixels[pixel + 3]) {
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
    audioShift: shift,
    audioSNR: differing === 0 ? null : +snr.toFixed(1),
    audio: differing === 0 ? "identical"
      : `${(100 * differing / count).toFixed(1)}% differ, ${snr.toFixed(1)} dB SNR`,
    screen: framesDiffering === 0 ? "identical"
      : `${framesDiffering}/${reference.video.length} frames, ${(100 * pixelsDiffering / pixelsTotal).toFixed(2)}%`
        + ` of pixels, first at frame ${firstFrame.frame} pixel ${firstFrame.pixel}`,
  };
}

const report = ({samples, video, ...rest}) => console.log(JSON.stringify(rest));

const createWeb = await load(webPath);
const createReference = referencePath ? await load(referencePath) : null;
let failures = 0;
const hashes = new Map();

for(const {name, options} of configurations) {
  const web = await run(createWeb, options);
  report({configuration: name, build: "web", ...web});
  hashes.set(name, `${web.videoHash}/${web.audioHash}`);

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

  report({configuration: name, build: "web-control", ...compare(web, await run(createWeb, options))});

  if(createReference) {
    const reference = await run(createReference, options);
    report({configuration: name, build: "cothread", ...reference});
    const difference = compare(reference, web);
    if(difference.audio !== "identical" || difference.screen !== "identical") failures++;
    report({configuration: name, build: "web-vs-cothread", ...difference});
  }
}

//a variant that hashes the same as "full" is not testing what its name says it is. "sh2" is
//deliberately absent: the sh2s run their boot rom, which never reaches the display, so it is a
//scheduling variant rather than an output variant and is expected to hash like "full".
for(const name of ["dma-from-io", "no-32x-palette", "no-32x-layer"]) {
  if(hashes.get(name) === hashes.get("full")) {
    console.log(JSON.stringify({configuration: name, error: "hashes match full; the variant is inert"}));
    failures++;
  }
}

if(failures) {
  console.error(`${failures} comparison(s) failed`);
  process.exit(1);
}
