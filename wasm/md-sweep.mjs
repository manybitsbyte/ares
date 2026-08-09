//Boots the md stress image and hashes every framebuffer and the entire audio stream, so builds
//and sync-granularity settings can be compared bit-for-bit.
//usage: node wasm/md-sweep.mjs <path-to-ares-md.mjs> [granularity] [frames]

import {fileURLToPath, pathToFileURL} from "node:url";
import {buildStressRom} from "./md-stress-rom.mjs";

const moduleUrl = pathToFileURL(process.argv[2]).href;
const {default: createAresMd} = await import(moduleUrl);
const module = await createAresMd({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});
const syncGranularity = Number(process.argv[3] ?? 1);
const frameCount = Number(process.argv[4] ?? 300);

const rom = buildStressRom();
const pointer = module._ares_md_alloc(rom.length);
module.HEAPU8.set(rom, pointer);
module._ares_md_set_audio_frequency(48000);
module._ares_md_set_sync_granularity?.(syncGranularity);
const loaded = module._ares_md_load(pointer, rom.length);
module._ares_md_free(pointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_md_error()));

const fnv = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
};

let videoHash = 2166136261;
let audioHash = 2166136261;
let audioFrames = 0;
const switchBase = module._ares_md_switch_count?.() ?? 0;
const start = performance.now();
for(let frame = 0; frame < frameCount; frame++) {
  //deterministic input schedule exercising the pad multiplexer
  const mask = frame & 32 ? (frame & 16 ? 0x71 : 0x86) : 0;
  module._ares_md_set_input(0, mask);
  module._ares_md_run_frame();
  const width = module._ares_md_video_width();
  const height = module._ares_md_video_height();
  videoHash = fnv(videoHash, new Uint8Array(module.HEAPU8.buffer, module._ares_md_video_data(), width * height * 4));
  const frames = module._ares_md_audio_frames();
  audioFrames += frames;
  audioHash = fnv(audioHash, new Uint8Array(module.HEAPU8.buffer, module._ares_md_audio_data(), frames * 2 * 4));
}
const elapsed = performance.now() - start;
const switchesPerFrame = module._ares_md_switch_count
  ? Math.round((module._ares_md_switch_count() - switchBase) / frameCount) : null;
module._ares_md_unload();

console.log(JSON.stringify({
  syncGranularity: module._ares_md_sync_granularity?.() ?? 1,
  frames: frameCount,
  audioFrames,
  videoStreamHash: videoHash.toString(16).padStart(8, "0"),
  audioStreamHash: audioHash.toString(16).padStart(8, "0"),
  switchesPerFrame,
  framesPerSecond: Math.round(frameCount * 1000 / elapsed * 10) / 10,
}));
