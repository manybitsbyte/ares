#include <ares/ares.hpp>
#include <ares/fc/fc.hpp>
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
  Select = 1 << 6,
  Start  = 1 << 7,
};

struct Backend : ares::Platform {
  auto attach(ares::Node::Object node) -> void override {
    if(auto stream = node->cast<ares::Node::Audio::Stream>()) {
      stream->setResamplerFrequency(audioFrequency);
    }
  }

  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name() == "Famicom") return system ? system->pak : nullptr;
    if(node->name() == "Famicom Cartridge") return game ? game->pak : nullptr;
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

  //a board with expansion audio -- mmc5, vrc6, vrc7, namco 163, sunsoft 5b -- adds a second stream
  //beside the apu's, and this callback fires once per stream. reading only the stream handed in would
  //append the two streams end to end rather than mixing them, which doubles the frame count and plays
  //the expansion channel after the apu instead of over it. so wait until every stream has a sample
  //pending, then take one from each and sum them, the same shape md/gb/gba/ms/ng already use.
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
    if(input->name() == "B") bit = B;
    if(input->name() == "A") bit = A;
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
  u32 audioFrequency = 48000;
  string error;
};

Backend backend;
constexpr auto gamePath = "/ares-game.nes";

//what mia's Media::Famicom::save() persists. character RAM is deliberately absent: the NES writes it
//every frame and mia has never saved a byte of it.
const std::vector<ares_wasm::SaveMemory> saveMemories = {
  {"RAM", "Save"},
  {"EEPROM", "Save"},
  {"Flash", "Program"},
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

EMSCRIPTEN_KEEPALIVE auto ares_fc_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_free(void* memory) -> void {
  std::free(memory);
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_load(const u8* data, u32 size) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");
  auto file = std::fopen(gamePath, "wb");
  if(!file) return fail("Could not create the in-memory ROM file");
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  if(written != size) return fail("Could not write the in-memory ROM file");

  backend.game = mia::Medium::create("Famicom");
  auto result = backend.game->load(gamePath);
  if(result != successful) return fail("Could not load the cartridge", result);

  backend.system = mia::System::create("Famicom");
  result = backend.system->load();
  if(result != successful) return fail("Could not load the system", result);

  auto region = backend.game->pak->attribute("region");
  string configuration = "[Nintendo] Famicom (NTSC-U)";
  if(region == "NTSC-J") configuration = "[Nintendo] Famicom (NTSC-J)";
  if(region == "PAL") configuration = "[Nintendo] Famicom (PAL)";
  if(region == "Dendy") configuration = "[Dendy] Dendy";
  if(!ares::Famicom::load(backend.root, configuration)) return fail("Could not initialize the NES core");

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else {
    return fail("The NES core did not expose a cartridge slot");
  }

  for(auto name : {"Controller Port 1", "Controller Port 2"}) {
    if(auto port = backend.root->find<ares::Node::Port>(name)) {
      port->allocate("Gamepad");
      port->connect();
    }
  }

  if(backend.game->pak->attribute("system") == "EPSM") {
    if(auto port = backend.root->find<ares::Node::Port>("Expansion Port")) {
      port->allocate("EPSM");
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

EMSCRIPTEN_KEEPALIVE auto ares_fc_unload() -> void {
  backend.unload();
  std::remove(gamePath);
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_set_input(u32 player, u32 mask) -> void {
  if(player < 2) backend.inputMask[player] = mask;
}

//the ppu renders 283 columns by displayHeight() lines, most of which a television's bezel hid.
//overscan != 0 hands that whole frame to the caller; the default crops to the 256 columns and
//displayHeight() - 2 lines a set actually showed, shifted right by 16 (18 on PAL, which also drops
//46 further lines). ares/fc/ppu/ppu.cpp:117-134 re-reads this at the end of every frame, so a change
//takes effect on the next one, and the reported video width and height change with it.
//
//ares::Node::Video::Screen defaults _overscan to true, so a core that never calls setOverscan keeps
//the border. this shim landed after the sfc, ms and md ones, and until it did the NES was the one
//browser build still handing out the uncropped 283x242 frame while the rest handed out the picture.
//the Game Boy has no equivalent because its LCD panel is the whole picture the ppu draws.
EMSCRIPTEN_KEEPALIVE auto ares_fc_set_overscan(int overscan) -> void {
  backend.overscan = overscan != 0;
  backend.applyOverscan();
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(frequency);
  }
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_fc_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_fc_state_size,
//following the ares_fc_audio_frames / ares_fc_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores (fc and n64 are both v153), so keeping the states of
//different cores apart is the caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_fc_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  auto s = ares::Famicom::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_fc_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::Famicom::system.unserialize(s)) return stateFail("Not a valid state for the NES core");
  return 1;
}

//the cartridge's persistent memory, packed as described in save-ram.hpp. this is the cartridge's
//battery, not the machine's state: it survives a different ares build, where a save state does not,
//and it carries nothing about where the game had got to. a cartridge without one gathers a size of
//0, which is the answer, not a failure. no scheduler is entered, so unlike ares_fc_state_save this
//could have returned the size — it splits size out anyway to read the same way.
EMSCRIPTEN_KEEPALIVE auto ares_fc_save_ram_save() -> void {
  backend.saveRamBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  backend.root->save();
  ares_wasm::saveRamGather(backend.game, saveMemories, backend.saveRamBytes);
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_save_ram_size() -> u32 {
  return backend.saveRamBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_fc_save_ram_data() -> const u8* {
  return backend.saveRamBytes.empty() ? nullptr : backend.saveRamBytes.data();
}

//the board holds its own copy of the cartridge's memory and takes it from the pak only when the
//cartridge is seated, so restoring re-seats the cartridge and power cycles the machine. call it
//after ares_fc_load and before running a frame, and the machine is left where booting with the
//battery already in it would have left it.
EMSCRIPTEN_KEEPALIVE auto ares_fc_save_ram_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("Save data is empty");
  if(auto error = ares_wasm::saveRamApply(backend.game, saveMemories, data, size)) return stateFail(error);

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  }
  //unlike the other cores, an expansion-audio board owns its stream, so re-seating the cartridge
  //destroys and rebuilds it: the list has to be gathered again rather than carried over.
  backend.streams = backend.root->find<ares::Node::Audio::Stream>();
  backend.root->power();
  backend.applyOverscan();
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(backend.audioFrequency);
  }
  return 1;
}

#if defined(ARES_WASM_DEBUG)
extern unsigned long long co_switch_count;

//instrumentation with no native counterpart: it exists for the smoke harness only, so it stays out
//of the default public ABI
EMSCRIPTEN_KEEPALIVE auto ares_fc_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

EMSCRIPTEN_KEEPALIVE auto ares_fc_error() -> const char* {
  return backend.error.data();
}

}
