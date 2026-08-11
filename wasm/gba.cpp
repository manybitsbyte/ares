#include <ares/ares.hpp>
#include <ares/gba/gba.hpp>
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
  L      = 1 << 6,
  R      = 1 << 7,
  Select = 1 << 8,
  Start  = 1 << 9,
};

struct Backend : ares::Platform {
  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    //the node name stays "Game Boy Advance" for the Game Boy Player too: System::load() sets
    //information.model from the configuration string but never renames the node
    //(ares/gba/system/system.cpp:52-58), which is why one test covers both models.
    if(node->name() == "Game Boy Advance") return system ? system->pak : nullptr;
    if(node->name() == "Game Boy Advance Cartridge") return game ? game->pak : nullptr;
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

  //like the game boy, the advance has no controller ports: the ten buttons hang off a "Controls"
  //object on the system node (ares/gba/system/controls.cpp:1-13). the Game Boy Player additionally
  //appends a Node::Input::Rumble there, which is not a Button and falls out of the cast below.
  auto input(ares::Node::Input::Input input) -> void override {
    auto button = input->cast<ares::Node::Input::Button>();
    if(!button) return;

    u32 bit = 0;
    if(input->name() == "Up") bit = Up;
    if(input->name() == "Down") bit = Down;
    if(input->name() == "Left") bit = Left;
    if(input->name() == "Right") bit = Right;
    if(input->name() == "B") bit = B;
    if(input->name() == "A") bit = A;
    if(input->name() == "L") bit = L;
    if(input->name() == "R") bit = R;
    if(input->name() == "Select") bit = Select;
    if(input->name() == "Start") bit = Start;
    button->setValue(bit && (inputMask & bit));
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
    inputMask = 0;
  }

  //empty selects "[Nintendo] Game Boy Advance"; anything else must name one of
  //ares::GameBoyAdvance::enumerate(), which is that and "[Nintendo] Game Boy Player".
  string model;

  //the BIOS the caller supplied. ares has no substitute for it: CPU::power() ends in
  //exception(PSR::SVC, 0x00), so the ARM7 starts executing at 0x0000'0000 -- inside the BIOS --
  //and a machine without one runs 16 KiB of zeroes, which decode as `andeq r0,r0,r0`, forever.
  std::vector<u8> bios;

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
  u32 inputMask = 0;
  f64 audioFrequency = 48000.0;
  bool pixelAccuracy = false;
  string error;
};

Backend backend;
constexpr auto gamePath = "/ares-game.gba";
constexpr auto biosPath = "/ares-bios.bin";

//what mia's Media::GameBoyAdvance::save() persists (mia/medium/game-boy-advance.cpp:57-73). the
//list differs from the Game Boy's in one entry: flash here is content=Save, where the Game Boy's is
//content=Download, and the name the blob carries is derived from that pair.
const std::vector<ares_wasm::SaveMemory> saveMemories = {
  {"RAM", "Save"},
  {"EEPROM", "Save"},
  {"Flash", "Save"},
  {"RTC", "Time"},
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

EMSCRIPTEN_KEEPALIVE auto ares_gba_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_free(void* memory) -> void {
  std::free(memory);
}

//the BIOS is kept until it is replaced, so one call covers every cartridge the page goes on to
//load. it is not shipped with this build and cannot be: it is Nintendo's code. desktop ares asks
//for the same file (desktop-ui/emulator/game-boy-advance.cpp:14) and refuses to run without it.
EMSCRIPTEN_KEEPALIVE auto ares_gba_set_bios(const u8* data, u32 size) -> void {
  backend.bios.assign(data, data + (data ? size : 0));
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_load(const u8* data, u32 size) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");
  //the header this core reads lives at 0xac; mia reads the same four bytes to pick the save type
  if(size < 0xc0) return fail("ROM is smaller than the 192-byte header");
  if(backend.bios.empty()) return fail("No BIOS is loaded; call ares_gba_set_bios first");

  auto write = [](const char* path, const u8* data, u32 size) -> bool {
    auto file = std::fopen(path, "wb");
    if(!file) return false;
    auto written = std::fwrite(data, 1, size, file);
    std::fclose(file);
    return written == size;
  };
  if(!write(gamePath, data, size)) return fail("Could not write the in-memory ROM file");
  if(!write(biosPath, backend.bios.data(), backend.bios.size())) {
    return fail("Could not write the in-memory BIOS file");
  }

  //mia has one medium and one system pak for both models; only the ares device name changes, which
  //is what desktop-ui does too (desktop-ui/emulator/game-boy-advance.cpp:70).
  string device = backend.model ? backend.model : string{"[Nintendo] Game Boy Advance"};

  backend.game = mia::Medium::create("Game Boy Advance");
  if(!backend.game) return fail("Unknown medium: Game Boy Advance");
  auto result = backend.game->load(gamePath);
  if(result != successful) return fail("Could not load the cartridge", result);

  backend.system = mia::System::create("Game Boy Advance");
  if(!backend.system) return fail("Unknown system: Game Boy Advance");
  result = backend.system->load(biosPath);
  if(result != successful) return fail("Could not load the BIOS", result);

  //PPU::accurate has no initializer of its own (ares/gba/ppu/ppu.hpp:11); desktop-ui sets it from a
  //setting on every load, so this shim does too rather than leave it to whatever the last cartridge
  //chose. false is desktop's default (desktop-ui/settings/settings.hpp:42).
  ares::GameBoyAdvance::option("Pixel Accuracy", backend.pixelAccuracy ? "true" : "false");

  if(!ares::GameBoyAdvance::load(backend.root, device)) {
    return fail({"Could not initialize the Game Boy Advance core as ", device});
  }

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else {
    return fail("The Game Boy Advance core did not expose a cartridge slot");
  }

  backend.streams = backend.root->find<ares::Node::Audio::Stream>();
  backend.root->power();
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(backend.audioFrequency);
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_unload() -> void {
  backend.unload();
  std::remove(gamePath);
  std::remove(biosPath);
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

//the advance has one controller, so player is accepted for signature parity with the other cores
//and anything but 0 is ignored
EMSCRIPTEN_KEEPALIVE auto ares_gba_set_input(u32 player, u32 mask) -> void {
  if(player == 0) backend.inputMask = mask;
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(frequency);
  }
}

//takes effect on the next ares_gba_load(); an empty or null name restores "[Nintendo] Game Boy
//Advance". the only other accepted name is "[Nintendo] Game Boy Player".
EMSCRIPTEN_KEEPALIVE auto ares_gba_set_model(const char* name) -> void {
  backend.model = name ? name : "";
}

//upstream's "Pixel Accuracy" option, which chooses between PPU::main()'s two arms: the per-cycle
//renderer that reproduces mid-scanline register writes, and the whole-scanline renderer that does
//not. takes effect on the next ares_gba_load().
EMSCRIPTEN_KEEPALIVE auto ares_gba_set_pixel_accuracy(int accurate) -> void {
  backend.pixelAccuracy = accurate != 0;
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_gba_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_gba_state_size,
//following the ares_gba_audio_frames / ares_gba_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores, so keeping the states of different cores apart is the
//caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_gba_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  auto s = ares::GameBoyAdvance::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_gba_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::GameBoyAdvance::system.unserialize(s)) {
    return stateFail("Not a valid state for the Game Boy Advance core");
  }
  return 1;
}

//the cartridge's persistent memory, packed as described in save-ram.hpp. this is the cartridge's
//battery, not the machine's state: it survives a different ares build, where a save state does not,
//and it carries nothing about where the game had got to. a cartridge without one gathers a size of
//0, which is the answer, not a failure. no scheduler is entered, so unlike ares_gba_state_save this
//could have returned the size — it splits size out anyway to read the same way.
EMSCRIPTEN_KEEPALIVE auto ares_gba_save_ram_save() -> void {
  backend.saveRamBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  backend.root->save();
  ares_wasm::saveRamGather(backend.game, saveMemories, backend.saveRamBytes);
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_save_ram_size() -> u32 {
  return backend.saveRamBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_gba_save_ram_data() -> const u8* {
  return backend.saveRamBytes.empty() ? nullptr : backend.saveRamBytes.data();
}

//the board holds its own copy of the cartridge's memory and takes it from the pak only when the
//cartridge is seated, so restoring re-seats the cartridge and power cycles the machine. call it
//after ares_gba_load and before running a frame, and the machine is left where booting with the
//battery already in it would have left it.
EMSCRIPTEN_KEEPALIVE auto ares_gba_save_ram_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("Save data is empty");
  if(auto error = ares_wasm::saveRamApply(backend.game, saveMemories, data, size)) return stateFail(error);

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  }
  backend.root->power();
  return 1;
}

#if defined(ARES_WASM_DEBUG)
extern unsigned long long co_switch_count;

//instrumentation with no native counterpart: it exists for the smoke harness only, so it stays out
//of the default public ABI
EMSCRIPTEN_KEEPALIVE auto ares_gba_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

EMSCRIPTEN_KEEPALIVE auto ares_gba_error() -> const char* {
  return backend.error.data();
}

}
