import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";

const fcPath = process.argv[2] ?? "build_wasm/wasm/ares-fc.mjs";
const sfcPath = process.argv[3] ?? "build_wasm/wasm/ares-sfc.mjs";

const load = async path => {
  const url = pathToFileURL(resolve(path));
  const {default: create} = await import(url);
  return create({locateFile: file => fileURLToPath(new URL(file, url))});
};

const famicomRom = () => {
  const rom = new Uint8Array(16 + 16 * 1024 + 8 * 1024);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 0x01, 0x01], 0);
  rom.set([0x78, 0xd8, 0x4c, 0x02, 0x80], 16);
  for(let vector = 16 + 0x3ffa; vector < 16 + 0x4000; vector += 2) {
    rom[vector + 0] = 0x00;
    rom[vector + 1] = 0x80;
  }
  return rom;
};

const superFamicomRom = () => {
  const rom = new Uint8Array(32 * 1024).fill(0xff);
  rom.set([0x78, 0x18, 0xfb, 0xc2, 0x30, 0x80, 0xfe], 0);
  const header = 0x7fc0;
  rom.set(new TextEncoder().encode("ARES WASM SMOKE      "), header);
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
  return rom;
};

const measure = (module, prefix, rom, region, frameCount) => {
  module[`_ares_${prefix}_unload`]();
  module[`_ares_${prefix}_set_region`](0);
  if(region) {
    const bytes = new TextEncoder().encode(`${region}\0`);
    const name = module[`_ares_${prefix}_alloc`](bytes.length);
    module.HEAPU8.set(bytes, name);
    module[`_ares_${prefix}_set_region`](name);
    module[`_ares_${prefix}_free`](name);
  }
  module[`_ares_${prefix}_set_overscan`](1);
  module[`_ares_${prefix}_set_audio_frequency`](44100);
  const pointer = module[`_ares_${prefix}_alloc`](rom.length);
  module.HEAPU8.set(rom, pointer);
  const loaded = module[`_ares_${prefix}_load`](pointer, rom.length);
  module[`_ares_${prefix}_free`](pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module[`_ares_${prefix}_error`]()));

  let samples = 0;
  for(let frame = 0; frame < frameCount; frame++) {
    module[`_ares_${prefix}_run_frame`]();
    samples += module[`_ares_${prefix}_audio_frames`]();
  }
  const result = {
    region: region ?? "(default)",
    width: module[`_ares_${prefix}_video_width`](),
    uncroppedHeight: module[`_ares_${prefix}_video_height`](),
    samplesPerFrame: +(samples / frameCount).toFixed(1),
  };
  result.impliedFrameRate = +(44100 / (samples / frameCount)).toFixed(2);
  module[`_ares_${prefix}_set_overscan`](0);
  module[`_ares_${prefix}_run_frame`]();
  result.croppedHeight = module[`_ares_${prefix}_video_height`]();
  module[`_ares_${prefix}_unload`]();
  return result;
};

const report = (label, rows) => {
  for(const row of rows) console.log(`${label} ${JSON.stringify(row)}`);
  const base = rows[0].samplesPerFrame;
  for(const row of rows.slice(1)) {
    const ratio = row.samplesPerFrame / base;
    const pal = row.region === "PAL" || row.region === "Dendy";
    const expected = pal ? ratio > 1.15 && ratio < 1.25 : Math.abs(ratio - 1) < 0.001;
    if(!expected) throw new Error(`${label} ${row.region}: sample ratio ${ratio.toFixed(3)} is not what that region implies`);
  }
};

const fc = await load(fcPath);
const fcRom = famicomRom();
report("fc", [
  measure(fc, "fc", fcRom, null, 120),
  measure(fc, "fc", fcRom, "NTSC-U", 120),
  measure(fc, "fc", fcRom, "PAL", 120),
  measure(fc, "fc", fcRom, "Dendy", 120),
  measure(fc, "fc", fcRom, "Atlantis", 120),
]);

const sfc = await load(sfcPath);
const sfcRom = superFamicomRom();
report("sfc", [
  measure(sfc, "sfc", sfcRom, null, 120),
  measure(sfc, "sfc", sfcRom, "NTSC", 120),
  measure(sfc, "sfc", sfcRom, "PAL", 120),
  measure(sfc, "sfc", sfcRom, "Atlantis", 120),
]);
