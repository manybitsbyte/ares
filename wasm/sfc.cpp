#include <ares/ares.hpp>
#include <ares/sfc/sfc.hpp>
#include <mia/mia.hpp>

#include "save-ram.hpp"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

enum Button : u32 {
  Up     = 1 << 0,
  Down   = 1 << 1,
  Left   = 1 << 2,
  Right  = 1 << 3,
  B      = 1 << 4,
  A      = 1 << 5,
  Y      = 1 << 6,
  X      = 1 << 7,
  L      = 1 << 8,
  R      = 1 << 9,
  Select = 1 << 10,
  Start  = 1 << 11,
};

struct Backend : ares::Platform {
  auto attach(ares::Node::Object node) -> void override {
    if(auto stream = node->cast<ares::Node::Audio::Stream>()) {
      stream->setResamplerFrequency(audioFrequency);
    }
  }

  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name() == "Super Famicom") return system ? system->pak : nullptr;
    if(node->name() == "Super Famicom Cartridge") return game ? game->pak : nullptr;
    return {};
  }

  auto video(ares::Node::Video::Screen, const u32* data, u32 pitch, u32 width, u32 height) -> void override {
    videoWidth = width;
    videoHeight = height;
    videoPixels.resize(width * height);
    for(u32 y = 0; y < height; y++) {
      std::memcpy(videoPixels.data() + y * width, (const u8*)data + y * pitch, width * sizeof(u32));
    }
  }

  auto audio(ares::Node::Audio::Stream stream) -> void override {
    while(stream->pending()) {
      f64 samples[2] = {};
      auto channels = stream->read(samples);
      audioSamples.push_back(samples[0]);
      audioSamples.push_back(channels == 1 ? samples[0] : samples[1]);
    }
  }

  auto input(ares::Node::Input::Input input) -> void override {
    auto button = input->cast<ares::Node::Input::Button>();
    if(!button) return;

    auto device = ares::Node::parent(input);
    auto port = ares::Node::parent(device);
    if(!port) return;
    auto player = port->name() == "Controller Port 2" ? 1 : 0;

    u32 bit = 0;
    if(input->name() == "Up") bit = Up;
    if(input->name() == "Down") bit = Down;
    if(input->name() == "Left") bit = Left;
    if(input->name() == "Right") bit = Right;
    if(input->name() == "B") bit = B;
    if(input->name() == "A") bit = A;
    if(input->name() == "Y") bit = Y;
    if(input->name() == "X") bit = X;
    if(input->name() == "L") bit = L;
    if(input->name() == "R") bit = R;
    if(input->name() == "Select") bit = Select;
    if(input->name() == "Start") bit = Start;
    button->setValue(bit && (inputMask[player] & bit));
  }

  auto applyOverscan() -> void {
    if(!root) return;
    for(auto screen : root->find<ares::Node::Video::Screen>()) {
      screen->setOverscan(overscan);
    }
  }

  auto unload() -> void {
    ares::SuperFamicom::hostDebugger.reset();
    if(root) {
      root->unload();
      root.reset();
    }
    game.reset();
    system.reset();
    videoPixels.clear();
    audioSamples.clear();
    stateBytes.clear();
    saveRamBytes.clear();
    videoWidth = 0;
    videoHeight = 0;
    inputMask[0] = 0;
    inputMask[1] = 0;
  }

  std::shared_ptr<mia::Pak> game;
  std::shared_ptr<mia::Pak> system;
  ares::Node::System root;
  std::vector<u32> videoPixels;
  std::vector<float> audioSamples;
  std::vector<u8> stateBytes;
  std::vector<u8> saveRamBytes;
  u32 videoWidth = 0;
  u32 videoHeight = 0;
  u32 inputMask[2] = {};
  //empty defers to the cartridge header's country byte; anything else must name one of the two
  //regions ares::SuperFamicom::load() understands
  string region;
  bool overscan = false;
  f64 audioFrequency = 48000.0;
  string error;
};

Backend backend;
constexpr auto gamePath = "/ares-game.sfc";

//what mia's Media::SuperFamicom::save() persists. the last four belong to coprocessor and satellite
//boards — a cartridge that has one and loses it comes back wrong in a way plain save RAM does not.
const std::vector<ares_wasm::SaveMemory> saveMemories = {
  {"RAM", "Save"},
  {"RAM", "Internal"},
  {"RAM", "Download"},
  {"RTC", "Time"},
  {"RAM", "Data"},
};

auto fail(string message) -> int {
  backend.error = message;
  backend.unload();
  return 0;
}

auto fail(string message, const LoadResult& result) -> int {
  if(result.info) message.append(": ", result.info);
  return fail(message);
}

//a state failure leaves a working machine behind, so unlike a load failure it reports through the
//error string without tearing the core down.
auto stateFail(string message) -> int {
  backend.error = message;
  return 0;
}

}

extern "C" {

EMSCRIPTEN_KEEPALIVE auto ares_sfc_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_free(void* memory) -> void {
  std::free(memory);
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_load(const u8* data, u32 size) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");
  auto file = std::fopen(gamePath, "wb");
  if(!file) return fail("Could not create the in-memory ROM file");
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  if(written != size) return fail("Could not write the in-memory ROM file");

  backend.game = mia::Medium::create("Super Famicom");
  auto result = backend.game->load(gamePath);
  if(result != successful) return fail("Could not load the cartridge", result);

  backend.system = mia::System::create("Super Famicom");
  result = backend.system->load();
  if(result != successful) return fail("Could not load the system", result);

  ares::SuperFamicom::option("Pixel Accuracy", "false");
  ares::SuperFamicom::option("Deterministic Entropy", "true");
  auto region = backend.region;
  if(region != "NTSC" && region != "PAL") region = backend.game->pak->attribute("region");
  if(!region) region = "NTSC";
  if(!ares::SuperFamicom::load(backend.root, {"[Nintendo] Super Famicom (", region, ")"})) {
    return fail("Could not initialize the SNES core");
  }

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else {
    return fail("The SNES core did not expose a cartridge slot");
  }

  for(auto name : {"Controller Port 1", "Controller Port 2"}) {
    if(auto port = backend.root->find<ares::Node::Port>(name)) {
      port->allocate("Gamepad");
      port->connect();
    }
  }

  backend.root->power();
  backend.applyOverscan();
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_unload() -> void {
  backend.unload();
  std::remove(gamePath);
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_set_input(u32 player, u32 mask) -> void {
  if(player < 2) backend.inputMask[player] = mask;
}

//the ppu renders 564 pixels wide: the 512-pixel picture plus a 26-pixel border either side that a
//television's bezel hid, and which games leave full of partial tiles and scroll seams. overscan != 0
//hands that border to the caller; the default crops to the 512x224 picture a set actually showed.
//the ppu re-reads this at the end of every frame, so a change takes effect on the next one, and the
//reported video width and height change with it. this is a display choice and is unrelated to the
//console's own 224/239-line register, which is carried in the frame either way.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_set_overscan(int overscan) -> void {
  backend.overscan = overscan != 0;
  backend.applyOverscan();
}

//takes effect on the next ares_sfc_load(); an empty, null or unrecognized name restores the
//header-driven region. the cartridge header's country byte is the only region signal a SNES pak
//carries and ares has no region override of its own, so forcing a region here means ignoring what
//the pak declared: the configuration string handed to ares::SuperFamicom::load() is overridden
//rather than the pak's region attribute, which would also change what Cartridge::region() reports.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_set_region(const char* name) -> void {
  backend.region = name ? name : "";
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  if(backend.root) {
    for(auto stream : backend.root->find<ares::Node::Audio::Stream>()) {
      stream->setResamplerFrequency(frequency);
    }
  }
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_sfc_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_sfc_state_size,
//following the ares_sfc_audio_frames / ares_sfc_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores (fc and n64 are both v153), so keeping the states of
//different cores apart is the caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  auto s = ares::SuperFamicom::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_sfc_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::SuperFamicom::system.unserialize(s)) return stateFail("Not a valid state for the SNES core");
  return 1;
}

//the cartridge's persistent memory, packed as described in save-ram.hpp. this is the cartridge's
//battery, not the machine's state: it survives a different ares build, where a save state does not,
//and it carries nothing about where the game had got to. a cartridge without one gathers a size of
//0, which is the answer, not a failure. no scheduler is entered, so unlike ares_sfc_state_save this
//could have returned the size — it splits size out anyway to read the same way.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_save_ram_save() -> void {
  backend.saveRamBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  backend.root->save();
  ares_wasm::saveRamGather(backend.game, saveMemories, backend.saveRamBytes);
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_save_ram_size() -> u32 {
  return backend.saveRamBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_save_ram_data() -> const u8* {
  return backend.saveRamBytes.empty() ? nullptr : backend.saveRamBytes.data();
}

//the board holds its own copy of the cartridge's memory and takes it from the pak only when the
//cartridge is seated, so restoring re-seats the cartridge and power cycles the machine. call it
//after ares_sfc_load and before running a frame, and the machine is left where booting with the
//battery already in it would have left it.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_save_ram_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("Save data is empty");
  if(auto error = ares_wasm::saveRamApply(backend.game, saveMemories, data, size)) return stateFail(error);

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  }
  backend.root->power();
  backend.applyOverscan();
  return 1;
}

//the debugger PR #2630 added to this core speaks the GDB remote protocol over a TCP socket driven
//by a second process. There is no socket and no second process here, so these exports drive the
//same core-side machinery directly. The GDB path is untouched and still works in a native build.
//Everything below is inert until ares_sfc_debug_set_enabled(1): disarmed, the per-instruction
//arbiter is a single inlined "not enabled" test and the machine runs exactly as it did before.

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_set_enabled(int enabled) -> void {
  ares::SuperFamicom::hostDebugger.setEnabled(enabled != 0);
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_enabled() -> int {
  return ares::SuperFamicom::hostDebugger.enabled;
}

//addresses are full 24-bit program counters, bank in the high byte, matching what the 65816 reports
//at an instruction boundary. A 16-bit address would name 256 different instructions.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_add_breakpoint(u32 address) -> void {
  ares::SuperFamicom::hostDebugger.addBreakpoint(address);
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_remove_breakpoint(u32 address) -> void {
  ares::SuperFamicom::hostDebugger.removeBreakpoint(address);
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_clear_breakpoints() -> void {
  ares::SuperFamicom::hostDebugger.clearBreakpoints();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_breakpoint_count() -> u32 {
  return ares::SuperFamicom::hostDebugger.breakpoints.size();
}

//step and resume only arm an intent; the machine is parked on its own cothread and cannot move
//until the next ares_sfc_run_frame() re-enters the scheduler.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_step() -> void {
  ares::SuperFamicom::hostDebugger.requestStep();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_resume() -> void {
  ares::SuperFamicom::hostDebugger.requestResume();
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_halted() -> int {
  return ares::SuperFamicom::hostDebugger.halted;
}

//0 none, 1 breakpoint, 2 step. This is how a caller tells an ares_sfc_run_frame() that returned
//early from one that ran a whole frame: a frame end leaves the machine unhalted with no reason.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_stop_reason() -> u32 {
  return (u32)ares::SuperFamicom::hostDebugger.stop;
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_pc() -> u32 {
  if(!backend.root) return 0;
  return ares::SuperFamicom::cpu.r.pc.d;
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_register_count() -> u32 {
  return 10;
}

//one fixed-order block written into the caller's buffer, in the register numbering the PR's target
//description already defines: a, x, y, s, d, db, pb, pc, p, e. Ten separate getters were rejected:
//every export here is Asyncify-instrumented, so ten calls per halt cost ten unwind-check frames
//where one does, and a caller stitching ten answers together cannot tell a torn read from a real one.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_registers(u32* out) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!out) return stateFail("Registers need a destination buffer");
  auto& r = ares::SuperFamicom::cpu.r;
  out[0] = r.a.w;
  out[1] = r.x.w;
  out[2] = r.y.w;
  out[3] = r.s.w;
  out[4] = r.d.w;
  out[5] = r.b;
  out[6] = r.pc.b;
  out[7] = r.pc.w;
  out[8] = r.p;
  out[9] = r.e;
  return 1;
}

//reads through the bus peek channel the PR added, never through the emulated bus. A real read of
//$2137 latches the H/V counters, $213c/$213d flip a toggle, and CPU::readAPU switches cothreads,
//which from the host context is a crash rather than a wrong byte. A range with no declared peek
//fails whole: the bytes land in a staging buffer and only reach the caller once every one of them
//came from real storage, so a partial answer is never mistaken for a complete one.
EMSCRIPTEN_KEEPALIVE auto ares_sfc_debug_peek(u32 address, u32 size, u8* out) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!out || !size) return stateFail("Peek needs a destination buffer and a size");
  if(address > 0xff'ffff || size > 0x100'0000 - address) {
    return stateFail("Peek runs past the end of the 24-bit address space");
  }
  std::vector<u8> staged;
  staged.reserve(size);
  for(u32 offset = 0; offset < size; offset++) {
    auto value = ares::SuperFamicom::bus.peek(address + offset);
    if(!value) return stateFail("That range has no side-effect-free read");
    staged.push_back(value.get());
  }
  std::memcpy(out, staged.data(), staged.size());
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_sfc_error() -> const char* {
  return backend.error.data();
}

#if defined(ARES_WASM_DEBUG)
extern unsigned long long co_switch_count;

//process-wide cothread switch count; exists for the smoke harness, which reads it as a delta, so
//the truncation to u32 is harmless as long as a measurement spans fewer than 2^32 switches.
//instrumentation with no native counterpart, so it stays out of the default public ABI
EMSCRIPTEN_KEEPALIVE auto ares_sfc_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

}
