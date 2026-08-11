//Compares the web build's synchronous Game Boy Advance scheduling against the cothread scheduler.
//
//Like ms, md and gb, this core has no batching granularity to sweep, so the reference is a second
//wasm build of the same sources with the PLATFORM_WEB fast paths compiled out:
//
//   emcmake cmake -S . -B build_wasm_gba_cothread -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=gba -DCMAKE_CXX_FLAGS=-DARES_GBA_COTHREAD
//   cmake --build build_wasm_gba_cothread --target ares-gba-wasm
//
//   node wasm/gba-sweep.mjs build_wasm/wasm/ares-gba.mjs [build_wasm_gba_cothread/wasm/ares-gba.mjs] [frames]
//
//Whole concatenated sample streams are compared rather than per-frame hashes: where a frame
//boundary falls is a scheduling detail, and a per-frame hash reports a shift as a difference even
//when the waveform is identical. Video is compared frame by frame, which is exact regardless. A
//control run of the web build against itself proves a reported difference is a divergence and not
//run-to-run noise. The golden hashes below are literal so that any future edit to the flat steppers
//fails loudly.
//
//Naming a single module runs the golden check alone, which needs no reference build.
//
//The `accurate` configuration is not a variation on the others: PPU::main() has two entirely
//separate arms, and pixel accuracy chooses between them. Without that row the per-cycle renderer --
//the whole of PPU::cycleAt() -- is never executed by any check here.
//
//Each row additionally compares the two builds' persistable save states byte for byte. Picture and
//sound only reach the chips that draw or sound; the state reaches all of them, which is what makes
//a chip like the cartridge clock -- whose position nothing on screen depends on -- checkable at all.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom, buildStubBios} from "./gba-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm/wasm/ares-gba.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
//the cartridge fills two VRAM regions, both palettes, the map and the object table before it
//enables the display; thirty frames is several times what that costs
const settleFrames = 30;

const configurations = [
  {name: "full", rom: {}},
  {name: "accurate", rom: {}, accurate: true},
  {name: "no-raster", rom: {raster: false}},
  {name: "no-dma", rom: {dma: false, fifo: false}},
  //a cartridge carrying the S3511A identifier, which is the only thing that brings its clock thread
  //up (Cartridge::load runs rtc.power() only when has.rtc). without this row that thread is never
  //created by any check here, and Cartridge::RTC::webAdvance -- one of the core's six overrides --
  //is dead code the sweep cannot see. nothing this cartridge draws depends on the clock, so the
  //picture is expected to be `full`'s exactly; what proves the clock itself keeps step is the state
  //comparison below, which covers the rtc thread's own counter and clock.
  {name: "rtc", rom: {rtc: true}, sameAs: "full"},
  //the Game Boy Player is the same silicon with a rumble node and a per-frame screen hash; it runs
  //through System::run()'s second arm, which no other row reaches. it is expected to render exactly
  //what `full` does, and that is asserted rather than assumed: the player only diverges once a game
  //performs its serial handshake, which this cartridge never does, so identical output is the right
  //answer and a divergence would mean the model reached something it should not have.
  {name: "player", rom: {}, model: "[Nintendo] Game Boy Player", sameAs: "full"},
];

//recorded at the default 300 frames from a build that matched the cothread reference 5/5; the
//check is skipped for any other frame count. a golden taken from a diverging build is worthless,
//so these are only ever rerecorded alongside a passing web-vs-cothread run.
const golden = {
  "full": {audio: "977f88d1", video: "38a1c326"},
  "accurate": {audio: "d6bc8965", video: "6c9ab171"},
  "no-raster": {audio: "50a4fa39", video: "402acfa0"},
  "no-dma": {audio: "9d110dd9", video: "fd301859"},
  "player": {audio: "977f88d1", video: "38a1c326"},
  "rtc": {audio: "977f88d1", video: "38a1c326"},
};

function fnv1a(hash, bytes) {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
}

const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");

async function load(path) {
  const url = pathToFileURL(resolve(path));
  const {default: create} = await import(url);
  return () => create({locateFile: name => fileURLToPath(new URL(name, url))});
}

async function run(create, {rom: romOptions, accurate, model}) {
  const module = await create();
  const rom = buildStressRom(romOptions);
  const bios = buildStubBios();

  const upload = (bytes, call) => {
    const pointer = module._ares_gba_alloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    const result = call(pointer, bytes.length);
    module._ares_gba_free(pointer);
    return result;
  };

  upload(bios, (pointer, size) => module._ares_gba_set_bios(pointer, size));
  if(model) {
    const name = new TextEncoder().encode(`${model}\0`);
    upload(name, pointer => module._ares_gba_set_model(pointer));
  }
  module._ares_gba_set_pixel_accuracy(accurate ? 1 : 0);
  module._ares_gba_set_audio_frequency(48000);
  if(!upload(rom, (pointer, size) => module._ares_gba_load(pointer, size))) {
    throw new Error(module.UTF8ToString(module._ares_gba_error()));
  }

  for(let frame = 0; frame < settleFrames; frame++) module._ares_gba_run_frame();

  //absent unless built with -DARES_WASM_DEBUG=ON; the delta is then reported as null rather than 0
  const switchesBefore = module._ares_gba_switch_count?.() ?? 0;
  const audio = [];
  const video = [];
  const start = performance.now();
  for(let frame = 0; frame < measureFrames; frame++) {
    module._ares_gba_run_frame();
    const frames = module._ares_gba_audio_frames();
    audio.push(new Float32Array(module.HEAPU8.buffer, module._ares_gba_audio_data(), frames * 2).slice());
    const width = module._ares_gba_video_width(), height = module._ares_gba_video_height();
    video.push(new Uint8Array(module.HEAPU8.buffer, module._ares_gba_video_data(), width * height * 4).slice());
  }
  const elapsed = performance.now() - start;
  const switches = module._ares_gba_switch_count
    ? (module._ares_gba_switch_count() - switchesBefore) >>> 0 : null;

  //a synchronized state, taken here rather than in a harness of its own because both builds are
  //already standing on the same frame. it describes every chip's position, so comparing the two
  //builds' bytes reaches machine state the picture and the sound cannot: a chip nothing on screen
  //depends on -- the cartridge clock is the case that prompted this -- would keep step or not keep
  //step invisibly, and the whole retire mechanism in CPU::mainWeb() exists to put those chips
  //exactly where a cothread build's synchronization walk leaves them.
  module._ares_gba_state_save(1);
  const stateSize = module._ares_gba_state_size();
  const state = new Uint8Array(module.HEAPU8.buffer, module._ares_gba_state_data(), stateSize).slice();

  module._ares_gba_unload();

  const samples = new Float32Array(audio.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }

  let videoHash = 2166136261;
  for(const frame of video) videoHash = fnv1a(videoHash, frame);

  //a cartridge that locked up renders a screen that never changes again. this one scrolls and
  //animates its objects every frame, so a run whose frames are all identical did not reach the
  //program -- and that failure is invisible to every hash comparison below, because a stable
  //picture compares equal to itself just as happily as a correct one does.
  const first = video[0];
  const staticPicture = video.every(frame =>
    frame.length === first.length && frame.every((byte, index) => byte === first[index]));

  return {
    staticPicture,
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: switches === null ? null : Math.round(switches / measureFrames),
    audioHash: hex(fnv1a(2166136261, new Uint8Array(samples.buffer))),
    videoHash: hex(videoHash),
    samples, video, state,
  };
}

//the two builds' persistable states, byte for byte. the layout is native's on both -- the flat
//steppers' positions are gated out of a synchronized state exactly as Thread::serialize() gates the
//cothread stacks -- so a difference here is a chip in the wrong place, not a format mismatch.
function compareState(reference, candidate) {
  if(reference.length !== candidate.length) return `${reference.length} vs ${candidate.length} bytes`;
  let differing = 0, first = -1;
  for(let index = 0; index < reference.length; index++) {
    if(reference[index] !== candidate[index]) { if(first < 0) first = index; differing++; }
  }
  return differing === 0 ? "identical" : `${differing}/${reference.length} bytes, first at ${first}`;
}

function compare(reference, candidate) {
  const count = Math.min(reference.samples.length, candidate.samples.length);
  let differing = 0, noise = 0, signal = 0;
  for(let index = 0; index < count; index++) {
    const a = reference.samples[index], b = candidate.samples[index];
    if(a !== b) differing++;
    noise += (a - b) ** 2;
    signal += a ** 2;
  }
  let framesDiffering = 0, pixelsDiffering = 0, pixelsTotal = 0, firstFrame = null;
  reference.video.forEach((frame, index) => {
    const other = candidate.video[index];
    pixelsTotal += frame.length / 4;
    if(!other || other.length !== frame.length) { framesDiffering++; return; }
    let differingHere = 0;
    for(let pixel = 0; pixel < frame.length; pixel += 4) {
      if(frame[pixel + 0] !== other[pixel + 0] || frame[pixel + 1] !== other[pixel + 1]
      || frame[pixel + 2] !== other[pixel + 2] || frame[pixel + 3] !== other[pixel + 3]) {
        if(firstFrame === null) firstFrame = {frame: index, pixel: pixel / 4};
        differingHere++;
      }
    }
    if(differingHere) framesDiffering++;
    pixelsDiffering += differingHere;
  });
  return {
    lengths: reference.samples.length === candidate.samples.length ? "equal"
      : `${reference.samples.length} vs ${candidate.samples.length}`,
    audio: differing === 0 ? "identical"
      : `${(100 * differing / count).toFixed(1)}% differ, ${(10 * Math.log10(signal / noise)).toFixed(1)} dB SNR`,
    screen: framesDiffering === 0 ? "identical"
      : `${framesDiffering}/${reference.video.length} frames, ${(100 * pixelsDiffering / pixelsTotal).toFixed(2)}%`
        + ` of pixels, first at frame ${firstFrame.frame} pixel ${firstFrame.pixel}`,
  };
}

const report = ({samples, video, state, ...rest}) => console.log(JSON.stringify(rest));

const createWeb = await load(webPath);
const createReference = referencePath ? await load(referencePath) : null;
let failures = 0;
const videoHashes = new Map();

const audioHashes = new Map();

for(const configuration of configurations) {
  const {name, sameAs} = configuration;
  const web = await run(createWeb, configuration);
  report({configuration: name, build: "web", ...web});
  videoHashes.set(name, web.videoHash);
  audioHashes.set(name, web.audioHash);

  if(sameAs) {
    const ok = videoHashes.get(sameAs) === web.videoHash && audioHashes.get(sameAs) === web.audioHash;
    if(!ok) failures++;
    console.log(JSON.stringify({configuration: name, matches: ok ? sameAs : `DIFFERS FROM ${sameAs}`}));
  }

  if(web.samples.every(sample => sample === 0)) {
    console.log(JSON.stringify({configuration: name, error: "silence; the audio comparison is vacuous"}));
    failures++;
  }

  if(web.staticPicture) {
    console.log(JSON.stringify({configuration: name, error: "the picture never changes; the program did not run"}));
    failures++;
  }

  const expected = measureFrames === 300 ? golden[name] : null;
  if(expected) {
    const ok = expected.audio === web.audioHash && expected.video === web.videoHash;
    if(!ok) failures++;
    console.log(JSON.stringify({configuration: name, golden: ok ? "match" : "MISMATCH", expected}));
  }

  //a second web run, to show the comparison below measures scheduling and not run-to-run noise
  const control = await run(createWeb, configuration);
  report({
    configuration: name, build: "web-control",
    ...compare(web, control), machine: compareState(control.state, web.state),
  });

  if(createReference) {
    const reference = await run(createReference, configuration);
    report({configuration: name, build: "cothread", ...reference});
    const difference = compare(reference, web);
    const machine = compareState(reference.state, web.state);
    if(difference.audio !== "identical" || difference.screen !== "identical") failures++;
    if(machine !== "identical") failures++;
    report({configuration: name, build: "web-vs-cothread", ...difference, machine});

    //identical output is only evidence if the reference really is a cothread build. were
    //-DARES_GBA_COTHREAD to stop taking effect -- a typo in the guard, a stale build directory --
    //this comparison would pass trivially by comparing the web build against itself, and nothing
    //else in the tree would notice. the speed gap is what distinguishes the two schedulers.
    //the floor is well under the margin the heavier configurations show, because the lighter ones
    //genuinely have fewer switches to remove; what it has to separate is a cothread build from the
    //web build measured against itself, which would land at 1.0 plus noise
    const ratio = +(web.fps / reference.fps).toFixed(2);
    const distinguishable = ratio >= 1.10;
    if(!distinguishable) failures++;
    console.log(JSON.stringify({
      configuration: name,
      speedup: ratio,
      reference: distinguishable ? "is a cothread build" : "IS NOT DISTINGUISHABLE FROM THE WEB BUILD",
    }));
  }
}

//Continuing to play after taking a save state, which is the one thing every comparison above misses:
//they all save at the end and stop. Taking a synchronized state runs the machine to a safe point, and
//the two schedulers reach that point along different routes -- the web build's frame boundary is
//reached inside the cpu's cothread, because PPU::frame() runs there, where the cothread build's is
//reached inside the ppu's. The machines left behind are therefore not bit-identical: state-smoke has
//always reported gba's stateDriftBytes as 27 where its own cothread build reads 0, and that number
//is this. What it costs is what this measures, and the answer is nothing: over 300 frames, with four
//more states taken along the way to keep perturbing both machines, neither the picture nor the sound
//differs by a bit. The residual is bookkeeping that no later frame reads.
if(createReference) {
  const configuration = configurations[0];
  const w = await createWeb(), c = await createReference();
  const boot = async module => {
    const upload = (bytes, call) => {
      const pointer = module._ares_gba_alloc(bytes.length);
      module.HEAPU8.set(bytes, pointer);
      const result = call(pointer, bytes.length);
      module._ares_gba_free(pointer);
      return result;
    };
    upload(buildStubBios(), (p, size) => module._ares_gba_set_bios(p, size));
    module._ares_gba_set_pixel_accuracy(0);
    module._ares_gba_set_audio_frequency(48000);
    if(!upload(buildStressRom(configuration.rom), (p, size) => module._ares_gba_load(p, size))) {
      throw new Error(module.UTF8ToString(module._ares_gba_error()));
    }
    for(let frame = 0; frame < settleFrames; frame++) module._ares_gba_run_frame();
  };
  await boot(w); await boot(c);

  const state = module => { module._ares_gba_state_save(1); return module._ares_gba_state_size(); };
  const frame = module => {
    module._ares_gba_run_frame();
    const width = module._ares_gba_video_width(), height = module._ares_gba_video_height();
    return [new Uint8Array(module.HEAPU8.buffer, module._ares_gba_video_data(), width * height * 4).slice(),
            new Float32Array(module.HEAPU8.buffer, module._ares_gba_audio_data(), module._ares_gba_audio_frames() * 2).slice()];
  };
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

  state(w); state(c);
  let videoFrame = -1, audioFrame = -1;
  for(let index = 0; index < measureFrames; index++) {
    const [wv, wa] = frame(w), [cv, ca] = frame(c);
    if(videoFrame < 0 && !same(wv, cv)) videoFrame = index;
    if(audioFrame < 0 && !same(wa, ca)) audioFrame = index;
    if(index % 75 === 74) { state(w); state(c); }  //perturb both again, mid-run
  }
  const clean = videoFrame < 0 && audioFrame < 0;
  if(!clean) failures++;
  console.log(JSON.stringify({
    configuration: configuration.name, build: "after-a-save-state",
    frames: measureFrames,
    output: clean ? "identical" : `diverges at video frame ${videoFrame}, audio frame ${audioFrame}`,
  }));
}

//pixel accuracy has to reach the picture, or ares_gba_set_pixel_accuracy is decorative and
//PPU::cycleAt() is never measured at all
if(videoHashes.get("full") === videoHashes.get("accurate")) {
  console.log(JSON.stringify({
    error: "the two pixel-accuracy modes rendered identically; the setting never took effect",
    videoHashes: Object.fromEntries(videoHashes),
  }));
  failures++;
}

if(failures) {
  console.error(`${failures} comparison(s) failed`);
  process.exit(1);
}
