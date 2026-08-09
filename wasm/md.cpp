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
  u32 videoWidth = 0;
  u32 videoHeight = 0;
  u32 inputMask[2] = {};
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

}

extern "C" {

EMSCRIPTEN_KEEPALIVE auto ares_md_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_md_free(void* memory) -> void {
  std::free(memory);
}

EMSCRIPTEN_KEEPALIVE auto ares_md_load(const u8* data, u32 size) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");
  auto file = std::fopen(gamePath, "wb");
  if(!file) return fail("Could not create the in-memory ROM file");
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  if(written != size) return fail("Could not write the in-memory ROM file");

  backend.game = mia::Medium::create("Mega Drive");
  auto result = backend.game->load(gamePath);
  if(result != successful) return fail("Could not load the cartridge", result);

  backend.system = mia::System::create("Mega Drive");
  result = backend.system->load();
  if(result != successful) return fail("Could not load the system", result);

  ares::MegaDrive::option("TMSS", "false");
  auto regions = backend.game->pak->attribute("region");
  string region = "NTSC-U";
  if(!regions.find("NTSC-U") && regions.find("NTSC-J")) region = "NTSC-J";
  if(!regions.find("NTSC-U") && !regions.find("NTSC-J") && regions.find("PAL")) region = "PAL";
  if(!ares::MegaDrive::load(backend.root, {"[Sega] Mega Drive (", region, ")"})) {
    return fail("Could not initialize the Mega Drive core");
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
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(backend.audioFrequency);
  }
  return 1;
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

extern unsigned long long co_switch_count;

EMSCRIPTEN_KEEPALIVE auto ares_md_switch_count() -> u32 {
  return (u32)co_switch_count;
}

EMSCRIPTEN_KEEPALIVE auto ares_md_error() -> const char* {
  return backend.error.data();
}

}
