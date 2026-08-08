//Sweeps the web build's NES sync granularities against cycle-exact.
//
//Compares whole concatenated sample streams rather than per-frame hashes: batching shifts where a
//frame boundary falls, and a per-frame hash reports that as a difference even when the waveform is
//identical. Video is compared frame by frame, which is exact regardless.
//
//   node wasm/fc-sweep.mjs build_wasm/wasm/ares-fc.mjs [apu|ppu|both] [dmc|nodmc] [granularity...]
//
//Fidelity is comparable across a whole sweep in one process. Frame times are not -- each
//granularity brings up a fresh module instance, and the later ones run under the GC pressure of all
//the retained sample and video buffers. Name a single granularity to get a timing worth quoting.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./fc-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-fc.mjs"));
const axis = process.argv[3] ?? "both";
const {default: createAresFc} = await import(moduleUrl);

const rom = buildStressRom({dmc: process.argv[4] !== "nodmc"});
const settleFrames = 30;
const measureFrames = 180;

async function run(apu, ppu) {
  const module = await createAresFc({
    locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
  });
  const pointer = module._ares_fc_alloc(rom.length);
  module.HEAPU8.set(rom, pointer);
  module._ares_fc_set_audio_frequency(44100);
  const loaded = module._ares_fc_load(pointer, rom.length);
  module._ares_fc_free(pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_fc_error()));
  module._ares_fc_set_apu_sync_granularity(apu);
  module._ares_fc_set_ppu_sync_granularity(ppu);

  for(let frame = 0; frame < settleFrames; frame++) module._ares_fc_run_frame();

  const switchesBefore = module._ares_fc_switch_count();
  const audio = [];
  const video = [];
  const start = performance.now();
  for(let frame = 0; frame < measureFrames; frame++) {
    module._ares_fc_run_frame();
    const frames = module._ares_fc_audio_frames();
    audio.push(new Float32Array(module.HEAPU8.buffer, module._ares_fc_audio_data(), frames * 2).slice());
    const width = module._ares_fc_video_width(), height = module._ares_fc_video_height();
    video.push(new Uint8Array(module.HEAPU8.buffer, module._ares_fc_video_data(), width * height * 4).slice());
  }
  const elapsed = performance.now() - start;
  const switches = (module._ares_fc_switch_count() - switchesBefore) >>> 0;
  module._ares_fc_unload();

  const samples = new Float32Array(audio.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }

  return {
    apu, ppu,
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: Math.round(switches / measureFrames),
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
  let framesDiffering = 0, pixelsDiffering = 0, pixelsTotal = 0;
  reference.video.forEach((frame, index) => {
    const other = candidate.video[index];
    pixelsTotal += frame.length / 4;
    if(!other || other.length !== frame.length) { framesDiffering++; return; }
    let differingHere = 0;
    for(let pixel = 0; pixel < frame.length; pixel += 4) {
      if(frame[pixel + 0] !== other[pixel + 0] || frame[pixel + 1] !== other[pixel + 1]
      || frame[pixel + 2] !== other[pixel + 2] || frame[pixel + 3] !== other[pixel + 3]) differingHere++;
    }
    if(differingHere) framesDiffering++;
    pixelsDiffering += differingHere;
  });
  return {
    audio: differing === 0 ? "identical"
      : `${(100 * differing / count).toFixed(1)}% differ, ${(10 * Math.log10(signal / noise)).toFixed(1)} dB SNR`,
    screen: framesDiffering === 0 ? "identical"
      : `${framesDiffering}/${reference.video.length} frames, ${(100 * pixelsDiffering / pixelsTotal).toFixed(2)}% of pixels`,
  };
}

const report = ({samples, video, ...rest}) => console.log(JSON.stringify(rest));

//`bench` measures one configuration in a fresh process and reports nothing else, so the number is
//not skewed by the instances a fidelity sweep leaves behind.
if(axis === "bench") {
  const [apu = 1, ppu = apu] = process.argv.slice(5).map(Number);
  report(await run(apu, ppu));
  process.exit(0);
}

const reference = await run(1, 1);
report(reference);
if(reference.samples.every(sample => sample === 0)) {
  throw new Error("the stress ROM produced silence; the comparison would be vacuous");
}

//a second cycle-exact run, to show the comparison is measuring granularity and not run-to-run noise
report({...(await run(1, 1)), ...compare(reference, await run(1, 1)), control: true});

const requested = process.argv.slice(5).map(Number).filter(value => value >= 1);
const granularities = requested.length ? requested : [2, 3, 4, 6, 8, 12, 16, 32];
for(const granularity of granularities) {
  const apu = axis === "ppu" ? 1 : granularity;
  const ppu = axis === "apu" ? 1 : granularity;
  const result = await run(apu, ppu);
  report({...result, ...compare(reference, result)});
}
