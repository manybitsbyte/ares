import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-sfc.mjs"));
const {default: createAresSfc} = await import(moduleUrl);
const module = await createAresSfc({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

const rom = new Uint8Array(32 * 1024).fill(0xff);
rom.set([0x78, 0x18, 0xfb, 0xc2, 0x30, 0x80, 0xfe], 0);

const header = 0x7fc0;
const title = new TextEncoder().encode("ARES WASM SMOKE      ");
rom.set(title, header);
rom.set([0x20, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00], header + 0x15);
for(let vector = 0x7fe4; vector <= 0x7ffe; vector += 2) {
  rom[vector + 0] = 0x00;
  rom[vector + 1] = 0x80;
}

rom.fill(0, header + 0x1c, header + 0x20);
const checksum = (rom.reduce((sum, byte) => sum + byte, 0) + 0x1fe) & 0xffff;
const complement = checksum ^ 0xffff;
rom[header + 0x1c] = complement & 0xff;
rom[header + 0x1d] = complement >> 8;
rom[header + 0x1e] = checksum & 0xff;
rom[header + 0x1f] = checksum >> 8;

module._ares_sfc_set_audio_frequency(44100);
const pointer = module._ares_sfc_alloc(rom.length);
module.HEAPU8.set(rom, pointer);
const loaded = module._ares_sfc_load(pointer, rom.length);
module._ares_sfc_free(pointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_sfc_error()));

const frameCount = 120;
//the switch counter only exists in an -DARES_WASM_DEBUG=ON build; say so rather than report a
//zero that would read as a suspiciously good result
const switchBase = module._ares_sfc_switch_count?.() ?? 0;
const start = performance.now();
for(let frame = 0; frame < frameCount; frame++) module._ares_sfc_run_frame();
const result = {
  width: module._ares_sfc_video_width(),
  height: module._ares_sfc_video_height(),
  audioFrames: module._ares_sfc_audio_frames(),
  switchesPerFrame: module._ares_sfc_switch_count
    ? (module._ares_sfc_switch_count() - switchBase) / frameCount : "unavailable (needs -DARES_WASM_DEBUG=ON)",
  framesPerSecond: frameCount * 1000 / (performance.now() - start),
};
module._ares_sfc_unload();

if(!result.width || !result.height || !result.audioFrames) {
  throw new Error(`Incomplete frame: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result));
