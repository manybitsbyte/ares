//Compares the web build's synchronous Mega Drive scheduling against the cothread scheduler.
//
//There is no batching granularity to sweep, so the reference is a second wasm build of the same
//sources with the PLATFORM_WEB fast paths compiled out:
//
//   emcmake cmake -S . -B build_wasm_md_cothread -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=md -DCMAKE_CXX_FLAGS=-DARES_MD_COTHREAD
//   cmake --build build_wasm_md_cothread --target ares-md-wasm
//
//   node wasm/md-sweep.mjs build_wasm/wasm/ares-md.mjs [build_wasm_md_cothread/wasm/ares-md.mjs] [frames]
//
//Whole concatenated sample streams are compared rather than per-frame hashes: where a frame boundary
//falls is a scheduling detail, and a per-frame hash reports a shift as a difference even when the
//waveform is identical. The comparison also realigns the two streams over a few samples, because the
//two builds can start emitting a frame or two apart. Video is compared frame by frame, which is
//exact regardless. A control run of the web build against itself proves a reported difference is a
//divergence and not run-to-run noise. The golden hashes below are literal so that any future edit to
//VDP::runCycle() fails loudly.
//
//Video is bit-identical to the cothread build in every configuration and that is gated as such, as
//is audio whenever the Z80 is halted.
//
//With the Z80 driving the DAC at roughly one write per YM2612 sample, the streams differ at ~38 dB.
//What is left is a sub-wait quantization the flat catch-up cannot resolve. In the cothread build
//APU::step ends in Thread::synchronize(cpu), so the Z80's bus access happens only once the 68000
//has run past it, and the YM2612 stands at the last of the 68000's bus waits below the Z80's clock;
//1.6% of accesses land in the window where that wait has not yet crossed a sample boundary, leaving
//the YM2612 fractionally behind the Z80. CPU::catchUpOPN2() runs the YM2612 up to the Z80's clock,
//which cannot reproduce that tail without running the 68000 from inside the Z80's catch-up -- which
//is the cothread ping-pong the port exists to remove. The error is bounded and does not drift:
//stream lengths stay equal and video stays exact over 300 frames.
//
//Naming a single module runs the golden check alone, which needs no reference build.
//
//One configuration, z80-rom, is gated on its golden only and says so in its output; the comment
//beside it gives the measurement that decided that.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./md-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm/wasm/ares-md.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
const settleFrames = 20;

//each variant silences one of the four subsystems whose timing the flat VDP stepper and the direct
//catch-ups can perturb, so a divergence points at the one that caused it. minSNR is the floor the
//cothread comparison must clear; null demands bit-equality after realignment.
const configurations = [
  {name: "full", options: {}, minSNR: 34},
  {name: "no-z80", options: {noZ80: true}, minSNR: null},
  {name: "no-hint", options: {noHint: true}, minSNR: 34},
  {name: "no-dma", options: {noDma: true}, minSNR: 34},
  //the four above never make the z80 touch the 68000 bus, which is how a hang in APU::readExternal
  //shipped: the z80's wait for that bus could never end, because on this platform neither the 68000
  //nor the vdp is running while the z80 spins. this one puts a rom read and a rom write through the
  //bank window in the z80's inner loop, gated to one pass in sixteen, so the wait is entered against
  //the vint dma burst. on the build that shipped it does not finish a single frame.
  //
  //it is deliberately not compared against the cothread build. z80 bus stealing is approximated here
  //as a flat 68-Mclk charge on the 68000 (APU::readExternal) rather than as real contention, and any
  //rom that makes the z80 touch the 68000 bus at all measures that approximation far more loudly
  //than it measures scheduling: the same rom with noDma added -- so with this wait never entered and
  //no web-only code on the path -- still reports 68.74% of pixels and 16.8 dB. gating on a number
  //that the change under test cannot move would be gating on nothing. the golden below is the real
  //check, and it is a strong one: it is the whole 300-frame stream of a rom whose z80 is doing what
  //no other configuration makes it do.
  {name: "z80-rom", options: {z80Rom: true}, minSNR: 34, compareReference: false},
];

//recorded at the default 300 frames; the check is skipped for any other frame count.
//the video hashes were rerecorded when ares_md_set_overscan landed and defaulted the border off:
//the picture the ABI hands back is now 1280x224 rather than 1415x243, so the frame being hashed is
//a crop of the one these started as. the audio hashes are unaffected and are the originals.
const golden = {
  "full": {audio: "c1d553c5", video: "7b18f505"},
  "no-z80": {audio: "557407b5", video: "7b18f505"},
  "no-hint": {audio: "b1b254b1", video: "4dc18b65"},
  "no-dma": {audio: "6e467b51", video: "b4904735"},
  "z80-rom": {audio: "83244d51", video: "0701044d"},
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
  const rom = buildStressRom(options);

  const pointer = module._ares_md_alloc(rom.length);
  module.HEAPU8.set(rom, pointer);
  module._ares_md_set_audio_frequency(48000);
  const loaded = module._ares_md_load(pointer, rom.length);
  module._ares_md_free(pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_md_error()));

  for(let frame = 0; frame < settleFrames; frame++) module._ares_md_run_frame();

  //absent unless built with -DARES_WASM_DEBUG=ON; the delta is then reported as null rather than 0
  const switchesBefore = module._ares_md_switch_count?.() ?? 0;
  const audio = [];
  const video = [];
  const start = performance.now();
  for(let frame = 0; frame < measureFrames; frame++) {
    //deterministic input schedule exercising the pad multiplexer, and with it the controller
    //cothreads that CPU::catchUpAuxiliary advances by plain calls
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

  //the dimensions are hashed alongside the pixels: a resolution change is a divergence, not a
  //byte count to be inferred
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

//the two builds can begin emitting a stereo frame or two apart, which offsets the whole stream; try
//a small window of alignments and report the best one, so a constant lead never reads as divergence
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

for(const {name, options, minSNR, compareReference = true} of configurations) {
  const web = await run(createWeb, options);
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
  report({configuration: name, build: "web-control", ...compare(web, await run(createWeb, options))});

  //a configuration that opts out still says so in the output, so a skipped comparison is never
  //mistaken for one that ran and passed
  if(createReference && !compareReference) {
    console.log(JSON.stringify({configuration: name, build: "web-vs-cothread", compared: "skipped",
      reason: "measures the flat stolenMcycles charge for z80 bus stealing, not scheduling"}));
  }

  if(createReference && compareReference) {
    const reference = await run(createReference, options);
    report({configuration: name, build: "cothread", ...reference});
    const difference = compare(reference, web);
    const audioOk = difference.audio === "identical"
      || (minSNR !== null && difference.audioSNR >= minSNR);
    if(!audioOk || difference.screen !== "identical") failures++;
    report({configuration: name, build: "web-vs-cothread", audioFloor: minSNR, ...difference});
  }
}

if(failures) {
  console.error(`${failures} comparison(s) failed`);
  process.exit(1);
}
