//Liveness for the PlayStation target: the core boots, produces a picture and a non-silent stereo
//stream, and its two persistence controls -- save state and memory card -- both round-trip. Fidelity
//lives in wasm/ps1-sweep.mjs.
//
//   node wasm/ps1-smoke.mjs [build_wasm_ps1/wasm/ares-ps1.mjs] [frames] [disc.cue ...]
//   ARES_PS1_BIOS=/absolute/path/to/scph5501.bin
//
//The first row always runs and needs no file anybody owns: wasm/ps1-stress-rom.mjs synthesizes both
//halves of it, a stub BIOS and a PS-X EXE. Every row after it needs a real BIOS, because that is the
//one thing this console cannot be given a substitute for -- the reset vector is inside it, and Sony's
//image is not in this repository and will not be. Name no disc and the BIOS boots into its own shell
//with an empty tray, which is a configuration the machine really has; name discs and each is booted
//in turn. Both take their paths from the command line and the environment and nothing is ever copied
//into the tree.
//
//Two numbers below are console-specific rather than boilerplate.
//
//The picture is late, and so is the disc. A real BIOS leaves the display disabled for roughly its
//first 230 frames while it sets the hardware up, and it does not look at the drive until about frame
//580 -- before that a machine with a disc in the tray and a machine with an empty one are the same
//machine, frame for frame, and a disc row measured there would hash identically to the empty-tray
//row and prove nothing about the disc. `settleFrames` is set past both, which is why every row here
//has half a second of real work in front of it. It is deliberately not carried as far as the game --
//a disc takes about 1,800 frames to reach one -- so the per-frame cost reported here is the cost of
//the BIOS boot sequence, not of a game. wasm/ps1-sweep.mjs, which seeds from a state taken deep into
//attract mode, is where a game's frame time is measured.
//
//And the battery is never empty and never the cartridge's. This machine has no cartridge: its whole
//persistent memory is the two 128 KiB memory cards, which ares seats on every model, so every row
//gathers exactly two entries whatever is in the tray -- including the row with nothing in it.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve, dirname, join, basename} from "node:path";
import {readFileSync} from "node:fs";
import {buildStressRom, buildStubBios} from "./ps1-stress-rom.mjs";

const modulePath = process.argv[2] ?? "build_wasm_ps1/wasm/ares-ps1.mjs";
const frameCount = Number(process.argv[3] ?? 120);
const discPaths = process.argv.slice(4);
const biosPath = process.env.ARES_PS1_BIOS;
//far enough in that the BIOS has both put a picture up and read the tray; see the header
const settleFrames = 600;

const fnv1a = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");
const abort = message => {
  console.error(message);
  process.exit(1);
};

if(!Number.isFinite(frameCount) || frameCount < 1) {
  abort(`Frame count must be a positive number, not ${JSON.stringify(process.argv[3])}`);
}

const moduleUrl = pathToFileURL(resolve(modulePath));
const {default: createAresPs1} = await import(moduleUrl);
const instantiate = () => createAresPs1({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});

//a .cue names its track files by their bare filenames and vfs::cdrom opens each as a sibling of the
//sheet, so every one has to be staged under exactly the name the sheet spells -- which is not always
//the name the host filesystem spells. Cue sheets in the wild write "GAME.BIN" beside a game.bin, and
//a case-insensitive host has been resolving that difference silently for twenty years; the module's
//in-memory filesystem will not. Reading through the host's spelling and staging under the sheet's is
//what keeps both happy.
const readDisc = path => {
  const cue = new Uint8Array(readFileSync(path));
  const text = Buffer.from(cue).toString("latin1");
  const tracks = [...text.matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map(match => match[1]);
  if(!tracks.length) abort(`${path} names no FILE; it does not look like a cue sheet`);
  return {
    cue,
    tracks: tracks.map(name => ({name, bytes: new Uint8Array(readFileSync(join(dirname(path), name)))})),
  };
};

const rows = [{name: "stress executable", bios: buildStubBios(), image: buildStressRom(), tracks: [], settle: 20}];
if(biosPath) {
  const bios = new Uint8Array(readFileSync(biosPath));
  rows.push({name: `${basename(biosPath)}, empty tray`, bios, image: null, tracks: [],
    settle: settleFrames, emptyTray: true});
  for(const path of discPaths) {
    const disc = readDisc(path);
    rows.push({name: basename(path), bios, image: disc.cue, tracks: disc.tracks,
      settle: settleFrames, disc: true});
  }
} else if(discPaths.length) {
  abort("Discs were named but ARES_PS1_BIOS is not set; a disc cannot be booted without a BIOS");
}

const failures = [];
//the empty-tray row's picture, which every disc row's has to differ from: the two machines run
//frame-identical until the BIOS looks at the drive, so a disc row that still hashes like this one is
//a disc row that has not yet read anything off the disc
let emptyTrayHash = null;

//a load with no BIOS must be refused: this console's reset vector is inside one
{
  const probe = await instantiate();
  const rom = buildStressRom();
  const pointer = probe._ares_ps1_alloc(rom.length);
  probe.HEAPU8.set(rom, pointer);
  if(probe._ares_ps1_load(pointer, rom.length)) failures.push("a load with no BIOS was accepted");
  probe._ares_ps1_free(pointer);
}

for(const row of rows) {
  const module = await instantiate();
  const lastError = () => module.UTF8ToString(module._ares_ps1_error()) || "no reason given";
  const put = bytes => {
    const pointer = module._ares_ps1_alloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    return pointer;
  };
  //both buffers live in vectors that resize with the video mode and with however many samples a
  //frame produced, so the pointer and the length are re-read every frame rather than cached once
  const videoBytes = () => new Uint8Array(module.HEAPU8.buffer, module._ares_ps1_video_data(),
    module._ares_ps1_video_width() * module._ares_ps1_video_height() * 4);
  const audioBytes = () => new Uint8Array(module.HEAPU8.buffer, module._ares_ps1_audio_data(),
    module._ares_ps1_audio_frames() * 2 * 4);

  const biosPointer = put(row.bios);
  module._ares_ps1_set_bios(biosPointer, row.bios.length);
  module._ares_ps1_free(biosPointer);

  //every track file first, under the sheet's own spelling, then the sheet itself. The load consumes
  //them and drops them again, so nothing but the expanded image stays resident.
  for(const track of row.tracks) {
    const namePointer = put(new TextEncoder().encode(`${track.name}\0`));
    const dataPointer = put(track.bytes);
    const staged = module._ares_ps1_stage(namePointer, dataPointer, track.bytes.length);
    module._ares_ps1_free(namePointer);
    module._ares_ps1_free(dataPointer);
    if(!staged) abort(`${row.name}: could not stage ${track.name}: ${lastError()}`);
  }

  module._ares_ps1_set_audio_frequency(48000);
  const imagePointer = row.image ? put(row.image) : 0;
  const loaded = module._ares_ps1_load(imagePointer, row.image ? row.image.length : 0);
  if(imagePointer) module._ares_ps1_free(imagePointer);
  if(!loaded) abort(`${row.name}: could not load: ${lastError()}`);

  for(let frame = 0; frame < row.settle; frame++) module._ares_ps1_run_frame();

  //the switch counter only exists in an -DARES_WASM_DEBUG=ON build; say so rather than report a zero
  //that would read as a suspiciously good result
  const switchBase = module._ares_ps1_switch_count?.() ?? 0;
  let videoHash = 2166136261;
  let audioHash = 2166136261;
  let audioFrames = 0;
  let coreTime = 0;
  const distinct = new Set();
  for(let frame = 0; frame < frameCount; frame++) {
    const start = performance.now();
    module._ares_ps1_run_frame();
    coreTime += performance.now() - start;
    audioFrames += module._ares_ps1_audio_frames();
    const pixels = videoBytes();
    videoHash = fnv1a(videoHash, pixels);
    audioHash = fnv1a(audioHash, audioBytes());
    distinct.add(fnv1a(2166136261, pixels));
  }
  const switchesPerFrame = module._ares_ps1_switch_count
    ? Math.round((module._ares_ps1_switch_count() - switchBase) / frameCount)
    : "unavailable (needs -DARES_WASM_DEBUG=ON)";

  const width = module._ares_ps1_video_width();
  const height = module._ares_ps1_video_height();
  const pixels = videoBytes();
  let lit = 0;
  for(let pixel = 0; pixel < pixels.length; pixel += 4) {
    if(pixels[pixel] | pixels[pixel + 1] | pixels[pixel + 2]) lit++;
  }
  const samples = new Float32Array(module.HEAPU8.buffer, module._ares_ps1_audio_data(),
    module._ares_ps1_audio_frames() * 2);
  const silent = samples.every(sample => sample === 0);

  const fail = message => failures.push(`${row.name}: ${message}`);

  //(a) the state. synchronize = 1 runs the scheduler to a safe point first, which is the whole
  //difference between bytes desktop ares would accept and bytes that mean something only inside this
  //process; a run-ahead state (0) embeds raw cothread stacks full of host pointers. The check is that
  //the ten frames after a restore are the ten frames that followed the save, hashed pixel for pixel.
  module._ares_ps1_state_save(1);
  const stateSize = module._ares_ps1_state_size();
  if(!stateSize) abort(`${row.name}: could not save a state: ${lastError()}`);
  const state = new Uint8Array(module.HEAPU8.buffer, module._ares_ps1_state_data(), stateSize).slice();

  const probe = () => {
    let hash = 2166136261;
    for(let frame = 0; frame < 10; frame++) {
      module._ares_ps1_run_frame();
      hash = fnv1a(hash, videoBytes());
    }
    return hex(hash);
  };

  const beforeLoad = probe();
  const statePointer = put(state);
  const restored = module._ares_ps1_state_load(statePointer, stateSize);
  module._ares_ps1_free(statePointer);
  if(!restored) abort(`${row.name}: could not load the state back: ${lastError()}`);
  const afterLoad = probe();
  if(beforeLoad !== afterLoad) {
    fail(`the ten frames after a state load hashed ${afterLoad}, not the ${beforeLoad} that followed the save`);
  }

  //(b) the battery, in the container wasm/save-ram.hpp documents: "ARSV", a version, an entry count,
  //then one named entry per memory. Reading the count rather than only the magic is what tells two
  //gathered memory cards apart from a header written over nothing.
  module._ares_ps1_save_ram_save();
  const batterySize = module._ares_ps1_save_ram_size();
  if(!batterySize) abort(`${row.name}: the console gathered no memory cards at all: ${lastError()}`);
  const battery = new Uint8Array(module.HEAPU8.buffer, module._ares_ps1_save_ram_data(), batterySize).slice();
  const batteryWords = new DataView(battery.buffer);
  const batteryMagic = String.fromCharCode(...battery.subarray(0, 4));
  const batteryVersion = batterySize >= 12 ? batteryWords.getUint32(4, true) : 0;
  const batteryEntries = batterySize >= 12 ? batteryWords.getUint32(8, true) : 0;
  if(batteryMagic !== "ARSV") fail(`battery blob starts with ${JSON.stringify(batteryMagic)}, not "ARSV"`);
  if(batteryVersion !== 1) fail(`battery blob is version ${batteryVersion}, not 1`);
  if(batteryEntries !== 2) fail(`battery blob holds ${batteryEntries} entries; the two memory cards are always both there`);

  //restoring re-seats both cards and power cycles the machine, so it runs last
  const batteryPointer = put(battery);
  const batteryLoaded = module._ares_ps1_save_ram_load(batteryPointer, battery.length);
  module._ares_ps1_free(batteryPointer);
  if(!batteryLoaded) abort(`${row.name}: could not load the memory cards back: ${lastError()}`);

  const result = {
    row: row.name,
    videoWidth: width,
    videoHeight: height,
    litPixels: `${(100 * lit / (width * height || 1)).toFixed(1)}%`,
    distinctFrames: `${distinct.size}/${frameCount}`,
    audioFramesPerFrame: +(audioFrames / frameCount).toFixed(1),
    msPerFrame: +(coreTime / frameCount).toFixed(2),
    fps: +(frameCount * 1000 / coreTime).toFixed(1),
    switchesPerFrame,
    videoHash: hex(videoHash),
    audioHash: hex(audioHash),
    stateSize,
    stateRoundTrip: beforeLoad === afterLoad ? "identical" : `${beforeLoad} != ${afterLoad}`,
    batterySize,
    batteryMagic,
    batteryEntries,
  };
  console.log(JSON.stringify(result));

  if(!width || !height) fail("the core reported an empty picture");
  if(!lit) fail("every pixel of the picture is black");
  if(!audioFrames) fail("no audio frames were produced");
  if(silent) fail("the last frame's audio is entirely silent");
  if(distinct.size < 2) fail("every measured frame is identical; the machine never advanced");
  if(row.emptyTray) emptyTrayHash = result.videoHash;
  if(row.disc && result.videoHash === emptyTrayHash) {
    fail(`hashes ${result.videoHash}, the same as the empty tray; nothing was read off the disc`);
  }

  module._ares_ps1_unload();
}

if(failures.length) {
  for(const failure of failures) console.error(failure);
  process.exit(1);
}
