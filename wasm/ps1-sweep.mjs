//Compares the web build's PlayStation scheduling against the cothread scheduler.
//
//The reference is a second wasm build of the same sources with the PLATFORM_WEB fast paths compiled
//out:
//
//   emcmake cmake -S . -B build_wasm_ps1_co -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=ps1 -DARES_ENABLE_CHD=OFF \
//     -DCMAKE_CXX_FLAGS=-DARES_PS1_COTHREAD
//   cmake --build build_wasm_ps1_co --target ares-ps1-wasm
//
//   ARES_PS1_BIOS=/absolute/path/to/scph5501.bin \
//   node wasm/ps1-sweep.mjs build_wasm_ps1/wasm/ares-ps1.mjs build_wasm_ps1_co/wasm/ares-ps1.mjs disc.cue ...
//
//The workload is real discs, named on the command line, and no synthetic image is offered as an
//alternative. On the other cores a stress ROM is enough because a cartridge is the whole machine;
//here it is not. The two things this core does that no other one does -- a CD drive streaming
//sectors into a FIFO on its own thread, and a GPU whose renderer the web build pulls off the render
//thread ares normally starts and executes inline instead (ares/ps1/accuracy.hpp) -- are reached by
//software that draws and by software that reads a disc, and wasm/ps1-stress-rom.mjs can only do the
//first. Neither the BIOS nor any disc is copied into this repository, now or ever; both are named by
//absolute path and read from where they already live.
//
//Both builds are started from one synchronized state rather than from power, and this is not a
//convenience. System::power calls random.entropy(Random::Entropy::High) and CPU::power then fills
//the 2 MiB of main RAM and the scratchpad from it (ares/ps1/system/system.cpp:130,
//ares/ps1/cpu/cpu.cpp:157-158), so no two power cycles produce the same machine -- in one build or
//across two -- and a synchronized state records the difference down to the byte. Comparing two
//independently powered machines would report that entropy as a divergence and the comparison would
//mean nothing. Seeding from a state the web build wrote is the interchange a desktop build has to
//honour anyway, and it leaves scheduling as the only thing left for the comparison to see.
//
//Four things are compared, in rising order of how hard they are to fool. How many of the measured
//frames are distinct catches a run that stopped moving. The ordered sequence hash over the per-frame
//video hashes catches a frame that moved to the wrong place as well as one that changed. The audio
//hash covers a chip the picture cannot show. And the bytes of a synchronized save state, compared in
//full, catch a divergence that has not yet reached a pixel or a sample at all -- two builds can paint
//the same picture from machines that differ. The two memory cards are compared for the same reason,
//and are the only one of the four that a disc is normally expected to leave untouched.
//
//The settle is long on purpose: 3,000 frames is fifty seconds, which is what it takes a disc to get
//past the BIOS, past its own publisher screens and into attract mode, where the GPU, the SPU and the
//drive are all busy at once. Measured at power instead, the comparison would be almost entirely a
//comparison of the BIOS.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve, dirname, join, basename} from "node:path";
import {readFileSync} from "node:fs";

const webPath = process.argv[2];
const referencePath = process.argv[3];
const discPaths = process.argv.slice(4);
const biosPath = process.env.ARES_PS1_BIOS;
const measureFrames = Number(process.env.ARES_PS1_FRAMES ?? 600);
const settleFrames = Number(process.env.ARES_PS1_SETTLE ?? 3000);

const abort = message => {
  console.error(message);
  process.exit(1);
};

if(!webPath || !referencePath || !discPaths.length) {
  abort("usage: ARES_PS1_BIOS=... node wasm/ps1-sweep.mjs <web module> <cothread module> <disc.cue ...>");
}
if(!biosPath) abort("ARES_PS1_BIOS must name a BIOS image; this console has no substitute for one");

const bios = new Uint8Array(readFileSync(biosPath));

//a .cue names its track files by their bare filenames and vfs::cdrom opens each as a sibling of the
//sheet, so every one has to be staged under exactly the name the sheet spells -- which is not always
//the name the host filesystem spells, and a case-insensitive host has been hiding that difference
//for twenty years. Reading through the host's spelling and staging under the sheet's keeps both happy.
const readDisc = path => {
  const cue = new Uint8Array(readFileSync(path));
  const names = [...Buffer.from(cue).toString("latin1").matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map(m => m[1]);
  if(!names.length) abort(`${path} names no FILE; it does not look like a cue sheet`);
  return {
    name: basename(path),
    cue,
    tracks: names.map(name => ({name, bytes: new Uint8Array(readFileSync(join(dirname(path), name)))})),
  };
};

const checksum = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = value => (value >>> 0).toString(16).padStart(8, "0");
const equal = (a, b) => !!a && !!b && a.length === b.length && a.every((byte, index) => byte === b[index]);

//a module factory, so every run gets a fresh instance rather than re-powering one. this core carries
//a resampler, a screen canvas and an expanded disc image that a second power cycle would inherit, and
//none of that is what the comparison is trying to see.
const load = async (path) => {
  const moduleUrl = pathToFileURL(resolve(path));
  const {default: createAresPs1} = await import(moduleUrl);
  return () => createAresPs1({locateFile: file => fileURLToPath(new URL(file, moduleUrl))});
};

const boot = async (instantiate, disc) => {
  const core = await instantiate();
  const put = bytes => {
    const pointer = core._ares_ps1_alloc(bytes.length);
    core.HEAPU8.set(bytes, pointer);
    return pointer;
  };
  const biosPointer = put(bios);
  core._ares_ps1_set_bios(biosPointer, bios.length);
  core._ares_ps1_free(biosPointer);
  for(const track of disc.tracks) {
    const namePointer = put(new TextEncoder().encode(`${track.name}\0`));
    const dataPointer = put(track.bytes);
    const staged = core._ares_ps1_stage(namePointer, dataPointer, track.bytes.length);
    core._ares_ps1_free(namePointer);
    core._ares_ps1_free(dataPointer);
    if(!staged) throw new Error(core.UTF8ToString(core._ares_ps1_error()));
  }
  core._ares_ps1_set_audio_frequency(48000);
  const pointer = put(disc.cue);
  const loaded = core._ares_ps1_load(pointer, disc.cue.length);
  core._ares_ps1_free(pointer);
  if(!loaded) throw new Error(core.UTF8ToString(core._ares_ps1_error()));
  return {core, put};
};

//the machine both builds start the measured frames from, taken once per disc from the web build
const seedState = async (instantiate, disc) => {
  const {core} = await boot(instantiate, disc);
  for(let frame = 0; frame < settleFrames; frame++) core._ares_ps1_run_frame();
  core._ares_ps1_state_save(1);
  const size = core._ares_ps1_state_size();
  if(!size) throw new Error(core.UTF8ToString(core._ares_ps1_error()));
  const seed = new Uint8Array(core.HEAPU8.buffer, core._ares_ps1_state_data(), size).slice();
  core._ares_ps1_unload();
  return seed;
};

//a run returns one hash per frame, one hash over the whole audio stream, and the two blobs the
//machine can be asked for afterwards, in full
const run = async (instantiate, disc, seed) => {
  const {core, put} = await boot(instantiate, disc);
  const seedPointer = put(seed);
  const restored = core._ares_ps1_state_load(seedPointer, seed.length);
  core._ares_ps1_free(seedPointer);
  if(!restored) throw new Error(core.UTF8ToString(core._ares_ps1_error()));

  const video = [];
  let audio = 2166136261;
  let audioFrames = 0;
  let silent = true;
  let elapsed = 0;
  for(let frame = 0; frame < measureFrames; frame++) {
    const start = performance.now();
    core._ares_ps1_run_frame();
    elapsed += performance.now() - start;

    const width = core._ares_ps1_video_width();
    const height = core._ares_ps1_video_height();
    //the extent goes into the hash with the pixels: this console changes video mode inside a game,
    //and a frame that came back the right pixels at the wrong size is still a divergence
    video.push(checksum(checksum(2166136261, new Uint8Array(Uint32Array.of(width, height).buffer)),
      new Uint8Array(core.HEAPU8.buffer, core._ares_ps1_video_data(), width * height * 4)) >>> 0);

    const count = core._ares_ps1_audio_frames();
    audioFrames += count;
    const samples = new Float32Array(core.HEAPU8.buffer, core._ares_ps1_audio_data(), count * 2);
    if(silent) silent = samples.every(sample => sample === 0);
    audio = checksum(audio, new Uint8Array(samples.buffer, samples.byteOffset, count * 8));
  }

  core._ares_ps1_state_save(1);
  const stateSize = core._ares_ps1_state_size();
  const state = stateSize
    ? new Uint8Array(core.HEAPU8.buffer, core._ares_ps1_state_data(), stateSize).slice() : null;

  core._ares_ps1_save_ram_save();
  const cardSize = core._ares_ps1_save_ram_size();
  const cards = cardSize
    ? new Uint8Array(core.HEAPU8.buffer, core._ares_ps1_save_ram_data(), cardSize).slice() : null;

  core._ares_ps1_unload();
  return {
    video, audio: audio >>> 0, audioFrames, silent,
    distinct: new Set(video).size,
    sequence: video.reduce((hash, frame) => checksum(hash, [
      frame & 0xff, frame >> 8 & 0xff, frame >> 16 & 0xff, frame >>> 24,
    ]), 2166136261) >>> 0,
    state, cards, ms: elapsed / measureFrames,
  };
};

const web = await load(webPath);
const reference = await load(referencePath);

let failures = 0;
for(const path of discPaths) {
  const disc = readDisc(path);
  const seed = await seedState(web, disc);
  const a = await run(web, disc, seed);
  const b = await run(reference, disc, seed);

  const describe = (build, r) => console.log([
    `${disc.name}  ${build.padEnd(8)} ${r.ms.toFixed(2)} ms/frame (${(1000 / r.ms).toFixed(1)} fps)`,
    `video ${hex(r.sequence)} (${r.distinct}/${measureFrames} distinct)`,
    `audio ${hex(r.audio)} (${(r.audioFrames / measureFrames).toFixed(1)}/frame)`,
    `state ${r.state ? r.state.length : 0}:${hex(checksum(2166136261, r.state ?? []))}`,
    `cards ${r.cards ? r.cards.length : 0}:${hex(checksum(2166136261, r.cards ?? []))}`,
  ].join("  "));
  describe("web", a);
  describe("cothread", b);

  //a run that stopped moving, or one with no sound in it, agrees with a reference that did the same
  //and proves nothing; both are reported as failures rather than as a clean comparison
  if(a.distinct < 2) {
    console.log(`  every measured frame is identical; the comparison is vacuous`);
    failures++;
  }
  if(a.silent) {
    console.log(`  silence; the audio comparison is vacuous`);
    failures++;
  }

  const differing = a.video.findIndex((hash, frame) => hash !== b.video[frame]);
  const same = differing < 0 && a.audio === b.audio
            && equal(a.state, b.state) && equal(a.cards, b.cards);
  console.log(`  vs cothread  speedup ${(b.ms / a.ms).toFixed(2)}x  ${same ? "identical" : "DIVERGED"}`);
  if(!same) {
    failures++;
    if(differing >= 0) console.log(`    first differing video frame ${differing}`);
    if(a.audio !== b.audio) console.log(`    audio ${hex(a.audio)} vs ${hex(b.audio)}`);
    if(!equal(a.state, b.state)) {
      const bytes = a.state && b.state && a.state.length === b.state.length
        ? `${a.state.filter((byte, index) => byte !== b.state[index]).length} of ${a.state.length} bytes differ`
        : `${a.state?.length ?? 0} vs ${b.state?.length ?? 0} bytes`;
      console.log(`    state ${bytes}`);
    }
    if(!equal(a.cards, b.cards)) {
      console.log(`    memory cards ${a.cards?.length ?? 0} vs ${b.cards?.length ?? 0} bytes`);
    }
  }
}

if(failures) {
  console.log(`\n${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exitCode = 1;
}
