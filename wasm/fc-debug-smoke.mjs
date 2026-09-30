//Drives the 19 debug exports against a built ares-fc module, on the same synthetic NROM image
//fc-smoke.mjs boots -- no ROM file is needed.
//
//  node fc-debug-smoke.mjs path/to/ares-fc.mjs

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

const kinds = [
  "out-of-range", "memory", "graphics", "properties",
  "instruction-tracer", "notification-tracer", "stream", "manifest",
];

//before any load: the table is empty and nothing throws
if(module._ares_fc_debug_node_count() !== 0) throw new Error("node_count is non-zero with no machine loaded");
if(module._ares_fc_debug_node_kind(0) !== 0) throw new Error("node_kind(0) is non-zero with no machine loaded");

const pointer = module._ares_fc_alloc(rom.length);
module.HEAPU8.set(rom, pointer);
module._ares_fc_set_audio_frequency(44100);
const loaded = module._ares_fc_load(pointer, rom.length);
module._ares_fc_free(pointer);
if(!loaded) throw new Error(module.UTF8ToString(module._ares_fc_error()));
module._ares_fc_run_frame();

const count = module._ares_fc_debug_node_count();
if(!count) throw new Error("node_count is zero after a load");

const nodes = [];
for(let index = 0; index < count; index++) {
  const kind = module._ares_fc_debug_node_kind(index);
  const name = module.UTF8ToString(module._ares_fc_debug_node_name(index));
  if(kind < 1 || kind > 7) throw new Error(`node ${index} has kind ${kind}, expected 1..7`);
  if(!name) throw new Error(`node ${index} has an empty name`);
  nodes.push({index, kind, kindName: kinds[kind], name});
}

//out of range answers 0 and "" rather than garbage
if(module._ares_fc_debug_node_kind(count) !== 0) throw new Error("node_kind past the end is non-zero");
if(module.UTF8ToString(module._ares_fc_debug_node_name(count)) !== "") throw new Error("node_name past the end is non-empty");

//memory: full extent in one call, and a mismatched kind reads as zero rather than as bytes
const memory = nodes.find(node => node.kind === 1);
let memoryReport = null;
if(memory) {
  const size = module._ares_fc_debug_memory_size(memory.index);
  const data = module._ares_fc_debug_memory_read(memory.index, 0, size);
  const bytes = new Uint8Array(module.HEAPU8.buffer, data, size).slice();
  let nonZero = 0;
  for(const byte of bytes) if(byte) nonZero++;
  memoryReport = {name: memory.name, size, bytes: bytes.length, nonZero};

  //writes are off unless armed, and nothing in the 19 exports arms them
  const before = bytes[0];
  module._ares_fc_debug_memory_write(memory.index, 0, before ^ 0xff);
  const after = new Uint8Array(module.HEAPU8.buffer, module._ares_fc_debug_memory_read(memory.index, 0, 1), 1)[0];
  memoryReport.writeIgnored = after === before;
}

//tracers: enable every one, run frames, drain
const tracers = nodes.filter(node => node.kind === 4 || node.kind === 5);
for(const tracer of tracers) {
  module._ares_fc_debug_tracer_set_enabled(tracer.index, 1);
  if(tracer.kind === 4) module._ares_fc_debug_tracer_set_mask(tracer.index, 0);
}
for(let frame = 0; frame < 10; frame++) module._ares_fc_run_frame();
const drained = module._ares_fc_debug_tracer_drain();
const traceBytes = new Uint8Array(module.HEAPU8.buffer, module._ares_fc_debug_tracer_data(), drained).slice();
const lines = new TextDecoder().decode(traceBytes).split("\0").filter(line => line.length);
const dropped = module._ares_fc_debug_tracer_dropped();
for(const tracer of tracers) module._ares_fc_debug_tracer_set_enabled(tracer.index, 0);

//streams
const streams = nodes.filter(node => node.kind === 6).map(node => ({
  name: node.name,
  channels: module._ares_fc_debug_stream_channels(node.index),
  frequency: module._ares_fc_debug_stream_frequency(node.index),
}));

//manifests
const manifests = nodes.filter(node => node.kind === 7).map(node => {
  const text = module.UTF8ToString(module._ares_fc_debug_manifest_text(node.index));
  return {name: node.name, bytes: text.length, first: text.split("\n")[0]};
});

//graphics and properties: fc has neither, and asking must answer empty rather than crash
const graphics = nodes.filter(node => node.kind === 2).length;
const properties = nodes.filter(node => node.kind === 3).length;
const graphicsOnWrongKind = module._ares_fc_debug_graphics_capture(0);
const propertiesOnWrongKind = module.UTF8ToString(module._ares_fc_debug_properties_query(0));

module._ares_fc_unload();
if(module._ares_fc_debug_node_count() !== 0) throw new Error("node_count survived an unload");

console.log(JSON.stringify({
  count,
  nodes: nodes.map(node => `${node.index} ${node.kindName} "${node.name}"`),
  memory: memoryReport,
  trace: {lines: lines.length, bytes: drained, dropped, sample: lines.slice(0, 3), tail: lines.slice(-1)},
  streams,
  manifests,
  graphics,
  properties,
  graphicsOnWrongKind,
  propertiesOnWrongKind,
}, null, 2));
