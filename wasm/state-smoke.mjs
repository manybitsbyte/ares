//save-state round trip for every wasm core: save at frame N, run M frames, restore, run M frames,
//and require the two runs to agree. the video and audio hashes prove the restored machine renders
//the same thing; re-serializing at the end and comparing the state bytes is the discriminating half
//of the test, because a blank test ROM can produce identical frames no matter what the machine is
//actually doing. `advanced` guards the other direction: a machine that never moved would match for
//free.
//usage: node wasm/state-smoke.mjs [build_wasm/wasm] [core ...]
//naming cores limits the run to them, for a build configured with -DARES_CORES.
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./gb-stress-rom.mjs";
import {buildStressRom as buildGbaStressRom, buildStubBios} from "./gba-stress-rom.mjs";
import {buildStressRom as buildGgStressRom} from "./gg-stress-rom.mjs";
import {buildStressRom as buildNgStressRom, buildStubBios as buildNgStubBios, romsetName as ngRomsetName} from "./ng-stress-rom.mjs";
import {buildStressRom as buildPceStressRom} from "./pce-stress-rom.mjs";

const directory = process.argv[2] ?? "build_wasm/wasm";
const settleFrames = 30;
const measureFrames = 20;

const encode = text => new TextEncoder().encode(text);

const fcRom = () => {
  const rom = new Uint8Array(16 + 16 * 1024 + 8 * 1024);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 0x01, 0x01], 0);
  rom.set([0x78, 0xd8, 0x4c, 0x02, 0x80], 16);
  for(let vector = 16 + 0x3ffa; vector < 16 + 0x4000; vector += 2) {
    rom[vector + 0] = 0x00;
    rom[vector + 1] = 0x80;
  }
  return rom;
};

const sfcRom = () => {
  const rom = new Uint8Array(32 * 1024).fill(0xff);
  rom.set([0x78, 0x18, 0xfb, 0xc2, 0x30, 0x80, 0xfe], 0);
  const header = 0x7fc0;
  rom.set(encode("ARES WASM SMOKE      "), header);
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

const msRom = () => {
  const rom = new Uint8Array(32768);
  const program = [
    0xf3,                                            //di
    0x31, 0xf0, 0xdf,                                //ld sp,$dff0
    0x3e, 0x04, 0xd3, 0xbf, 0x3e, 0x80, 0xd3, 0xbf,  //VDP register 0
    0x3e, 0x40, 0xd3, 0xbf, 0x3e, 0x81, 0xd3, 0xbf,  //VDP register 1: display on
    0x3e, 0x0e, 0xd3, 0xbf, 0x3e, 0x82, 0xd3, 0xbf,  //VDP register 2
    0x3e, 0x7e, 0xd3, 0xbf, 0x3e, 0x85, 0xd3, 0xbf,  //VDP register 5
    0x3e, 0x00, 0xd3, 0xbf, 0x3e, 0x40, 0xd3, 0xbf,  //VRAM write address $0000
    0x06, 0x00, 0xaf,                                //ld b,0; xor a
    0xd3, 0xbe, 0x3c, 0x10, 0xfb,                    //fill 256 VRAM bytes
    0x3e, 0x00, 0xd3, 0xbf, 0x3e, 0xc0, 0xd3, 0xbf,  //CRAM write address $00
    0x06, 0x20, 0xaf,                                //ld b,32; xor a
    0xd3, 0xbe, 0x3c, 0x10, 0xfb,                    //fill CRAM
    0x3e, 0x80, 0xd3, 0x7f,                          //PSG tone latch
    0x3e, 0x10, 0xd3, 0x7f,                          //PSG tone data
    0x3e, 0x90, 0xd3, 0x7f,                          //PSG channel 0 volume
    0xaf,                                            //xor a
  ];
  const colorLoop = program.length;
  program.push(
    0x4f,                                            //ld c,a
    0xd3, 0xbf,                                      //VDP register value
    0x3e, 0x87, 0xd3, 0xbf,                          //VDP register 7 selector
    0x79, 0x3c, 0xe6, 0x0f,                          //ld a,c; inc a; and $0f
    0xc3, colorLoop & 0xff, colorLoop >> 8,
  );
  rom.set(program, 0);
  rom.set(encode("TMR SEGA"), 0x7ff0);
  rom[0x7fff] = 0x4c;
  return rom;
};

const mdRom = () => {
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
  rom.set(encode("U"), 0x1f0);
  rom.set([0x60, 0xfe], 0x200);
  return rom;
};

//the other cores here boot a handful of hand-assembled bytes, but gb cannot: its boot ROM verifies
//the cartridge header and locks up on a bad one, and the drift this harness reports is only
//meaningful with the picture running. the sweep's cartridge already satisfies both.
const gbRom = () => buildStressRom({});

//gba likewise: a bare header would load, but the machine has no BIOS to start it and the harness
//would measure a processor running NOPs. the sweep's cartridge and its stub BIOS boot properly.
const gbaRom = () => buildGbaStressRom({});

//the Game Gear's own stress cartridge: it scrolls, drives both stereo sides and takes interrupts, so
//the drift figure below is measured on a machine that is actually doing something
const ggRom = () => buildGgStressRom({});
const gbaBios = (module, api) => {
  const bios = buildStubBios();
  const pointer = api("alloc")(bios.length);
  module.HEAPU8.set(bios, pointer);
  api("set_bios")(pointer, bios.length);
  api("free")(pointer);
};

//Game Gear is a system inside the ms core rather than a core of its own, so it loads ares-ms.mjs and
//speaks the ares_ms_* ABI; only the model differs. `module` and `abi` default to `name` for every
//other row, which is why the six existing rows need no change.
const ggModel = (module, api) => {
  const name = encode("[Sega] Game Gear (NTSC-U)\0");
  const pointer = api("alloc")(name.length);
  module.HEAPU8.set(name, pointer);
  api("set_model")(pointer);
  api("free")(pointer);
};

//the Neo Geo needs two things no other row does: a BIOS -- ares cannot start an AES without one,
//and the stub carries the vector table the machine boots through -- and a romset name, because mia
//keys a MAME-format archive on the database entry it was written under.
const ngRom = () => buildNgStressRom({});
const ngBios = (module, api) => {
  const bios = buildNgStubBios();
  const pointer = api("alloc")(bios.length);
  module.HEAPU8.set(bios, pointer);
  api("set_bios")(pointer, bios.length);
  api("free")(pointer);
};
const ngLoad = (module, api, pointer, length) => {
  const name = encode(`${ngRomsetName}\0`);
  const namePointer = api("alloc")(name.length);
  module.HEAPU8.set(name, namePointer);
  const ok = api("load")(pointer, length, namePointer);
  api("free")(namePointer);
  return ok;
};

//the PC Engine's own stress cartridge: raster and timer interrupts, DMA, a sweeping dot clock and a
//PSG stirred every timer IRQ, so the drift figure is measured on a machine that is doing something.
const pceRom = () => buildPceStressRom();

const selected = process.argv.slice(3);
const cores = [
  {name: "fc", frequency: 44100, rom: fcRom},
  {name: "sfc", frequency: 44100, rom: sfcRom},
  {name: "ms", frequency: 48000, rom: msRom},
  //gg is audioPhaseSensitive for the same reason gb is, and it is placed outside the state on the
  //same evidence: the ARES_MS_COTHREAD reference build, which has none of the web scheduling,
  //reports the identical mismatch alongside the identical 58231-byte state, the identical
  //faf9e2d5 video hash and the identical 0-byte drift; audioSampleDelta stays 0, so no audio is
  //lost or gained, only shifted; and gg-sweep compares the whole concatenated stereo stream against
  //that same reference and finds it bit-identical over 300 frames. What separates gg from ms here is
  //the cartridge, not the machine: ms's row above boots a ROM holding one constant PSG tone, whose
  //samples are the same at any resampler phase, while the Game Gear stress cartridge sweeps two PSG
  //volumes every frame, so a phase shift lands on different samples.
  {name: "gg", frequency: 48000, rom: ggRom, module: "ms", abi: "ms", beforeLoad: ggModel,
   audioPhaseSensitive: true},
  {name: "md", frequency: 48000, rom: mdRom},
  //gb settles far longer than the rest: its boot ROM scrolls the Nintendo logo and holds it, and
  //a state taken during that animation would exercise the boot ROM rather than the cartridge.
  {name: "gb", frequency: 48000, rom: gbRom, settle: 240, audioPhaseSensitive: true},
  {name: "gba", frequency: 48000, rom: gbaRom, beforeLoad: gbaBios},
  {name: "ng", frequency: 48000, rom: ngRom, beforeLoad: ngBios, load: ngLoad},
  {name: "pce", frequency: 48000, rom: pceRom},
].filter(core => !selected.length || selected.includes(core.name));

const fnv1a = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");
const equal = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);


const differingBytes = (a, b) => {
  let count = Math.abs(a.length - b.length);
  for(let index = 0; index < Math.min(a.length, b.length); index++) if(a[index] !== b[index]) count++;
  return count;
};

const failures = [];
const results = [];

for(const core of cores) {
  const moduleUrl = pathToFileURL(resolve(directory, `ares-${core.module ?? core.name}.mjs`));
  const {default: factory} = await import(moduleUrl);
  const fail = message => failures.push(`${core.name}: ${message}`);

  //every experiment gets its own instance, settled by exactly settleFrames. sharing one instance
  //makes the results depend on what ran before them: a save state does not restore the host-side
  //audio resampler, so an instance with more history behind it replays at a different resampler
  //phase and the comparison stops measuring the save state.
  const boot = async () => {
    const module = await factory({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});
    const api = name => module[`_ares_${core.abi ?? core.name}_${name}`];
    const rom = core.rom();
    //a core may need something in place before the cartridge; gba is the only one that does, and
    //what it needs is a BIOS, without which ares refuses to bring the machine up at all
    core.beforeLoad?.(module, api);
    const pointer = api("alloc")(rom.length);
    module.HEAPU8.set(rom, pointer);
    api("set_audio_frequency")(core.frequency);
    //a core may also need extra load arguments; ng's load takes the romset name
    const loaded = core.load ? core.load(module, api, pointer, rom.length) : api("load")(pointer, rom.length);
    api("free")(pointer);
    if(!loaded) throw new Error(module.UTF8ToString(api("error")()));
    for(let frame = 0; frame < (core.settle ?? settleFrames); frame++) api("run_frame")();

    //state_save returns void because a synchronized save crosses an Asyncify fiber switch; the size
    //comes back through state_size. wasm heap views are invalidated by memory growth, so the bytes
    //are copied out at once.
    const save = synchronize => {
      api("state_save")(synchronize);
      const size = api("state_size")();
      const data = api("state_data")();
      if(!size || !data) return {size, data};
      return {size, data, bytes: new Uint8Array(module.HEAPU8.buffer, data, size).slice()};
    };
    const load = state => {
      const buffer = api("alloc")(state.length);
      module.HEAPU8.set(state, buffer);
      const ok = api("state_load")(buffer, state.length);
      api("free")(buffer);
      return ok;
    };
    //audio is accumulated as one stream rather than per frame: a restore can move where the frame
    //boundary falls by a sample without changing the samples themselves
    //the first frame after a restore is hashed apart from the rest and reported rather than asserted.
    //no ares save state carries the framebuffer, so whatever the source had already painted into it
    //before the save point cannot be reproduced -- on the Master System that is one scanline of frame
    //0, painted after the frame is emitted, which no build can pass. every later frame is drawn from
    //scratch and is asserted.
    const measure = () => {
      let firstHash = 2166136261;
      let videoHash = 2166136261;
      const audio = [];
      for(let frame = 0; frame < measureFrames; frame++) {
        api("run_frame")();
        const width = api("video_width")(), height = api("video_height")();
        const pixels = new Uint8Array(module.HEAPU8.buffer, api("video_data")(), width * height * 4);
        const extent = new Uint8Array(Uint32Array.from([width, height]).buffer);
        if(frame === 0) firstHash = fnv1a(fnv1a(firstHash, pixels), extent);
        else videoHash = fnv1a(fnv1a(videoHash, pixels), extent);
        audio.push(new Uint8Array(module.HEAPU8.buffer, api("audio_data")(), api("audio_frames")() * 2 * 4).slice());
      }
      const samples = new Uint8Array(audio.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }
      return {videoHash: hex(videoHash), firstFrameHash: hex(firstHash), samples};
    };
    return {module, api, save, load, measure};
  };

  const compareAudio = (a, b) => {
    const shared = Math.min(a.length, b.length);
    return {
      audioMatch: equal(a.subarray(0, shared), b.subarray(0, shared)),
      audioSampleDelta: (a.length - b.length) / 8,
    };
  };

  //the first run continues from the *live* machine. measuring a restored copy against another
  //restored copy would agree for free on anything a restore drops.
  const roundTrip = async synchronize => {
    const label = synchronize ? "persistable" : "run-ahead";
    const {api, save, load, measure} = await boot();
    const saved = save(synchronize);
    if(!saved.bytes) {
      fail(`${label} state_save produced ${saved.size} bytes: ${api("error") ? "" : ""}`);
      return null;
    }
    const first = measure();
    const afterFirst = save(synchronize);
    if(!load(saved.bytes)) { fail(`${label} state_load rejected its own state`); return null; }
    const second = measure();
    const afterSecond = save(synchronize);

    //perturbing, so it runs last: restoring a state and immediately re-serializing must reproduce it
    //byte for byte, or the blob does not describe everything it claims to
    load(saved.bytes);
    const resaved = save(synchronize);

    const audio = compareAudio(first.samples, second.samples);
    api("unload")();
    return {
      bytes: saved.size,
      restoreExact: !!resaved.bytes && equal(saved.bytes, resaved.bytes),
      //a machine that never advances would pass every comparison below for free
      advanced: !!afterFirst.bytes && !equal(saved.bytes, afterFirst.bytes),
      videoMatch: first.videoHash === second.videoHash,
      videoHash: first.videoHash,
      //reported, not asserted. audio: replaying into a resampler that already saw these frames shifts
      //its phase, so the honest audio measurement is the cross-instance one below. drift: nonzero
      //means live machine state sits outside the save state -- the two runs started from the same
      //blob and rendered the same frames, yet did not arrive at the same blob. those fields are
      //core-side and out of this bridge's scope.
      reported: {
        ...audio,
        firstFrameMatch: first.firstFrameHash === second.firstFrameHash,
        stateDriftBytes: afterFirst.bytes && afterSecond.bytes
          ? differingBytes(afterFirst.bytes, afterSecond.bytes) : null,
      },
    };
  };

  //the realistic use of a persistable state: hand it to a fresh instance that has run the same number
  //of frames and never saw the frames being replayed. nothing host-side is carrying stale phase here,
  //so audio is asserted as hard as video. run-ahead states are excluded on purpose -- they embed host
  //pointers and are valid only inside the instance that produced them.
  const crossInstance = async () => {
    const source = await boot();
    const target = await boot();
    const state = source.save(1);
    if(!state.bytes) { fail("persistable state_save produced no bytes"); return null; }
    const reference = source.measure();
    if(!target.load(state.bytes)) { fail("a fresh instance rejected a persistable state"); return null; }
    const replay = target.measure();
    const {audioMatch, ...audio} = compareAudio(reference.samples, replay.samples);
    source.api("unload")();
    target.api("unload")();
    //a save state does not carry the host-side audio resampler, so this comparison only measures
    //the state while both instances reach it with comparable history. gb settles eight times as
    //long as any other core -- its boot ROM animation has to finish first -- and past roughly a
    //hundred frames the two resamplers sit at different phases and the audio stops being about the
    //save state at all. three things place this outside the state: the ARES_GB_COTHREAD reference
    //build, which has none of the web scheduling, reports it identically; dropping gb's settle to
    //the shared 30 makes it pass with the same 17774-byte state and the same 2-byte drift; and
    //audioSampleDelta stays 0, so no audio is lost or gained, only shifted.
    const phaseSensitive = core.audioPhaseSensitive === true;
    return {
      videoMatch: reference.videoHash === replay.videoHash,
      ...audio,
      ...(phaseSensitive ? {} : {audioMatch}),
      reported: {
        firstFrameMatch: reference.firstFrameHash === replay.firstFrameHash,
        ...(phaseSensitive ? {audioMatch} : {}),
      },
    };
  };

  const result = {core: core.name};
  const cross = await crossInstance();
  if(cross) result.crossInstancePersistable = cross;
  const runAhead = await roundTrip(0);
  if(runAhead) result.runAhead = runAhead;
  const persistable = await roundTrip(1);
  if(persistable) result.persistable = persistable;

  //garbage must be refused, not crash: the signature and version header is checked before any of the
  //machine is touched, and a rejected load has to leave a working machine behind
  const {api, save, load} = await boot();
  const good = save(1);
  const garbage = new Uint8Array(good.size || 4096).map((_, index) => (index * 37 + 11) & 0xff);
  if(load(garbage) !== 0) fail("state_load accepted garbage bytes");
  if(api("state_load")(0, 0) !== 0) fail("state_load accepted an empty buffer");
  if(good.bytes && load(good.bytes) !== 1) fail("state_load failed after a rejected load");
  api("unload")();
  api("state_save")(1);
  if(api("state_size")() !== 0) fail("state_save produced a state with no cartridge loaded");
  if(api("state_data")() !== 0) fail("state_data is non-null with no cartridge loaded");
  if(api("state_load")(good.data, good.size) !== 0) fail("state_load succeeded with no cartridge loaded");

  for(const block of Object.values(result)) {
    if(typeof block !== "object" || !block) continue;
    for(const [check, value] of Object.entries(block)) {
      if(value === false) fail(`${Object.keys(result).find(key => result[key] === block)}.${check}`);
    }
  }
  results.push(result);
}

for(const result of results) console.log(JSON.stringify(result));
if(failures.length) {
  console.error(failures.map(line => `FAIL ${line}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("all cores round-tripped");
}
