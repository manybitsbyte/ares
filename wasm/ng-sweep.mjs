//Compares the web build's synchronous Neo Geo scheduling against the cothread scheduler.
//
//The reference is a second wasm build of the same sources with the PLATFORM_WEB fast paths
//compiled out:
//
//   emcmake cmake -S . -B build_wasm_ng_cothread -DCMAKE_BUILD_TYPE=Release \
//     -Dsourcery_DIR="$PWD/build_native" -DARES_CORES=ng -DCMAKE_CXX_FLAGS=-DARES_NG_COTHREAD
//   cmake --build build_wasm_ng_cothread --target ares-ng-wasm
//
//   node wasm/ng-sweep.mjs build_wasm_ng/wasm/ares-ng.mjs [build_wasm_ng_cothread/wasm/ares-ng.mjs] [frames]
//
//Run from the repo root, with both module arguments. Naming a single module runs the golden check
//alone, which needs no reference build.
//
//Whole concatenated sample streams are compared rather than per-frame hashes: where a frame
//boundary falls is a scheduling detail, and a per-frame hash reports a shift as a difference even
//when the waveform is identical. Video is compared frame by frame, which is exact regardless. A
//control run of the web build against itself proves a reported difference is a divergence and not
//run-to-run noise. The bytes of a synchronized save state are compared per row, so a divergence
//that has not yet reached a pixel is still caught, and an `after-a-save-state` row keeps comparing
//once a state has been taken, because taking one runs the scheduler to a safe point and that is
//its own scheduling path.
//
//The four configurations pull one subsystem out at a time so a regression names its culprit:
//`no-timer` drops the LSPC timer interrupt, `no-nmi` keeps the 68000 off the Z80's command port,
//and `fm-only` silences both ADPCM units so the YM2610 never reads a voice ROM.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {buildStressRom, buildStubBios, romsetName} from "./ng-stress-rom.mjs";

const webPath = process.argv[2] ?? "build_wasm_ng/wasm/ares-ng.mjs";
const referencePath = process.argv[3];
const measureFrames = Number(process.argv[4] ?? 300);
const settleFrames = 20;

const configurations = [
  {name: "full", options: {}},
  {name: "no-timer", options: {noTimer: true}},
  {name: "no-nmi", options: {noNmi: true}},
  {name: "fm-only", options: {noAdpcm: true}},
];

//recorded at the default 300 frames from the cothread reference build; the check is skipped for
//any other frame count. any future edit to the web fast paths that shifts a pixel or a sample
//fails here even when both builds shift together.
const golden = {
  "full":     {audio: "a1870799", video: "79662087"},
  "no-timer": {audio: "55b97751", video: "201e4809"},
  "no-nmi":   {audio: "fc350e4d", video: "1f9fd11a"},
  "fm-only":  {audio: "53029df9", video: "79662087"},  //no-adpcm shifts no pixel; video = full's
};

const bios = buildStubBios();

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

//takeState runs the scheduler to a safe point after settling and keeps the resulting bytes, so the
//frames measured afterwards are the ones a machine that has just been saved produces
async function run(create, options, {takeState = false} = {}) {
  const module = await create();
  const rom = buildStressRom(options);

  const put = bytes => {
    const pointer = module._ares_ng_alloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    return pointer;
  };
  const biosPointer = put(bios);
  module._ares_ng_set_bios(biosPointer, bios.length);
  module._ares_ng_free(biosPointer);

  const romPointer = put(rom);
  const namePointer = put(new TextEncoder().encode(`${romsetName}\0`));
  module._ares_ng_set_audio_frequency(48000);
  const loaded = module._ares_ng_load(romPointer, rom.length, namePointer);
  module._ares_ng_free(romPointer);
  module._ares_ng_free(namePointer);
  if(!loaded) throw new Error(module.UTF8ToString(module._ares_ng_error()));

  for(let frame = 0; frame < settleFrames; frame++) module._ares_ng_run_frame();

  //a synchronized save; the bytes are copied out at once because memory growth invalidates views
  let stateBytes = null;
  if(takeState) {
    module._ares_ng_state_save(1);
    const size = module._ares_ng_state_size();
    const data = module._ares_ng_state_data();
    if(!size || !data) throw new Error("a synchronized save produced no bytes");
    stateBytes = new Uint8Array(module.HEAPU8.buffer, data, size).slice();
  }

  //absent unless built with -DARES_WASM_DEBUG=ON; the delta is then reported as null rather than 0
  const switchesBefore = module._ares_ng_switch_count?.() ?? 0;
  const audio = [];
  const video = [];
  const start = performance.now();
  for(let frame = 0; frame < measureFrames; frame++) {
    module._ares_ng_run_frame();
    const frames = module._ares_ng_audio_frames();
    audio.push(new Float32Array(module.HEAPU8.buffer, module._ares_ng_audio_data(), frames * 2).slice());
    const width = module._ares_ng_video_width(), height = module._ares_ng_video_height();
    video.push(new Uint8Array(module.HEAPU8.buffer, module._ares_ng_video_data(), width * height * 4).slice());
  }
  const elapsed = performance.now() - start;
  const switches = module._ares_ng_switch_count
    ? (module._ares_ng_switch_count() - switchesBefore) >>> 0 : null;

  //the state that ends the run, so a comparison can catch a divergence the pixels have not shown yet
  module._ares_ng_state_save(1);
  const finalSize = module._ares_ng_state_size();
  const finalData = module._ares_ng_state_data();
  const finalState = finalSize && finalData
    ? new Uint8Array(module.HEAPU8.buffer, finalData, finalSize).slice() : null;

  const videoWidth = module._ares_ng_video_width();
  const videoHeight = module._ares_ng_video_height();
  module._ares_ng_unload();

  const samples = new Float32Array(audio.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for(const chunk of audio) { samples.set(chunk, offset); offset += chunk.length; }

  let videoHash = 2166136261;
  for(const frame of video) videoHash = fnv1a(videoHash, frame);

  //a stress ROM that never ran, compared against a reference build that also never ran it, agrees
  //perfectly and proves nothing. If every measured frame is byte-identical to the first, say so.
  const staticPicture = video.every(frame => frame.length === video[0].length
    && frame.every((byte, index) => byte === video[0][index]));

  return {
    videoWidth, videoHeight,
    msPerFrame: +(elapsed / measureFrames).toFixed(2),
    fps: +(measureFrames * 1000 / elapsed).toFixed(1),
    switchesPerFrame: switches === null ? null : Math.round(switches / measureFrames),
    audioHash: hex(fnv1a(2166136261, new Uint8Array(samples.buffer))),
    videoHash: hex(videoHash),
    stateHash: finalState ? hex(fnv1a(2166136261, finalState)) : null,
    staticPicture,
    samples, video, stateBytes, finalState,
  };
}

const bytesEqual = (a, b) =>
  !!a && !!b && a.length === b.length && a.every((byte, index) => byte === b[index]);

//The one state difference the comparison tolerates, and only in its exact shape. A synchronized
//save can catch the cothread build's z80 suspended inside the instruction whose step overshot the
//68000: the ym2610 sync of a port access later in that instruction is then never paid (the save's
//walk breaks every synchronize), while the web build -- which ran the instruction atomically
//before the save existed -- has already paid it. The difference is exactly one ym2610 sample of
//clock position (either sign, depending on whose save landed in the window), confined to the
//opnb block, plus at most a uniform shift of every thread clock when a scheduler normalization
//fell between the two positions. Uniformity means the relative clocks -- the only thing behaviour
//reads -- are identical; the 300-frame audio and video comparisons of this sweep are the standing
//proof it reaches no sample and no pixel. Anything outside this shape still fails.
//Offsets are for this stress ROM's 223,396-byte synchronized state (the cartridge block precedes
//these and its size is per-ROM); measured with a temporary size print after each component of
//System::serialize, then pinned by scanning for each thread's u64 frequency.
const stateLayout = {
  clocks: {cpu: 2689, apu: 2762, lspc: 4843, opnb: 157846},  //Thread::_clock, u64le
  opnbScalar: 157838,                                        //Thread::_scalar, u64le
  opnbBlock: [156689, 157854],
  size: 223396,
};
const residualLabel = "ym2610 one-sample save-window residual (documented; behaviour-neutral)";
const stateOk = state => state === "identical" || state === residualLabel;

function classifyState(reference, candidate) {
  if(!reference || !candidate) return "unavailable";
  if(reference.length !== candidate.length) return `${reference.length} vs ${candidate.length} bytes`;
  if(bytesEqual(reference, candidate)) return "identical";
  const differing = [];
  for(let index = 0; index < reference.length; index++)
    if(reference[index] !== candidate[index]) differing.push(index);
  const {clocks, opnbScalar, opnbBlock, size} = stateLayout;
  if(reference.length === size) {
    const u64 = (bytes, offset) =>
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
    const inClock = offset =>
      Object.values(clocks).some(clock => offset >= clock && offset < clock + 8);
    const contained = differing.every(offset =>
      (offset >= opnbBlock[0] && offset < opnbBlock[1]) || inClock(offset));
    const shift = u64(candidate, clocks.cpu) - u64(reference, clocks.cpu);
    const uniform = [clocks.apu, clocks.lspc].every(clock =>
      u64(candidate, clock) - u64(reference, clock) === shift);
    const lead = u64(candidate, clocks.opnb) - u64(reference, clocks.opnb) - shift;
    const sample = 16n * u64(reference, opnbScalar);
    if(contained && uniform && (lead === sample || lead === -sample)) return residualLabel;
  }
  return `${differing.length} bytes differ`;
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
  //the discriminating half: two builds can paint the same pixels from machines that differ
  const state = classifyState(reference.finalState, candidate.finalState);
  return {
    lengths: reference.samples.length === candidate.samples.length ? "equal"
      : `${reference.samples.length} vs ${candidate.samples.length}`,
    audio: differing === 0 ? "identical"
      : `${(100 * differing / count).toFixed(1)}% differ, ${(10 * Math.log10(signal / noise)).toFixed(1)} dB SNR`,
    screen: framesDiffering === 0 ? "identical"
      : `${framesDiffering}/${reference.video.length} frames, ${(100 * pixelsDiffering / pixelsTotal).toFixed(2)}%`
        + ` of pixels, first at frame ${firstFrame.frame} pixel ${firstFrame.pixel}`,
    state,
  };
}

const report = ({samples, video, stateBytes, finalState, ...rest}) => console.log(JSON.stringify(rest));

const createWeb = await load(webPath);
const createReference = referencePath ? await load(referencePath) : null;
let failures = 0;
const fail = message => { console.log(JSON.stringify({error: message})); failures++; };

for(const {name, options} of configurations) {
  const web = await run(createWeb, options);
  report({configuration: name, build: "web", ...web});

  if(web.videoWidth !== 320 || web.videoHeight !== 256) {
    fail(`${name}: expected a 320x256 picture, got ${web.videoWidth}x${web.videoHeight}`);
  }
  if(web.samples.every(sample => sample === 0)) {
    fail(`${name}: silence; the audio comparison is vacuous`);
  }
  if(web.staticPicture) fail(`${name}: every measured frame is identical; the cartridge never ran`);

  const expected = measureFrames === 300 ? golden[name] : null;
  if(expected && expected.audio !== "PENDING") {
    const ok = expected.audio === web.audioHash && expected.video === web.videoHash;
    if(!ok) failures++;
    console.log(JSON.stringify({configuration: name, golden: ok ? "match" : "MISMATCH", expected}));
  }

  //a second web run, to show the comparison below measures scheduling and not run-to-run noise
  report({configuration: name, build: "web-control", ...compare(web, await run(createWeb, options))});

  if(createReference) {
    const reference = await run(createReference, options);
    report({configuration: name, build: "cothread", ...reference});
    const difference = compare(reference, web);
    if(difference.audio !== "identical" || difference.screen !== "identical"
    || !stateOk(difference.state)) failures++;
    report({configuration: name, build: "web-vs-cothread", ...difference});

    //and again, on machines that have just been run to a safe point and saved
    const webSaved = await run(createWeb, options, {takeState: true});
    const referenceSaved = await run(createReference, options, {takeState: true});
    const savedState = classifyState(referenceSaved.stateBytes, webSaved.stateBytes);
    if(!stateOk(savedState)) {
      fail(`${name}: the synchronized save states of the two builds differ (${savedState})`);
    } else if(savedState !== "identical") {
      console.log(JSON.stringify({configuration: name, savedState}));
    }
    const afterSave = compare(referenceSaved, webSaved);
    if(afterSave.audio !== "identical" || afterSave.screen !== "identical"
    || !stateOk(afterSave.state)) failures++;
    report({configuration: name, build: "after-a-save-state", ...afterSave});
  }
}

if(failures) {
  console.error(`${failures} comparison(s) failed`);
  process.exit(1);
}
