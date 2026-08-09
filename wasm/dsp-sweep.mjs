//Fidelity regression check for the SNES DSP.
//
//Boots the DSP stress ROM from a cold power-on and hashes the whole concatenated stereo sample
//stream plus every framebuffer, then compares both against literal golden hashes recorded from a
//known-good build. The hashes are literals rather than a same-build reference on purpose: a
//self-referential comparison is blind to a regression in the code under test, which here is
//DSP::runCycle() — the part most likely to rot.
//
//  node wasm/dsp-sweep.mjs build_wasm/wasm/ares-sfc.mjs [frames]
//
//Golden hashes are for the default 300 frames; a different frame count only reports.

import {fileURLToPath, pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {buildDspStressRom} from "./dsp-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-sfc.mjs"));
const {default: createAresSfc} = await import(moduleUrl);
const FRAMES = Number(process.argv[3] ?? 300);
const SAMPLE_RATE = 48000;

//recorded from the cothread reference build; running output must never change
const GOLDEN = {
  static:    {audio: "4873b27cc88b", video: "5a5f648c7abe"},
  streaming: {audio: "4c47f3dfdf82", video: "5a5f648c7abe"},
};

async function capture(mode) {
  const core = await createAresSfc({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});
  core._ares_sfc_set_audio_frequency(SAMPLE_RATE);

  const rom = buildDspStressRom(mode);
  const pointer = core._ares_sfc_alloc(rom.length);
  core.HEAPU8.set(rom, pointer);
  const loaded = core._ares_sfc_load(pointer, rom.length);
  core._ares_sfc_free(pointer);
  if(!loaded) throw new Error(core.UTF8ToString(core._ares_sfc_error()));

  const audio = createHash("sha1");
  const video = createHash("sha1");
  let energy = 0, peak = 0, samples = 0;
  const started = performance.now();
  for(let frame = 0; frame < FRAMES; frame++) {
    core._ares_sfc_run_frame();
    const width = core._ares_sfc_video_width();
    const height = core._ares_sfc_video_height();
    video.update(Buffer.from(core.HEAPU8.buffer, core._ares_sfc_video_data(), width * height * 4));
    const count = core._ares_sfc_audio_frames();
    const frames = new Float32Array(core.HEAPU8.buffer, core._ares_sfc_audio_data(), count * 2);
    audio.update(Buffer.from(frames.buffer, frames.byteOffset, frames.byteLength));
    for(const sample of frames) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
    samples += count * 2;
  }
  const fps = FRAMES * 1000 / (performance.now() - started);
  core._ares_sfc_unload();

  //if the dsp is not producing signal, matching hashes would prove nothing
  const rms = Math.sqrt(energy / samples);
  if(rms < 1e-3) throw new Error(`${mode}: audio is silence (rms ${rms.toExponential(2)})`);

  return {audio: audio.digest("hex").slice(0, 12), video: video.digest("hex").slice(0, 12), rms, peak, fps};
}

let failed = false;
for(const mode of ["static", "streaming"]) {
  const result = await capture(mode);
  const golden = GOLDEN[mode];
  const checked = FRAMES === 300;
  const audioOk = !checked || result.audio === golden.audio;
  const videoOk = !checked || result.video === golden.video;
  failed ||= !audioOk || !videoOk;
  console.log(`${mode.padEnd(9)}  audio ${result.audio} ${audioOk ? "ok" : `EXPECTED ${golden.audio}`}`
    + `  video ${result.video} ${videoOk ? "ok" : `EXPECTED ${golden.video}`}`
    + `  rms ${result.rms.toFixed(3)}  peak ${result.peak.toFixed(3)}  ${result.fps.toFixed(1)} fps`);
}
if(failed) {
  console.error("\nrunning output changed — investigate before accepting");
  process.exit(1);
}
