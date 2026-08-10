#include <ares/ares.hpp>
#include <ares/gb/gb.hpp>
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
  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name() == "Game Boy") return system ? system->pak : nullptr;
    if(node->name() == "Game Boy Color") return system ? system->pak : nullptr;
    if(node->name() == "Game Boy Cartridge") return game ? game->pak : nullptr;
    if(node->name() == "Game Boy Color Cartridge") return game ? game->pak : nullptr;
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

  //the game boy has no controller ports: the eight buttons hang off a "Controls" object on the
  //system node (ares/gb/system/controls.cpp:4-13), so unlike the other cores there is no port to
  //walk up to and no second player to distinguish.
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

  //empty selects the model the cartridge header asks for; anything else must name one of
  //ares::GameBoy::enumerate(). "[Nintendo] Super Game Boy" is out of scope for this target: it is
  //the sfc core's coprocessor, not a machine this module can bring up on its own.
  string model;

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
  string error;
};

Backend backend;
constexpr auto gamePath = "/ares-game.gb";

//what mia's Media::GameBoy::save() persists, and Game Boy Color inherits it unchanged. the clock is
//the one that matters here: a Pokémon cartridge that keeps its RAM and loses its RTC comes back with
//the in-game day counter stopped.
const std::vector<ares_wasm::SaveMemory> saveMemories = {
  {"RAM", "Save"},
  {"EEPROM", "Save"},
  {"Flash", "Download"},
  {"RTC", "Time"},
};

//mirrors mia/medium/game-boy.cpp:75-88. the cartridge's colour capability is not carried on the pak
//that mia hands back -- $0143 only reaches mia's manifest as a title-length choice -- so the model
//cannot be asked for and has to be read off the image here. MMM01 multicarts keep their header at
//the top of the image rather than at offset 0, and getting that wrong reads a byte of program code.
auto headerAddress(const u8* data, u32 size) -> u32 {
  //mia writes this as `size < 0x8000 ? size : size - 0x8000`, which indexes past the end of the
  //image for anything smaller than 0x8000 -- the relocated header cannot exist there at all. no
  //MMM01 multicart is that small, so the branch is simply not taken below 32 KiB.
  u32 address = size >= 0x8000 ? size - 0x8000 : 0;
  auto read = [&](u32 offset) { return data[address + offset]; };
  if(read(0x0104) == 0xce && read(0x0105) == 0xed && read(0x0106) == 0x66 && read(0x0107) == 0x66
  && read(0x0108) == 0xcc && read(0x0109) == 0x0d && read(0x0147) >= 0x0b && read(0x0147) <= 0x0d
  ) return address;
  return 0;
}

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

EMSCRIPTEN_KEEPALIVE auto ares_gb_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_free(void* memory) -> void {
  std::free(memory);
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_load(const u8* data, u32 size) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");
  //mia rejects anything smaller than one 16 KiB bank, and headerAddress() indexes into the image
  if(size < 0x4000) return fail("ROM is smaller than the 16384-byte minimum");
  auto file = std::fopen(gamePath, "wb");
  if(!file) return fail("Could not create the in-memory ROM file");
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  if(written != size) return fail("Could not write the in-memory ROM file");

  //bit 7 of $0143 covers both 0x80 (runs on either machine) and 0xc0 (colour only); mia reads the
  //same byte with a 0xc0 mask only to decide how many title characters the header has room for.
  string name = backend.model;
  if(!name) {
    bool color = data[headerAddress(data, size) + 0x0143] & 0x80;
    name = !color ? "Game Boy" : "Game Boy Color";
  } else {
    //an explicit model arrives in ares::GameBoy::enumerate() form; mia is keyed on the bare name
    name.trimLeft("[Nintendo] ", 1L);
  }

  backend.game = mia::Medium::create(name);
  if(!backend.game) return fail({"Unknown model: ", name});
  auto result = backend.game->load(gamePath);
  if(result != successful) return fail("Could not load the cartridge", result);

  backend.system = mia::System::create(name);
  if(!backend.system) return fail({"Unknown model: ", name});
  result = backend.system->load();
  if(result != successful) return fail("Could not load the system", result);

  if(!ares::GameBoy::load(backend.root, {"[Nintendo] ", name})) {
    return fail("Could not initialize the Game Boy core");
  }

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else {
    return fail("The Game Boy core did not expose a cartridge slot");
  }

  backend.streams = backend.root->find<ares::Node::Audio::Stream>();
  backend.root->power();
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(backend.audioFrequency);
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_unload() -> void {
  backend.unload();
  std::remove(gamePath);
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

//the game boy has one controller, so player is accepted for signature parity with the other cores
//and anything but 0 is ignored
EMSCRIPTEN_KEEPALIVE auto ares_gb_set_input(u32 player, u32 mask) -> void {
  if(player == 0) backend.inputMask = mask;
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(frequency);
  }
}

//takes effect on the next ares_gb_load(); an empty or null name restores header autodetection
EMSCRIPTEN_KEEPALIVE auto ares_gb_set_model(const char* name) -> void {
  backend.model = name ? name : "";
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_gb_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_gb_state_size,
//following the ares_gb_audio_frames / ares_gb_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores (fc and n64 are both v153), so keeping the states of
//different cores apart is the caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_gb_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  auto s = ares::GameBoy::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_gb_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::GameBoy::system.unserialize(s)) return stateFail("Not a valid state for the Game Boy core");
  return 1;
}

//the cartridge's persistent memory, packed as described in save-ram.hpp. this is the cartridge's
//battery, not the machine's state: it survives a different ares build, where a save state does not,
//and it carries nothing about where the game had got to. a cartridge without one gathers a size of
//0, which is the answer, not a failure. no scheduler is entered, so unlike ares_gb_state_save this
//could have returned the size — it splits size out anyway to read the same way.
EMSCRIPTEN_KEEPALIVE auto ares_gb_save_ram_save() -> void {
  backend.saveRamBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  backend.root->save();
  ares_wasm::saveRamGather(backend.game, saveMemories, backend.saveRamBytes);
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_save_ram_size() -> u32 {
  return backend.saveRamBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_gb_save_ram_data() -> const u8* {
  return backend.saveRamBytes.empty() ? nullptr : backend.saveRamBytes.data();
}

//the board holds its own copy of the cartridge's memory and takes it from the pak only when the
//cartridge is seated, so restoring re-seats the cartridge and power cycles the machine. call it
//after ares_gb_load and before running a frame, and the machine is left where booting with the
//battery already in it would have left it.
EMSCRIPTEN_KEEPALIVE auto ares_gb_save_ram_load(const u8* data, u32 size) -> int {
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
EMSCRIPTEN_KEEPALIVE auto ares_gb_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

EMSCRIPTEN_KEEPALIVE auto ares_gb_error() -> const char* {
  return backend.error.data();
}

}
