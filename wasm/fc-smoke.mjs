import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-fc.mjs"));
const {default: createAresFc} = await import(moduleUrl);
const module = await createAresFc({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

const rom = new Uint8Array(16 + 16 * 1024 + 8 * 1024);
rom.set([0x4e, 0x45, 0x53, 0x1a, 0x01, 0x01], 0);
rom.set([0x78, 0xd8, 0x4c, 0x02, 0x80], 16);
for(let vector = 16 + 0x3ffa; vector < 16 + 0x4000; vector += 2) {
  rom[vector + 0] = 0x00;
  rom[vector + 1] = 0x80;
}

const pointer = module._ares_fc_alloc(rom.length);
module.HEAPU8.set(rom, pointer);
module._ares_fc_set_audio_frequency(44100);
const loaded = module._ares_fc_load(pointer, rom.length);
module._ares_fc_free(pointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_fc_error()));

module._ares_fc_run_frame();
const result = {
  width: module._ares_fc_video_width(),
  height: module._ares_fc_video_height(),
  audioFrames: module._ares_fc_audio_frames(),
};
module._ares_fc_unload();

if(!result.width || !result.height || !result.audioFrames) {
  throw new Error(`Incomplete frame: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result));
