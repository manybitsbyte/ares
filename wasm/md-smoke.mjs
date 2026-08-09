import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-md.mjs"));
const {default: createAresMd} = await import(moduleUrl);
const module = await createAresMd({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});
const rom = new Uint8Array(2048);
const write32 = (offset, value) => {
  rom[offset + 0] = value >>> 24;
  rom[offset + 1] = value >>> 16;
  rom[offset + 2] = value >>> 8;
  rom[offset + 3] = value;
};
write32(0x000, 0x00fffffc);
write32(0x004, 0x00000200);
rom.set(new TextEncoder().encode("SEGA MEGA DRIVE "), 0x100);
rom.set(new TextEncoder().encode("ARES WASM SMOKE TEST"), 0x120);
rom.set(new TextEncoder().encode("ARES WASM SMOKE TEST"), 0x150);
rom.set(new TextEncoder().encode("GM 00000000-00"), 0x180);
rom.set(new TextEncoder().encode("J"), 0x190);
rom.set(new TextEncoder().encode("U"), 0x1f0);
rom.set([0x60, 0xfe], 0x200);

const pointer = module._ares_md_alloc(rom.length);
module.HEAPU8.set(rom, pointer);
module._ares_md_set_audio_frequency(48000);
const loaded = module._ares_md_load(pointer, rom.length);
module._ares_md_free(pointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_md_error()));

const frameCount = 120;
const switchBase = module._ares_md_switch_count?.() ?? 0;
const start = performance.now();
for(let frame = 0; frame < frameCount; frame++) {
  module._ares_md_run_frame();
}
const switchesPerFrame = module._ares_md_switch_count
  ? Math.round((module._ares_md_switch_count() - switchBase) / frameCount) : null;
const checksum = bytes => {
  let hash = 2166136261;
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const width = module._ares_md_video_width();
const height = module._ares_md_video_height();
const audioFrames = module._ares_md_audio_frames();
const result = {
  width,
  height,
  audioFrames,
  videoHash: checksum(new Uint8Array(module.HEAPU8.buffer, module._ares_md_video_data(), width * height * 4)),
  audioHash: checksum(new Uint8Array(module.HEAPU8.buffer, module._ares_md_audio_data(), audioFrames * 2 * 4)),
  switchesPerFrame,
  framesPerSecond: Math.round(frameCount * 1000 / (performance.now() - start) * 10) / 10,
};
module._ares_md_unload();

if(!result.width || !result.height || !result.audioFrames) {
  throw new Error(`Incomplete frame: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result));
