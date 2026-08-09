#include <ares/ares.hpp>
#include <ares/sfc/sfc.hpp>
#include <mia/mia.hpp>

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

  auto unload() -> void {
    if(root) {
      root->unload();
      root.reset();
    }
    game.reset();
    system.reset();
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
  std::vector<u32> videoPixels;
  std::vector<float> audioSamples;
  u32 videoWidth = 0;
  u32 videoHeight = 0;
  u32 inputMask[2] = {};
  f64 audioFrequency = 48000.0;
  string error;
};

Backend backend;
constexpr auto gamePath = "/ares-game.sfc";

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
  auto region = backend.game->pak->attribute("region");
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

EMSCRIPTEN_KEEPALIVE auto ares_sfc_error() -> const char* {
  return backend.error.data();
}

extern unsigned long long co_switch_count;

//process-wide cothread switch count; exists for the smoke harness, which reads it as a delta, so
//the truncation to u32 is harmless as long as a measurement spans fewer than 2^32 switches
EMSCRIPTEN_KEEPALIVE auto ares_sfc_switch_count() -> u32 {
  return (u32)co_switch_count;
}

}
