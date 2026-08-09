import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-ms.mjs"));
const syncGranularity = Number(process.argv[3] ?? 1);
const {default: createAresMs} = await import(moduleUrl);
const module = await createAresMs({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

const rom = new Uint8Array(32768);
const program = [
  0xf3,                         //di
  0x31, 0xf0, 0xdf,             //ld sp,$dff0
  0x3e, 0x04, 0xd3, 0xbf, 0x3e, 0x80, 0xd3, 0xbf,  //VDP register 0
  0x3e, 0x40, 0xd3, 0xbf, 0x3e, 0x81, 0xd3, 0xbf,  //VDP register 1: display on
  0x3e, 0x0e, 0xd3, 0xbf, 0x3e, 0x82, 0xd3, 0xbf,  //VDP register 2
  0x3e, 0x7e, 0xd3, 0xbf, 0x3e, 0x85, 0xd3, 0xbf,  //VDP register 5
  0x3e, 0x00, 0xd3, 0xbf, 0x3e, 0x40, 0xd3, 0xbf,  //VRAM write address $0000
  0x06, 0x00, 0xaf,             //ld b,0; xor a
  0xd3, 0xbe, 0x3c, 0x10, 0xfb, //fill 256 VRAM bytes
  0x3e, 0x00, 0xd3, 0xbf, 0x3e, 0xc0, 0xd3, 0xbf,  //CRAM write address $00
  0x06, 0x20, 0xaf,             //ld b,32; xor a
  0xd3, 0xbe, 0x3c, 0x10, 0xfb, //fill CRAM
  0x3e, 0x80, 0xd3, 0x7f,       //PSG tone latch
  0x3e, 0x10, 0xd3, 0x7f,       //PSG tone data
  0x3e, 0x90, 0xd3, 0x7f,       //PSG channel 0 volume
  0xaf,                         //xor a
];
const colorLoop = program.length;
program.push(
  0x4f,                         //ld c,a
  0xd3, 0xbf,                   //VDP register value
  0x3e, 0x87, 0xd3, 0xbf,       //VDP register 7 selector
  0x79, 0x3c, 0xe6, 0x0f,       //ld a,c; inc a; and $0f
  0xc3, colorLoop & 0xff, colorLoop >> 8,
);
rom.set(program, 0);
rom.set(new TextEncoder().encode("TMR SEGA"), 0x7ff0);
rom[0x7fff] = 0x4c;

const pointer = module._ares_ms_alloc(rom.length);
module.HEAPU8.set(rom, pointer);
module._ares_ms_set_audio_frequency(48000);
module._ares_ms_set_sync_granularity(syncGranularity);
const loaded = module._ares_ms_load(pointer, rom.length);
module._ares_ms_free(pointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_ms_error()));

const frameCount = 120;
const switchBase = module._ares_ms_switch_count?.() ?? 0;
const checksum = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
let videoHash = 2166136261;
let audioHash = 2166136261;
let coreTime = 0;
for(let frame = 0; frame < frameCount; frame++) {
  const start = performance.now();
  module._ares_ms_run_frame();
  coreTime += performance.now() - start;
  const width = module._ares_ms_video_width();
  const height = module._ares_ms_video_height();
  const audioFrames = module._ares_ms_audio_frames();
  videoHash = checksum(videoHash, new Uint8Array(module.HEAPU8.buffer, module._ares_ms_video_data(), width * height * 4));
  audioHash = checksum(audioHash, new Uint8Array(module.HEAPU8.buffer, module._ares_ms_audio_data(), audioFrames * 2 * 4));
}
const switchesPerFrame = module._ares_ms_switch_count ? (module._ares_ms_switch_count() - switchBase) / frameCount : null;
const width = module._ares_ms_video_width();
const height = module._ares_ms_video_height();
const audioFrames = module._ares_ms_audio_frames();
const result = {
  syncGranularity: module._ares_ms_sync_granularity(),
  width,
  height,
  audioFrames,
  videoHash: (videoHash >>> 0).toString(16).padStart(8, "0"),
  audioHash: (audioHash >>> 0).toString(16).padStart(8, "0"),
  switchesPerFrame,
  framesPerSecond: frameCount * 1000 / coreTime,
};
module._ares_ms_unload();

if(!result.width || !result.height || !result.audioFrames) {
  throw new Error(`Incomplete frame: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result));
