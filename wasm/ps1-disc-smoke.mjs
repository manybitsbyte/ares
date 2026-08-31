//Liveness for the disc change (DECISIONS.md 8.18): a running machine opens its tray, dwells with
//the door open for real emulated frames, closes it on a *different* disc, and both survives and
//notices. The refusal path is here too, because its contract -- stateFail's shape, never fail's --
//is what keeps a bad disc from killing a running game.
//
//   node wasm/ps1-disc-smoke.mjs [build_wasm_ps1/wasm/ares-ps1.mjs] [discA.cue] [discB.cue]
//   ARES_PS1_BIOS=/absolute/path/to/scph5501.bin
//
//Needs a real BIOS and two real cue sheets, so like the sweep's fidelity rows it skips with a clear
//message when it has none; nothing is ever copied into the tree. The noticing check is seeded: a
//control instance is loaded from the changed instance's own state blob before the tray opens,
//because random.entropy(High) guarantees two unseeded power-ups differ and an unseeded frame
//comparison would mean nothing. Both machines then run door-open frame-identical, and only the one
//whose tray closed on the new disc may diverge.

import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve, dirname, join, basename} from "node:path";
import {existsSync, readFileSync} from "node:fs";

const modulePath = process.argv[2] ?? "build_wasm_ps1/wasm/ares-ps1.mjs";
const discAPath = process.argv[3];
const discBPath = process.argv[4];
const biosPath = process.env.ARES_PS1_BIOS;

//past the BIOS's display setup and its first look at the drive; see ps1-smoke.mjs
const settleFrames = 600;
//desktop ares's 3000 ms at 60 Hz, the dwell the player counts in presented frames
const dwellFrames = 180;
//long enough after the close for the BIOS to re-examine the drive
const noticeFrames = 600;

const skip = message => {
  console.log(`SKIP  ${message}`);
  process.exit(0);
};
const abort = message => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};

if(!biosPath || !existsSync(biosPath)) {
  skip("ARES_PS1_BIOS names no readable BIOS -- a disc cannot be booted without one, and Sony's image is not in this repository");
}
if(!discAPath || !discBPath) {
  skip("two cue sheets are needed (node wasm/ps1-disc-smoke.mjs <module> <discA.cue> <discB.cue>) -- no disc fixture is present");
}
for(const path of [discAPath, discBPath]) {
  if(!existsSync(path)) skip(`${path} does not exist -- no disc fixture is present`);
}

const moduleUrl = pathToFileURL(resolve(modulePath));
const {default: createAresPs1} = await import(moduleUrl);
const instantiate = () => createAresPs1({locateFile: path => fileURLToPath(new URL(path, moduleUrl))});

const readDisc = path => {
  const cue = new Uint8Array(readFileSync(path));
  const text = Buffer.from(cue).toString("latin1");
  const tracks = [...text.matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map(match => match[1]);
  if(!tracks.length) abort(`${path} names no FILE; it does not look like a cue sheet`);
  return {
    name: basename(path),
    cue,
    tracks: tracks.map(name => ({name, bytes: new Uint8Array(readFileSync(join(dirname(path), name)))})),
  };
};

const bios = new Uint8Array(readFileSync(biosPath));
const discA = readDisc(discAPath);
const discB = readDisc(discBPath);

const fnv1a = (hash, bytes) => {
  for(const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash;
};
const hex = hash => (hash >>> 0).toString(16).padStart(8, "0");

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? "ok  " : "FAIL"}  ${message}`);
  if(!condition) failures.push(message);
};

const wrap = module => {
  const lastError = () => module.UTF8ToString(module._ares_ps1_error()) || "";
  const put = bytes => {
    const pointer = module._ares_ps1_alloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    return pointer;
  };
  const stage = track => {
    const namePointer = put(new TextEncoder().encode(`${track.name}\0`));
    const dataPointer = put(track.bytes);
    const staged = module._ares_ps1_stage(namePointer, dataPointer, track.bytes.length);
    module._ares_ps1_free(namePointer);
    module._ares_ps1_free(dataPointer);
    if(!staged) abort(`could not stage ${track.name}: ${lastError()}`);
  };
  const boot = disc => {
    const biosPointer = put(bios);
    module._ares_ps1_set_bios(biosPointer, bios.length);
    module._ares_ps1_free(biosPointer);
    for(const track of disc.tracks) stage(track);
    module._ares_ps1_set_audio_frequency(48000);
    const cuePointer = put(disc.cue);
    const loaded = module._ares_ps1_load(cuePointer, disc.cue.length);
    module._ares_ps1_free(cuePointer);
    if(!loaded) abort(`could not load ${disc.name}: ${lastError()}`);
  };
  const videoBytes = () => new Uint8Array(module.HEAPU8.buffer, module._ares_ps1_video_data(),
    module._ares_ps1_video_width() * module._ares_ps1_video_height() * 4);
  const run = frames => {
    let hash = 2166136261;
    const distinct = new Set();
    for(let frame = 0; frame < frames; frame++) {
      module._ares_ps1_run_frame();
      const pixels = videoBytes();
      hash = fnv1a(hash, pixels);
      distinct.add(fnv1a(2166136261, pixels));
    }
    return {hash: hex(hash), distinct: distinct.size};
  };
  const discClose = disc => {
    for(const track of disc.tracks) stage(track);
    const cuePointer = put(disc.cue);
    const closed = module._ares_ps1_disc_close(cuePointer, disc.cue.length);
    module._ares_ps1_free(cuePointer);
    return closed;
  };
  const saveState = () => {
    module._ares_ps1_state_save(1);
    const size = module._ares_ps1_state_size();
    if(!size) return null;
    return new Uint8Array(module.HEAPU8.buffer, module._ares_ps1_state_data(), size).slice();
  };
  const loadState = state => {
    const pointer = put(state);
    const loaded = module._ares_ps1_state_load(pointer, state.length);
    module._ares_ps1_free(pointer);
    return loaded;
  };
  return {module, lastError, boot, run, discClose, saveState, loadState};
};

//the changed machine and its seeded control
const changed = wrap(await instantiate());
check(typeof changed.module._ares_ps1_disc_open === "function", "the module exports _ares_ps1_disc_open");
check(typeof changed.module._ares_ps1_disc_close === "function", "the module exports _ares_ps1_disc_close");
changed.boot(discA);
changed.run(settleFrames);
const seed = changed.saveState();
if(seed === null) abort(`could not save the seeding state: ${changed.lastError()}`);

const control = wrap(await instantiate());
control.boot(discA);
control.run(settleFrames);
if(!control.loadState(seed)) abort(`the control refused the seeding state: ${control.lastError()}`);

check(changed.module._ares_ps1_disc_open() === 1, `disc_open returns 1 on a running machine (${changed.lastError()})`);
check(control.module._ares_ps1_disc_open() === 1, "disc_open returns 1 on the control too");

const changedOpen = changed.run(dwellFrames);
const controlOpen = control.run(dwellFrames);
check(changedOpen.hash === controlOpen.hash,
  `the ${dwellFrames} door-open dwell frames are seeded-identical on both machines (${changedOpen.hash} vs ${controlOpen.hash})`);

check(changed.discClose(discB) === 1, `disc_close on ${discB.name} returns 1 (${changed.lastError()})`);
check(changed.lastError() === "", `ares_ps1_error is empty after the change (${JSON.stringify(changed.lastError())})`);

const changedAfter = changed.run(noticeFrames);
const controlAfter = control.run(noticeFrames);
check(changedAfter.distinct > 1, `the machine keeps producing a moving picture after the change (${changedAfter.distinct} distinct frames)`);
check(changedAfter.hash !== controlAfter.hash,
  `the machine that closed on ${discB.name} diverges from the one whose tray stayed open -- the new disc's TOC was read (${changedAfter.hash} vs ${controlAfter.hash})`);
check(changed.saveState() !== null, "the changed machine still saves a synchronized state");

//the refusal path, on the control whose tray is already open. mia reads almost any text as a cue
//sheet -- a sheet naming an absent track builds an empty session and Disc::connect self-heals by
//disconnecting (disc.cpp:63), which is why guarding the medium is the caller's job -- so the
//refusal the export itself owns is its argument guard, and what matters is its shape: stateFail's,
//leaving a running machine that a retry with a good disc recovers.
const ghostClosed = control.module._ares_ps1_disc_close(0, 0);
check(ghostClosed === 0, "an empty disc is refused");
check(control.lastError() !== "", `the refusal names a reason (${JSON.stringify(control.lastError())})`);
const aliveAfterRefusal = control.run(60);
check(aliveAfterRefusal.distinct >= 1, "the machine still runs frames after the refusal -- stateFail, not fail");
check(control.saveState() !== null, "the machine still saves state after the refusal");
check(control.discClose(discA) === 1, "a retry with the outgoing disc recovers");

if(failures.length) {
  console.error(`ps1-disc-smoke FAILED -- ${failures.length} check(s)`);
  process.exit(1);
}
console.log("ps1-disc-smoke OK");
