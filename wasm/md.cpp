#include <ares/ares.hpp>
#include <ares/md/md.hpp>
#include <mia/mia.hpp>

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
  u32 videoWidth = 0;
  u32 videoHeight = 0;
  u32 inputMask[2] = {};
  bool overscan = false;
  f64 audioFrequency = 48000.0;
  string error;
};

Backend backend;
constexpr auto gamePath = "/ares-game.md";

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

}
