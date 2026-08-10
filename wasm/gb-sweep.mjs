//Compares the web build's synchronous Game Boy scheduling against the cothread scheduler.
//
//Like ms and md, this core has no batching granularity to sweep, so the reference is a second wasm
//build of the same sources with the PLATFORM_WEB fast paths compiled out:
//
//   emcmake cmake -S . -B build_wasm_gb_cothread -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=gb -DCMAKE_CXX_FLAGS=-DARES_GB_COTHREAD
//   cmake --build build_wasm_gb_cothread --target ares-gb-wasm
//
//   node wasm/gb-sweep.mjs build_wasm/wasm/ares-gb.mjs [build_wasm_gb_cothread/wasm/ares-gb.mjs] [frames]
//
//Whole concatenated sample streams are compared rather than per-frame hashes: where a frame
//boundary falls is a scheduling detail, and a per-frame hash reports a shift as a difference even
//when the waveform is identical. Video is compared frame by frame, which is exact regardless. A
//control run of the web build against itself proves a reported difference is a divergence and not
//run-to-run noise. The golden hashes below are literal so that any future edit to PPU::runCycle()
//fails loudly.
//
//Naming a single module runs the golden check alone, which needs no reference build.
//
//Unlike the other sweeps each configuration carries its own cartridge image, because what is being
//varied -- the colour flag, the double-speed switch, the display-off arm -- is chosen by the
//program and by the header, not only by the machine model.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom} from "./gb-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm/wasm/ares-gb.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
//the boot ROM scrolls the Nintendo logo and holds it before handing control to the cartridge, and
//that animation outlasts every other core's settle window. measuring inside it would compare the
//boot ROM rather than the program.
const settleFrames = 240;

const configurations = [
  {name: "dmg", model: "[Nintendo] Game Boy", rom: {}},
  {name: "cgb", model: "[Nintendo] Game Boy Color", rom: {color: true}},
  {name: "cgb-double", model: "[Nintendo] Game Boy Color", rom: {color: true, doubleSpeed: true}},
  {name: "lcd-off", model: "[Nintendo] Game Boy", rom: {lcdOff: true}},
  //an empty model makes ares_gb_load read the cartridge's own $0143 flag. every configuration above
  //names a model outright, so without this row the colour half of the autodetect is never executed
  //at all -- the only image the other harnesses autodetect is $0143 = 0x00.
  {name: "cgb-auto", model: "", rom: {color: true}, sameAs: "cgb"},
];

//recorded at the default 300 frames from a build that matched the cothread reference 4/4; the
//check is skipped for any other frame count. a golden taken from a diverging build is worthless,
//so these are only ever rerecorded alongside a passing web-vs-cothread run.
const golden = {
  "dmg": {audio: "d1b77291", video: "2a12fbf9"},
  "cgb": {audio: "c77f3b65", video: "96e2a6ff"},
  "cgb-double": {audio: "feb85a21", video: "96e2a6ff"},
  "lcd-off": {audio: "9c6717ad", video: "58ccc7a5"},
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

async function run(create, model, romOptions) {
  const module = await create();
  const rom = buildStressRom(romOptions);

  const name = new TextEncoder().encode(`${model}\0`);
  const namePointer = module._ares_gb_alloc(name.length);
  module.HEAPU8.set(name, namePointer);
  module._ares_gb_set_model(namePointer);
  module._ares_gb_free(namePointer);

  const pointer = module._ares_gb_alloc(rom.length);
  module.HEAPU8.set(rom, pointer);
  module._ares_gb_set_audio_frequency(48000);
  const loaded = module._ares_gb_load(pointer, rom.length);
  module._ares_gb_free(pointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_gb_error()));

  for(let frame = 0; frame < settleFrames; frame++) module._ares_gb_run_frame();

  //absent unless built with -DARES_WASM_DEBUG=ON; the delta is then reported as null rather than 0
  const switchesBefore = module._ares_gb_switch_count?.() ?? 0;
  const audio = [];
  const video = [];
  const start = performance.now();
  for(let frame = 0; frame < measureFrames; frame++) {
    module._ares_gb_run_frame();
    const frames = module._ares_gb_audio_frames();
    audio.push(new Float32Array(module.HEAPU8.buffer, module._ares_gb_audio_data(), frames * 2).slice());
    const width = module._ares_gb_video_width(), height = module._ares_gb_video_height();
    video.push(new Uint8Array(module.HEAPU8.buffer, module._ares_gb_video_data(), width * height * 4).slice());
  }
  const elapsed = performance.now() - start;
  const switches = module._ares_gb_switch_count
    ? (module._ares_gb_switch_count() - switchesBefore) >>> 0 : null;
  module._ares_gb_unload();

  const samples = new Float32Array(audio.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }

  let videoHash = 2166136261;
  for(const frame of video) videoHash = fnv1a(videoHash, frame);

  //a boot ROM that rejected the header locks up on a screen that never changes again. the program
  //scrolls both axes every frame, so a run whose frames are all identical did not reach it -- and
  //that failure is invisible to every hash comparison below, because a stable picture compares
  //equal to itself just as happily as a correct one does.
  const first = video[0];
  const staticPicture = video.every(frame =>
    frame.length === first.length && frame.every((byte, index) => byte === first[index]));

  return {
    model,
    staticPicture,
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: switches === null ? null : Math.round(switches / measureFrames),
    audioHash: hex(fnv1a(2166136261, new Uint8Array(samples.buffer))),
    videoHash: hex(videoHash),
    samples, video,
  };
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

const report = ({samples, video, ...rest}) => console.log(JSON.stringify(rest));

const createWeb = await load(webPath);
const createReference = referencePath ? await load(referencePath) : null;
let failures = 0;
const videoHashes = new Map();

const audioHashes = new Map();
const throughput = new Map();

for(const {name, model, rom, sameAs} of configurations) {
  const web = await run(createWeb, model, rom);
  report({configuration: name, build: "web", ...web});
  videoHashes.set(name, web.videoHash);
  audioHashes.set(name, web.audioHash);
  throughput.set(name, web.fps);

  //an autodetect row has to land on exactly what naming the model outright produces, or the header
  //read picked a different machine
  if(sameAs) {
    const ok = videoHashes.get(sameAs) === web.videoHash && audioHashes.get(sameAs) === web.audioHash;
    if(!ok) failures++;
    console.log(JSON.stringify({configuration: name, autodetect: ok ? `matches ${sameAs}` : `DIFFERS FROM ${sameAs}`}));
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
  report({configuration: name, build: "web-control", ...compare(web, await run(createWeb, model, rom))});

  if(createReference) {
    const reference = await run(createReference, model, rom);
    report({configuration: name, build: "cothread", ...reference});
    const difference = compare(reference, web);
    if(difference.audio !== "identical" || difference.screen !== "identical") failures++;
    report({configuration: name, build: "web-vs-cothread", ...difference});

    //identical output is only evidence if the reference really is a cothread build. were
    //-DARES_GB_COTHREAD to stop taking effect -- a typo in the guard, a stale build directory --
    //this comparison would pass trivially by comparing the web build against itself, and nothing
    //else in the tree would notice. the speed gap is what distinguishes the two schedulers.
    const ratio = +(web.fps / reference.fps).toFixed(1);
    const distinguishable = ratio >= 4;
    if(!distinguishable) failures++;
    console.log(JSON.stringify({
      configuration: name,
      speedup: ratio,
      reference: distinguishable ? "is a cothread build" : "IS NOT DISTINGUISHABLE FROM THE WEB BUILD",
    }));
  }
}

//the model has to reach the picture, or ares_gb_set_model is decorative and the colour path is
//never measured at all. this is deliberately not a demand that all four hashes differ: cgb-double
//shares cgb's picture and is right to. the program paces its loop on vblank and scrolls once per
//frame, so doubling the cpu clock changes how much idle time each frame holds, not what it draws.
//the audio hashes are where that configuration proves the switch happened.
if(videoHashes.get("dmg") === videoHashes.get("cgb")) {
  console.log(JSON.stringify({
    error: "the Game Boy and Game Boy Color models rendered identically; the model never took effect",
    videoHashes: Object.fromEntries(videoHashes),
  }));
  failures++;
}

if(failures) {
  console.error(`${failures} comparison(s) failed`);
  process.exit(1);
}
