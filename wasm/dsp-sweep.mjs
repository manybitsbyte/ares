//Measures what batched SMP/DSP synchronization actually costs in output fidelity.
//
//For each granularity this runs the DSP stress ROM from a cold power-on, concatenates every stereo
//sample the core emits, and compares that stream against the cycle-exact reference. Comparing whole
//streams rather than per-frame hashes matters: batching shifts where a frame boundary falls, so a
//per-frame hash reports a difference even when the waveform is identical.
//
//  node wasm/dsp-sweep.mjs build_wasm/wasm/ares-sfc.mjs [frames]

import {fileURLToPath, pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {buildDspStressRom} from "./dsp-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-sfc.mjs"));
const {default: createAresSfc} = await import(moduleUrl);
const FRAMES = Number(process.argv[3] ?? 300);
const GRANULARITIES = [4, 8, 16, 32, 64, 128];
const SAMPLE_RATE = 48000;

async function capture(mode, granularity) {
  const core = await createAresSfc({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});
  core._ares_sfc_set_dsp_sync_granularity(granularity);
  core._ares_sfc_set_audio_frequency(SAMPLE_RATE);

  const rom = buildDspStressRom(mode);
  const pointer = core._ares_sfc_alloc(rom.length);
  core.HEAPU8.set(rom, pointer);
  const loaded = core._ares_sfc_load(pointer, rom.length);
  core._ares_sfc_free(pointer);
  if(!loaded) throw new Error(core.UTF8ToString(core._ares_sfc_error()));

  const chunks = [];
  const video = createHash("sha1");
  let frames = 0;
  for(let frame = 0; frame < FRAMES; frame++) {
    core._ares_sfc_run_frame();
    const width = core._ares_sfc_video_width();
    const height = core._ares_sfc_video_height();
    video.update(Buffer.from(core.HEAPU8.buffer, core._ares_sfc_video_data(), width * height * 4));
    const count = core._ares_sfc_audio_frames();
    frames += count;
    chunks.push(Float32Array.from(
      new Float32Array(core.HEAPU8.buffer, core._ares_sfc_audio_data(), count * 2)
    ));
  }
  const audio = new Float32Array(frames * 2);
  let offset = 0;
  for(const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }

  const started = performance.now();
  for(let frame = 0; frame < 120; frame++) core._ares_sfc_run_frame();
  const fps = 120000 / (performance.now() - started);

  return {audio, frames, video: video.digest("hex").slice(0, 12), fps};
}

function compare(reference, candidate) {
  const common = Math.min(reference.frames, candidate.frames) * 2;
  let differing = 0, peak = 0, first = -1, errorEnergy = 0, signalEnergy = 0;
  for(let i = 0; i < common; i++) {
    const delta = Math.abs(reference.audio[i] - candidate.audio[i]);
    if(delta > 0) {
      differing++;
      if(first < 0) first = i;
      if(delta > peak) peak = delta;
    }
    errorEnergy += delta * delta;
    signalEnergy += reference.audio[i] * reference.audio[i];
  }
  if(!differing) return "identical";
  const snr = 10 * Math.log10(signalEnergy / errorEnergy);
  return `${(100 * differing / common).toFixed(2)}% of samples differ, `
    + `peak ${peak.toExponential(2)}, SNR ${snr.toFixed(1)} dB, `
    + `first at ${(first / 2 / SAMPLE_RATE).toFixed(3)}s`;
}

//Guard against the failure that made the original smoke-ROM comparison meaningless: if the DSP is
//not actually producing signal, "identical" is vacuous rather than reassuring.
function assertNonTrivial(capture, mode) {
  let energy = 0, peak = 0;
  for(const sample of capture.audio) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
  const rms = Math.sqrt(energy / capture.audio.length);
  if(rms < 1e-3) throw new Error(`${mode}: reference audio is silence (rms ${rms.toExponential(2)}) — the comparison would prove nothing`);
  return {rms, peak};
}

for(const mode of ["static", "streaming"]) {
  const reference = await capture(mode, 1);
  const {rms, peak} = assertNonTrivial(reference, mode);
  console.log(`\n=== ${mode} === (reference rms ${rms.toFixed(3)}, peak ${peak.toFixed(3)})`);
  console.log(`  g=  1  video ${reference.video}  ${reference.fps.toFixed(1).padStart(6)} fps  reference`);
  for(const granularity of GRANULARITIES) {
    const candidate = await capture(mode, granularity);
    const drift = candidate.video === reference.video ? "" : "  VIDEO DIFFERS";
    console.log(`  g=${String(granularity).padStart(3)}  video ${candidate.video}  `
      + `${candidate.fps.toFixed(1).padStart(6)} fps  ${compare(reference, candidate)}${drift}`);
  }
}
