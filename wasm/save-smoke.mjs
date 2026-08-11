//persistent-memory round trip for every wasm core: boot a cartridge that declares battery-backed
//memory, gather it, write a pattern over every byte, restore that, and require the core to hand the
//pattern back.
//
//the discriminating half is that the pattern is written from *outside* the machine. gathering runs
//through the board — ares_<core>_save_ram_save asks the system to flush its memory into the pak
//before reading it — so a restore that only reached the pak and never reached the board is
//overwritten by the flush and comes back as the 0xff mia filled the memory with. a test that let the
//ROM write its own save RAM would pass without the restore path working at all.
//
//usage: node wasm/save-smoke.mjs [build_wasm/wasm] [core ...]
//naming cores limits the run to them, for a build configured with -DARES_CORES.
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./gb-stress-rom.mjs";
import {buildStressRom as buildGbaStressRom, buildStubBios} from "./gba-stress-rom.mjs";

const directory = process.argv[2] ?? "build_wasm/wasm";
const settleFrames = 20;

const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);

//NES 2.0 rather than iNES 1.0: iNES 1.0 carries no RAM size at all, and mia leaves a mapper 0
//cartridge with none. byte 6 bit 1 is the battery, and byte 10's high nibble asks for 64 << 7 bytes
//of non-volatile program RAM, which mia folds into one 8 KiB save memory.
const fcRom = ({battery = false} = {}) => {
  const rom = new Uint8Array(16 + 16 * 1024 + 8 * 1024);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 0x01, 0x01], 0);
  if(battery) {
    rom[6] = 0x02;
    rom[7] = 0x08;
    rom[10] = 0x70;
  }
  rom.set([0x78, 0xd8, 0x4c, 0x02, 0x80], 16);
  for(let vector = 16 + 0x3ffa; vector < 16 + 0x4000; vector += 2) {
    rom[vector + 0] = 0x00;
    rom[vector + 1] = 0x80;
  }
  return rom;
};

//header byte $ffd8 is the RAM size exponent — 3 asks for 8 KiB — and $ffd6 is the chipset byte that
//says the cartridge is ROM, RAM and a battery. both sit under the checksum, so they go in first.
const sfcRom = ({battery = false} = {}) => {
  const rom = new Uint8Array(32 * 1024).fill(0xff);
  rom.set([0x78, 0x18, 0xfb, 0xc2, 0x30, 0x80, 0xfe], 0);
  const header = 0x7fc0;
  rom.set(encode("ARES WASM SMOKE      "), header);
  rom.set([0x20, battery ? 0x02 : 0x00, 0x05, battery ? 0x03 : 0x00, 0x01, 0x00, 0x00], header + 0x15);
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

//no battery variant: mia gives every Master System cartridge 32 KiB of save RAM, because the header
//does not carry a size and only the database knows the real one. that is upstream's behaviour and
//this harness measures it rather than working around it.
const msRom = () => {
  const rom = new Uint8Array(32768);
  const program = [
    0xf3,                                            //di
    0x31, 0xf0, 0xdf,                                //ld sp,$dff0
    0x3e, 0x04, 0xd3, 0xbf, 0x3e, 0x80, 0xd3, 0xbf,  //VDP register 0
    0x3e, 0x40, 0xd3, 0xbf, 0x3e, 0x81, 0xd3, 0xbf,  //VDP register 1: display on
    0x18, 0xfe,                                      //jr $-2
  ];
  rom.set(program, 0);
  rom.set(encode("TMR SEGA"), 0x7ff0);
  rom[0x7fff] = 0x4c;
  return rom;
};

//"RA" at $1b0 opens the SRAM block; $1b4 and $1b8 are the first and last byte addresses. both odd
//marks the memory as living on the low byte of each word, which halves the range to 8 KiB.
const mdRom = ({battery = false} = {}) => {
  const rom = new Uint8Array(2048);
  const write32 = (offset, value) => {
    rom[offset + 0] = value >>> 24;
    rom[offset + 1] = value >>> 16;
    rom[offset + 2] = value >>> 8;
    rom[offset + 3] = value;
  };
  write32(0x000, 0x00fffffc);
  write32(0x004, 0x00000200);
  rom.set(encode("SEGA MEGA DRIVE "), 0x100);
  rom.set(encode("ARES WASM SMOKE TEST"), 0x120);
  rom.set(encode("ARES WASM SMOKE TEST"), 0x150);
  rom.set(encode("GM 00000000-00"), 0x180);
  rom.set(encode("J"), 0x190);
  if(battery) {
    rom.set(encode("RA"), 0x1b0);
    rom[0x1b2] = 0xf8;
    rom[0x1b3] = 0x20;
    write32(0x1b4, 0x00200001);
    write32(0x1b8, 0x00203fff);
  }
  rom.set(encode("U"), 0x1f0);
  rom.set([0x60, 0xfe], 0x200);
  return rom;
};

//the stress cartridge is the only gb image here that boots: the boot ROM verifies the header and
//locks up on a bad one. $0147 = 3 is MBC1 with RAM and a battery, $0149 = 2 is 8 KiB, and the header
//checksum covers both, so it is recomputed over the same range the generator uses.
const gbRom = ({battery = false} = {}) => {
  const rom = buildStressRom({});
  if(battery) {
    rom[0x0147] = 0x03;
    rom[0x0149] = 0x02;
    let checksum = 0;
    for(let address = 0x0134; address <= 0x014c; address++) checksum = (checksum - rom[address] - 1) & 0xff;
    rom[0x014d] = checksum;
  }
  return rom;
};

//mia picks a gba cartridge's save type by scanning the image for one of a handful of marker
//strings, so the battery is switched on by embedding one rather than by a header bit
const gbaRom = ({battery = false} = {}) => buildGbaStressRom({save: battery ? "sram" : "none"});
const gbaBios = (module, api) => {
  const bios = buildStubBios();
  const pointer = api("alloc")(bios.length);
  module.HEAPU8.set(bios, pointer);
  api("set_bios")(pointer, bios.length);
  api("free")(pointer);
};

const selected = process.argv.slice(3);
const cores = [
  {name: "fc", frequency: 44100, rom: fcRom, memories: ["save.ram"], plainHasSaveRam: false},
  {name: "sfc", frequency: 44100, rom: sfcRom, memories: ["save.ram"], plainHasSaveRam: false},
  //ms takes no battery flag: every Master System cartridge mia analyzes carries save RAM
  {name: "ms", frequency: 48000, rom: msRom, memories: ["save.ram"], plainHasSaveRam: true},
  {name: "md", frequency: 48000, rom: mdRom, memories: ["save.ram"], plainHasSaveRam: false},
  {name: "gb", frequency: 48000, rom: gbRom, memories: ["save.ram"], plainHasSaveRam: false, settle: 240},
  {name: "gba", frequency: 48000, rom: gbaRom, memories: ["save.ram"], plainHasSaveRam: false, beforeLoad: gbaBios},
].filter(core => !selected.length || selected.includes(core.name));

const equal = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);

//the container ares_<core>_save_ram_save writes, read back the way a host would have to read it
const unpack = blob => {
  if(blob.length < 12) throw new Error("shorter than a header");
  if(decode(blob.subarray(0, 4)) !== "ARSV") throw new Error("wrong magic");
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const version = view.getUint32(4, true);
  if(version !== 1) throw new Error(`unknown version ${version}`);
  const count = view.getUint32(8, true);
  const entries = [];
  let offset = 12;
  for(let entry = 0; entry < count; entry++) {
    const nameSize = view.getUint32(offset, true); offset += 4;
    const name = decode(blob.subarray(offset, offset + nameSize)); offset += nameSize;
    const dataSize = view.getUint32(offset, true); offset += 4;
    entries.push({name, offset, size: dataSize});
    offset += dataSize;
  }
  if(offset !== blob.length) throw new Error(`${blob.length - offset} trailing bytes`);
  return entries;
};

//a pattern no cartridge would arrive at on its own: mia fills unbacked memory with 0xff, and a
//machine that has run for twenty frames without touching its save RAM still reads 0xff
const pattern = blob => {
  const patterned = blob.slice();
  for(const [index, entry] of unpack(patterned).entries()) {
    for(let position = 0; position < entry.size; position++) {
      patterned[entry.offset + position] = (index * 7 + position * 31 + 5) & 0xff;
    }
  }
  return patterned;
};

const failures = [];
const results = [];

for(const core of cores) {
  const moduleUrl = pathToFileURL(resolve(directory, `ares-${core.name}.mjs`));
  const {default: factory} = await import(moduleUrl);
  const fail = message => failures.push(`${core.name}: ${message}`);

  const boot = async ({battery = true} = {}) => {
    const module = await factory({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});
    const api = name => module[`_ares_${core.name}_${name}`];
    const rom = core.rom({battery});
    //a core may need something in place before the cartridge; gba is the only one that does, and
    //what it needs is a BIOS, without which ares refuses to bring the machine up at all
    core.beforeLoad?.(module, api);
    const pointer = api("alloc")(rom.length);
    module.HEAPU8.set(rom, pointer);
    api("set_audio_frequency")(core.frequency);
    const loaded = api("load")(pointer, rom.length);
    api("free")(pointer);
    if(!loaded) throw new Error(module.UTF8ToString(api("error")()));
    for(let frame = 0; frame < (core.settle ?? settleFrames); frame++) api("run_frame")();

    //save_ram_save returns void and the size comes back through save_ram_size, matching state_save;
    //wasm heap views are invalidated by memory growth, so the bytes are copied out at once
    const gather = () => {
      api("save_ram_save")();
      const size = api("save_ram_size")();
      const data = api("save_ram_data")();
      if(!size || !data) return {size, data};
      return {size, data, bytes: new Uint8Array(module.HEAPU8.buffer, data, size).slice()};
    };
    const restore = blob => {
      const buffer = api("alloc")(blob.length);
      module.HEAPU8.set(blob, buffer);
      const ok = api("save_ram_load")(buffer, blob.length);
      api("free")(buffer);
      return ok;
    };
    const run = frames => { for(let frame = 0; frame < frames; frame++) api("run_frame")(); };
    return {module, api, gather, restore, run};
  };

  const result = {core: core.name};
  const {api, gather, restore, run} = await boot();

  const initial = gather();
  result.bytes = initial.size;
  result.hasSaveRam = !!initial.bytes;
  if(!initial.bytes) {
    fail("a cartridge declaring battery memory gathered nothing");
    results.push(result);
    continue;
  }

  try {
    const entries = unpack(initial.bytes);
    result.memories = entries.map(entry => `${entry.name}:${entry.size}`);
    result.namesExpected = equal(
      Uint8Array.from(entries.map(entry => entry.name.length)),
      Uint8Array.from(core.memories.map(name => name.length)),
    ) && entries.every((entry, index) => entry.name === core.memories[index]);
    result.containerValid = true;
  } catch(error) {
    result.containerValid = false;
    fail(`the container did not parse: ${error.message}`);
  }

  const patterned = pattern(initial.bytes);
  //restore, then re-gather. the re-gather flushes the board into the pak first, so it reports what
  //the machine holds, not what was written into the pak a moment ago.
  result.restoreAccepted = restore(patterned) === 1;
  result.restoreExact = !!gather().bytes && equal(gather().bytes, patterned);
  run(settleFrames);
  result.survivesFrames = equal(gather().bytes, patterned);

  //garbage must be refused without taking the machine down, and a refusal must leave it working
  const corrupt = patterned.slice(); corrupt[0] = 0x5a;
  if(restore(corrupt) !== 0) fail("save_ram_load accepted a blob with the wrong magic");
  const wrongVersion = patterned.slice(); wrongVersion[4] = 0x02;
  if(restore(wrongVersion) !== 0) fail("save_ram_load accepted a blob from an unknown version");
  if(restore(patterned.slice(0, 13)) !== 0) fail("save_ram_load accepted a truncated blob");
  if(api("save_ram_load")(0, 0) !== 0) fail("save_ram_load accepted an empty buffer");

  //a blob naming a memory this cartridge does not have is refused rather than applied by position
  const foreign = patterned.slice();
  const first = unpack(foreign)[0];
  foreign.set(encode("x".repeat(first.name.length)), 12 + 4);
  if(restore(foreign) !== 0) fail("save_ram_load accepted a blob naming an unknown memory");

  result.survivesRefusals = equal(gather().bytes, patterned);

  //a fresh instance that never saw the pattern being written
  const target = await boot();
  result.crossInstance = target.restore(patterned) === 1 && equal(target.gather().bytes, patterned);
  target.api("unload")();

  //a cartridge that declares no persistent memory. ms is the exception and says so above.
  const plain = await boot({battery: false});
  const plainGathered = plain.gather();
  result.plainCartridge = !!plainGathered.bytes === core.plainHasSaveRam;
  if(!core.plainHasSaveRam && plain.restore(patterned) !== 0) {
    fail("save_ram_load succeeded on a cartridge with no persistent memory");
  }
  plain.api("unload")();

  api("unload")();
  api("save_ram_save")();
  if(api("save_ram_size")() !== 0) fail("save_ram_save produced a save with no cartridge loaded");
  if(api("save_ram_data")() !== 0) fail("save_ram_data is non-null with no cartridge loaded");
  if(restore(patterned) !== 0) fail("save_ram_load succeeded with no cartridge loaded");

  for(const [check, value] of Object.entries(result)) {
    if(value === false) fail(check);
  }
  results.push(result);
}

for(const result of results) console.log(JSON.stringify(result));
if(failures.length) {
  console.error(failures.map(line => `FAIL ${line}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("all cores round-tripped their persistent memory");
}
