//liveness for the Neo Geo core: boots the stress cartridge under the stub BIOS and requires a
//picture and a frame of audio. fidelity lives in wasm/ng-sweep.mjs.
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom, buildStubBios, romsetName} from "./ng-stress-rom.mjs";

const moduleUrl = pathToFileURL(resolve(process.argv[2] ?? "ares-ng.mjs"));
const {default: createAresNg} = await import(moduleUrl);
const module = await createAresNg({
  locateFile: path => fileURLToPath(new URL(path, moduleUrl)),
});

const put = bytes => {
  const pointer = module._ares_ng_alloc(bytes.length);
  module.HEAPU8.set(bytes, pointer);
  return pointer;
};

const bios = buildStubBios();
const biosPointer = put(bios);
module._ares_ng_set_bios(biosPointer, bios.length);
module._ares_ng_free(biosPointer);

//a load with no BIOS must be refused: the AES cannot start without one
{
  const probe = await createAresNg({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});
  const rom = buildStressRom();
  const pointer = probe._ares_ng_alloc(rom.length);
  probe.HEAPU8.set(rom, pointer);
  const name = probe._ares_ng_alloc(romsetName.length + 1);
  probe.HEAPU8.set(new TextEncoder().encode(`${romsetName}\0`), name);
  if(probe._ares_ng_load(pointer, rom.length, name)) {
    throw new Error("a load with no BIOS was accepted");
  }
}

const rom = buildStressRom();
const romPointer = put(rom);
const namePointer = put(new TextEncoder().encode(`${romsetName}\0`));
module._ares_ng_set_audio_frequency(48000);
const loaded = module._ares_ng_load(romPointer, rom.length, namePointer);
module._ares_ng_free(romPointer);
module._ares_ng_free(namePointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_ng_error()));

const frameCount = 120;
//the switch counter only exists in an -DARES_WASM_DEBUG=ON build; say so rather than report a
//zero that would read as a suspiciously good result
const switchBase = module._ares_ng_switch_count?.() ?? 0;
const start = performance.now();
for(let frame = 0; frame < frameCount; frame++) {
  module._ares_ng_run_frame();
}
const switchesPerFrame = module._ares_ng_switch_count
  ? Math.round((module._ares_ng_switch_count() - switchBase) / frameCount) : "unavailable (needs -DARES_WASM_DEBUG=ON)";
const checksum = bytes => {
  let hash = 2166136261;
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const width = module._ares_ng_video_width();
const height = module._ares_ng_video_height();
const audioFrames = module._ares_ng_audio_frames();
const pixels = new Uint8Array(module.HEAPU8.buffer, module._ares_ng_video_data(), width * height * 4);
let lit = 0;
for(let pixel = 0; pixel < pixels.length; pixel += 4) {
  if(pixels[pixel] | pixels[pixel + 1] | pixels[pixel + 2]) lit++;
}
const result = {
  width,
  height,
  audioFrames,
  litPixels: `${(100 * lit / (width * height)).toFixed(1)}%`,
  videoHash: checksum(pixels),
  audioHash: checksum(new Uint8Array(module.HEAPU8.buffer, module._ares_ng_audio_data(), audioFrames * 2 * 4)),
  switchesPerFrame,
  framesPerSecond: Math.round(frameCount * 1000 / (performance.now() - start) * 10) / 10,
};
module._ares_ng_unload();

if(!result.width || !result.height || !result.audioFrames || !lit) {
  throw new Error(`Incomplete frame: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result));
