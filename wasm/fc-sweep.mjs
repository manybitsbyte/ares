//Fidelity check for the web build's NES core: boots the stress ROM and hashes what came out.
//
//   node wasm/fc-sweep.mjs build_wasm/wasm/ares-fc.mjs [dmc|nodmc|both] [frames]
//
//Each variant is run twice in fresh module instances. Run two is compared against run one, which
//catches nondeterminism in the core itself; the printed hashes are what a comparison across builds
//is made from -- record them before a change and diff them after. Audio is hashed as one
//concatenated stream rather than per frame, because a shift in where a frame boundary falls would
//otherwise read as a difference even when the waveform is identical. Video is hashed frame by
//frame, which is exact regardless.
//
//Frame times are only worth quoting from a run of a single variant: a later instance runs under the
//GC pressure of every retained buffer before it.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {buildStressRom} from "./fc-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-fc.mjs"));
const which = process.argv[3] ?? "both";
const measureFrames = Number(process.argv[4]) || 180;
const settleFrames = 30;
const {default: createAresFc} = await import(moduleUrl);

async function run(dmc) {
  const rom = buildStressRom({dmc});
  const module = await createAresFc({
    locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
  });
  const pointer = module._ares_fc_alloc(rom.length);
  module.HEAPU8.set(rom, pointer);
  module._ares_fc_set_audio_frequency(44100);
  const loaded = module._ares_fc_load(pointer, rom.length);
  module._ares_fc_free(pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_fc_error()));

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

  const audioHash = createHash("sha256").update(new Uint8Array(samples.buffer)).digest("hex");
  const videoHash = createHash("sha256");
  for(const frame of video) videoHash.update(frame);

  return {
    dmc,
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: Math.round(switches / measureFrames),
    audioHash: audioHash.slice(0, 16),
    videoHash: videoHash.digest("hex").slice(0, 16),
    samples, video,
  };
}

function compare(reference, candidate) {
  const delta = candidate.samples.length - reference.samples.length;
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
  //a length mismatch is a difference in its own right; the per-sample walk cannot see it
  const lengths = delta === 0 ? "" : `, ${delta > 0 ? "+" : ""}${delta} samples`;
  return {
    audio: differing === 0 && delta === 0 ? "identical"
      : `${(100 * differing / count).toFixed(1)}% differ, ${(10 * Math.log10(signal / noise)).toFixed(1)} dB SNR${lengths}`,
    screen: framesDiffering === 0 ? "identical"
      : `${framesDiffering}/${reference.video.length} frames, ${(100 * pixelsDiffering / pixelsTotal).toFixed(2)}% of pixels`,
  };
}

const report = ({samples, video, ...rest}) => console.log(JSON.stringify(rest));

for(const dmc of which === "both" ? [true, false] : [which !== "nodmc"]) {
  const reference = await run(dmc);
  report(reference);
  if(reference.samples.every(sample => sample === 0)) {
    throw new Error("the stress ROM produced silence; the comparison would be vacuous");
  }
  const repeat = await run(dmc);
  report({...repeat, ...compare(reference, repeat), repeat: true});
}
