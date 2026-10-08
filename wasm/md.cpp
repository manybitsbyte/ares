#include <ares/ares.hpp>
#include <ares/md/md.hpp>
#include <mia/mia.hpp>

#include "save-ram.hpp"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

enum Button : u32 {
  Up    = 1 << 0,
  Down  = 1 << 1,
  Left  = 1 << 2,
  Right = 1 << 3,
  A     = 1 << 4,
  B     = 1 << 5,
  C     = 1 << 6,
  Start = 1 << 7,
  X     = 1 << 8,
  Y     = 1 << 9,
  Z     = 1 << 10,
  Mode  = 1 << 11,
};

struct Backend : ares::Platform {
  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name() == "Mega Drive") return system ? system->pak : nullptr;
    if(node->name() == "Mega Drive Cartridge") return game ? game->pak : nullptr;
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

  auto audio(ares::Node::Audio::Stream) -> void override {
    while(true) {
      for(auto& stream : streams) {
        if(!stream->pending()) return;
      }

      f64 samples[2] = {};
      for(auto& stream : streams) {
        f64 buffer[2] = {};
        auto channels = stream->read(buffer);
        samples[0] += buffer[0];
        samples[1] += channels == 1 ? buffer[0] : buffer[1];
      }
      audioSamples.push_back(max(-1.0, min(1.0, samples[0])));
      audioSamples.push_back(max(-1.0, min(1.0, samples[1])));
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
    if(input->name() == "A") bit = A;
    if(input->name() == "B") bit = B;
    if(input->name() == "C") bit = C;
    if(input->name() == "Start") bit = Start;
    if(input->name() == "X") bit = X;
    if(input->name() == "Y") bit = Y;
    if(input->name() == "Z") bit = Z;
    if(input->name() == "Mode") bit = Mode;
    button->setValue(bit && (inputMask[player] & bit));
  }

  auto applyOverscan() -> void {
    if(!root) return;
    for(auto screen : root->find<ares::Node::Video::Screen>()) {
      screen->setOverscan(overscan);
    }
  }

  auto unload() -> void {
    if(root) {
      root->unload();
      root.reset();
    }
    game.reset();
    system.reset();
    streams.clear();
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
  std::vector<ares::Node::Audio::Stream> streams;
  std::vector<u32> videoPixels;
  std::vector<float> audioSamples;
  std::vector<u8> stateBytes;
  std::vector<u8> saveRamBytes;
  u32 videoWidth = 0;
  u32 videoHeight = 0;
  u32 inputMask[2] = {};
  bool overscan = false;
  f64 audioFrequency = 48000.0;
  string error;
};

Backend backend;
constexpr auto gamePath = "/ares-game.md";

//what mia's Media::MegaDrive::save() persists, and Media::Mega32X::save() persists the same two.
//an EEPROM cartridge that keeps only the SRAM comes back with nothing, so both are gathered.
const std::vector<ares_wasm::SaveMemory> saveMemories = {
  {"RAM", "Save"},
  {"EEPROM", "Save"},
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

//"Mega Drive" or "Mega 32X"; both use the same mia medium and ares system names.
auto load(const u8* data, u32 size, string medium) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");
  auto file = std::fopen(gamePath, "wb");
  if(!file) return fail("Could not create the in-memory ROM file");
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  if(written != size) return fail("Could not write the in-memory ROM file");

  backend.game = mia::Medium::create(medium);
  auto result = backend.game->load(gamePath);
  if(result != successful) return fail("Could not load the cartridge", result);

  backend.system = mia::System::create(medium);
  result = backend.system->load();
  if(result != successful) return fail("Could not load the system", result);

  ares::MegaDrive::option("TMSS", "false");
  auto regions = backend.game->pak->attribute("region");
  string region = "NTSC-U";
  if(!regions.find("NTSC-U") && regions.find("NTSC-J")) region = "NTSC-J";
  if(!regions.find("NTSC-U") && !regions.find("NTSC-J") && regions.find("PAL")) region = "PAL";
  if(!ares::MegaDrive::load(backend.root, {"[Sega] ", medium, " (", region, ")"})) {
    return fail({"Could not initialize the ", medium, " core"});
  }

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else {
    return fail("The Mega Drive core did not expose a cartridge slot");
  }

  for(auto name : {"Controller Port 1", "Controller Port 2"}) {
    if(auto port = backend.root->find<ares::Node::Port>(name)) {
      port->allocate("Fighting Pad");
      port->connect();
    }
  }

  backend.streams = backend.root->find<ares::Node::Audio::Stream>();
  backend.root->power();
  backend.applyOverscan();
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(backend.audioFrequency);
  }
  return 1;
}

}

extern "C" {

EMSCRIPTEN_KEEPALIVE auto ares_md_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_md_free(void* memory) -> void {
  std::free(memory);
}

EMSCRIPTEN_KEEPALIVE auto ares_md_load(const u8* data, u32 size) -> int {
  return load(data, size, "Mega Drive");
}

EMSCRIPTEN_KEEPALIVE auto ares_md_load_32x(const u8* data, u32 size) -> int {
  return load(data, size, "Mega 32X");
}

EMSCRIPTEN_KEEPALIVE auto ares_md_unload() -> void {
  backend.unload();
  std::remove(gamePath);
}

EMSCRIPTEN_KEEPALIVE auto ares_md_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

EMSCRIPTEN_KEEPALIVE auto ares_md_set_input(u32 player, u32 mask) -> void {
  if(player < 2) backend.inputMask[player] = mask;
}

//the vdp renders a 1415-pixel-wide raster: the 1280-pixel picture plus a border either side, and
//extra lines above and below, that a television's bezel hid and that games leave filled with the
//backdrop colour. overscan != 0 hands that border to the caller; the default crops to the picture a
//set actually showed. the vdp re-reads this at the end of every frame, so a change takes effect on
//the next one, and the reported video width and height change with it. this is a display choice and
//is unrelated to the console's own 224/240-line register, which is carried in the frame either way.
EMSCRIPTEN_KEEPALIVE auto ares_md_set_overscan(int overscan) -> void {
  backend.overscan = overscan != 0;
  backend.applyOverscan();
}

EMSCRIPTEN_KEEPALIVE auto ares_md_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(frequency);
  }
}

EMSCRIPTEN_KEEPALIVE auto ares_md_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_md_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_md_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_md_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_md_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_md_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_md_state_size,
//following the ares_md_audio_frames / ares_md_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores (fc and n64 are both v153), so keeping the states of
//different cores apart is the caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_md_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  auto s = ares::MegaDrive::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_md_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_md_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_md_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::MegaDrive::system.unserialize(s)) return stateFail("Not a valid state for the Mega Drive core");
  return 1;
}

//the cartridge's persistent memory, packed as described in save-ram.hpp. this is the cartridge's
//battery, not the machine's state: it survives a different ares build, where a save state does not,
//and it carries nothing about where the game had got to. a cartridge without one gathers a size of
//0, which is the answer, not a failure. no scheduler is entered, so unlike ares_md_state_save this
//could have returned the size — it splits size out anyway to read the same way.
EMSCRIPTEN_KEEPALIVE auto ares_md_save_ram_save() -> void {
  backend.saveRamBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  backend.root->save();
  ares_wasm::saveRamGather(backend.game, saveMemories, backend.saveRamBytes);
}

EMSCRIPTEN_KEEPALIVE auto ares_md_save_ram_size() -> u32 {
  return backend.saveRamBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_md_save_ram_data() -> const u8* {
  return backend.saveRamBytes.empty() ? nullptr : backend.saveRamBytes.data();
}

//the board holds its own copy of the cartridge's memory and takes it from the pak only when the
//cartridge is seated, so restoring re-seats the cartridge and power cycles the machine. call it
//after ares_md_load and before running a frame, and the machine is left where booting with the
//battery already in it would have left it.
EMSCRIPTEN_KEEPALIVE auto ares_md_save_ram_load(const u8* data, u32 size) -> int {
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

#if defined(ARES_WASM_DEBUG)
extern unsigned long long co_switch_count;

//instrumentation with no native counterpart: it exists for the smoke harness only, so it stays out
//of the default public ABI
EMSCRIPTEN_KEEPALIVE auto ares_md_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

EMSCRIPTEN_KEEPALIVE auto ares_md_error() -> const char* {
  return backend.error.data();
}

#if defined(PROBEC_ENABLE)
//======================= PROBE C measurement instrumentation =======================
//Throwaway. Counts only; never shipped. Index map:
//  0 dreq.vram spin iterations          1 dreq.vram spins entered
//  2 paletteEngaged spin iterations     3 paletteEngaged spins entered
//  4 SH2 cache line fills               5 SH2 Cache::read<> calls
//  7 SH2 cache-disabled bypasses        8 SH7604::step() calls
//  9 M68k sync expiries                10 SH2-to-SH2 sync expiries
// 11 SH7604::step() clocks summed      12 MegaDrive::CPU::main() calls
// 13 68000 bus.acquired() spin iters   14 68000 bus.acquired() spins entered
// 15/16/17 SH2 readByte/Word/Long<Cache>   19/20 M32X read/writeInternal
// 21 framebufferEngaged early-outs     23 PWM::main() calls
// 24 SH7604::internalStep() calls      25/26/27 SH2 writeByte/Word/Long<Cache>
// 28 SH2 bus ops with Origin != Cache  29/30/31/32 readWord area Cached/Uncached/IO/Data
// 33 readWord Cached area, cache off   34/35 Z80 bus-acquired spin iters/entries
// 36 VDP::runCycle() calls             37 OPN2::main()   38 APU::main()   39 VDP::main()
// 40 SH7604::main() calls (both SH-2s)
// 41 co_switch() calls (every cothread switch, including the scheduler's own)
extern "C" unsigned long long probec[64] = {};

EMSCRIPTEN_KEEPALIVE auto ares_probec_reset() -> void {
  for(auto& v : probec) v = 0;
  ares::MegaDrive::cpu.Thread::probeEntries = 0;
  ares::MegaDrive::cpu.Thread::probeRequests = 0;
  ares::MegaDrive::apu.Thread::probeEntries = 0;
  ares::MegaDrive::apu.Thread::probeRequests = 0;
  ares::MegaDrive::vdp.Thread::probeEntries = 0;
  ares::MegaDrive::vdp.Thread::probeRequests = 0;
  ares::MegaDrive::opn2.Thread::probeEntries = 0;
  ares::MegaDrive::opn2.Thread::probeRequests = 0;
  ares::MegaDrive::m32x.shm.Thread::probeEntries = 0;
  ares::MegaDrive::m32x.shm.Thread::probeRequests = 0;
  ares::MegaDrive::m32x.shs.Thread::probeEntries = 0;
  ares::MegaDrive::m32x.shs.Thread::probeRequests = 0;
  ares::MegaDrive::m32x.pwm.Thread::probeEntries = 0;
  ares::MegaDrive::m32x.pwm.Thread::probeRequests = 0;
}

//PROBE C: override the two sync tunables after power(), so one build can be swept.
EMSCRIPTEN_KEEPALIVE auto ares_probec_set_sync(int m68k, int sh2) -> void {
  if(m68k > 0) {
    ares::MegaDrive::m32x.shm.minCyclesBetweenM68kSyncs = m68k;
    ares::MegaDrive::m32x.shs.minCyclesBetweenM68kSyncs = m68k;
  }
  if(sh2 > 0) {
    ares::MegaDrive::m32x.shm.minCyclesBetweenSh2Syncs = sh2;
    ares::MegaDrive::m32x.shs.minCyclesBetweenSh2Syncs = sh2;
  }
}

EMSCRIPTEN_KEEPALIVE auto ares_probec_get(u32 index) -> double {
  if(index < 64) return (double)probec[index];
  switch(index) {
  case 101: return (double)ares::MegaDrive::cpu.Thread::probeEntries;
  case 102: return (double)ares::MegaDrive::cpu.Thread::probeRequests;
  case 103: return (double)ares::MegaDrive::apu.Thread::probeEntries;
  case 104: return (double)ares::MegaDrive::apu.Thread::probeRequests;
  case 105: return (double)ares::MegaDrive::vdp.Thread::probeEntries;
  case 106: return (double)ares::MegaDrive::vdp.Thread::probeRequests;
  case 107: return (double)ares::MegaDrive::opn2.Thread::probeEntries;
  case 108: return (double)ares::MegaDrive::opn2.Thread::probeRequests;
  case 109: return (double)ares::MegaDrive::m32x.shm.Thread::probeEntries;
  case 110: return (double)ares::MegaDrive::m32x.shm.Thread::probeRequests;
  case 111: return (double)ares::MegaDrive::m32x.shs.Thread::probeEntries;
  case 112: return (double)ares::MegaDrive::m32x.shs.Thread::probeRequests;
  case 113: return (double)ares::MegaDrive::m32x.pwm.Thread::probeEntries;
  case 114: return (double)ares::MegaDrive::m32x.pwm.Thread::probeRequests;
  }
  return 0;
}
#endif  //PROBEC_ENABLE

}
