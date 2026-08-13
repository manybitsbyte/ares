#include <ares/ares.hpp>
#include <ares/pce/pce.hpp>
#include <mia/mia.hpp>

#include "save-ram.hpp"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

//the pad's two face buttons are named "I" and "II" on the console and in the core's node tree
//(ares/pce/controller/gamepad/gamepad.cpp:10-11); the bit names spell them out.
enum Button : u32 {
  Up     = 1 << 0,
  Down   = 1 << 1,
  Left   = 1 << 2,
  Right  = 1 << 3,
  One    = 1 << 4,
  Two    = 1 << 5,
  Select = 1 << 6,
  Run    = 1 << 7,
};

//the console has one controller port. A Multitap fans it out to five, and the five inner ports are
//named "Controller Port 1" through "Controller Port 5"
//(ares/pce/controller/multitap/multitap.cpp:2-6), so a player index is the port's own name either
//way: without the tap there is one player and no numbered port at all.
constexpr u32 playerCount = 5;

struct Backend : ares::Platform {
  //System::load names the system node from the model string (ares/pce/system/system.cpp:60-90), and
  //Cartridge::allocate builds the card's name from that same name (cartridge.cpp:9), so a SuperGrafx
  //asks here under "SuperGrafx" and "SuperGrafx Card" while every PC Engine and TurboGrafx model
  //asks under "PC Engine" and "PC Engine Card".
  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name() == systemName) return system ? system->pak : nullptr;
    if(node->name() == string{systemName, " Card"}) return game ? game->pak : nullptr;
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
    auto port = device ? ares::Node::parent(device) : ares::Node::Object{};
    u32 player = 0;
    if(port) {
      if(port->name() == "Controller Port 2") player = 1;
      if(port->name() == "Controller Port 3") player = 2;
      if(port->name() == "Controller Port 4") player = 3;
      if(port->name() == "Controller Port 5") player = 4;
    }

    u32 bit = 0;
    if(input->name() == "Up") bit = Up;
    if(input->name() == "Down") bit = Down;
    if(input->name() == "Left") bit = Left;
    if(input->name() == "Right") bit = Right;
    if(input->name() == "I") bit = One;
    if(input->name() == "II") bit = Two;
    if(input->name() == "Select") bit = Select;
    if(input->name() == "Run") bit = Run;
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
    for(auto& mask : inputMask) mask = 0;
    systemName = {};
    gamePath = {};
    superGrafx = false;
  }

  //empty autodetects from the cartridge's region: NTSC-U images boot a TurboGrafx 16 and NTSC-J ones
  //a PC Engine. Anything else must name one of ares::PCEngine::enumerate().
  string model;

  //one resolved fact, four consumers: the mia medium, the mia system, Backend::pak's node match and
  //the MEMFS extension. mia picks the medium apart by name — "SuperGrafx" reads .sgx and "PC Engine"
  //reads .pce — and the core names its own nodes from the model, so naming the machine in one place
  //and the file in another seats a SuperGrafx card in a PC Engine.
  string systemName;
  string gamePath;
  bool superGrafx = false;

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
  u32 inputMask[playerCount] = {};
  bool overscan = false;
  bool multitap = false;
  f64 audioFrequency = 48000.0;
  string error;
};

Backend backend;

//mia reads the machine back off the extension: Medium::SuperGrafx overrides only name() and
//extensions() (mia/medium/supergrafx.cpp), so the analyzer is shared and the file name is the only
//thing that says which of the two cartridges this is.
constexpr auto gamePathPCEngine = "/ares-game.pce";
constexpr auto gamePathSuperGrafx = "/ares-game.sgx";

//A HuCard image does not say which machine it is for. There is no maker byte, no board field and no
//magic: a SuperGrafx cartridge is an ordinary card whose code programs a second VDC through ports a
//PC Engine decodes as mirrors of its first. Looking for that access does not separate the two
//either -- absolute stores landing in the VPC's register window occur at a similar rate in PC
//Engine cartridges, and in data that is not 6280 code at all.
//
//So every emulator that runs the machine carries a table, and this is that table: the five
//SuperGrafx-exclusive cartridges by SHA256 over the header-stripped image, from No-Intro's
//"NEC - PC Engine SuperGrafx" datfile, version 20250913-112105. The CRC32s beside them in that file
//agree on all five with mednafen's separately written list (mednafen src/pce/pce.cpp:340-351).
//
//The exclusives only. Darius Plus and Darius Alpha run on either machine, No-Intro files them under
//PC Engine, and that is where they run without the flicker the SuperGrafx path gives them, so they
//are left there.
constexpr const char* superGrafxDigests[] = {
  "5006f2da9cb645312a0c589044df50d3f97106d2d2291bf9883dacf98960c2fe",  //1941 - Counter Attack
  "5f3b430e34c79218a9f89a403a286037b2fb172b528373df5ba70aedbecd36d7",  //Aldynes - The Misson Code for Rage Crisis
  "41e06beeacfd05c837c9bb76da73c28d14dc2f66250a245b6931712f36c4e457",  //Battle Ace
  "482fff401f8a0f4248af16224c31bc166a583b491413559a89c425165420a9dd",  //Daimakaimura
  "9b57cdf0d0b110f4128b863419d5be99a3708bfb11cfbe1696f25449b991026d",  //Madou King Granzort
};

//the module is handed a buffer and a length and never a file name, so a digest is the only signal it
//has -- the .sgx extension the page can see does not reach here. mia strips a 512-byte copier header
//before it hashes (mia/medium/pc-engine.cpp:54-58) and the digests above are of stripped images, so
//the same strip runs here or a headered dump of a listed cartridge would miss its own entry.
auto isSuperGrafxImage(const u8* data, u32 size) -> bool {
  if((size & 0x1fff) == 512) data += 512, size -= 512;
  auto digest = Hash::SHA256(std::span<const u8>{data, size}).digest();
  for(auto known : superGrafxDigests) {
    if(digest == known) return true;
  }
  return false;
}

//what mia's Media::PCEngine::save() persists: the cartridge's own battery, which only the RAM board
//carries (Populous and Ten no Koe Bank). The Work and Dynamic memories the Super System Card and
//Arcade Card declare are marked volatile in the manifest and are not saved.
const std::vector<ares_wasm::SaveMemory> saveMemories = {
  {"RAM", "Save"},
};

//the PC Engine's save battery is not on the cartridge. It is 2 KiB of BRAM inside the CD-ROM unit,
//and ares reports that unit as present on every model precisely so HuCard games can save into it
//(ares/pce/cpu/io.cpp:50-51, ares/pce/pcd/pcd.cpp:46). mia keeps it in the system pak, which carries
//no manifest, so it is named directly.
const std::vector<const char*> saveFiles = {"backup.ram"};

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

//the five inner ports of a Multitap, or the single port of a bare console. Gamepad rather than
//Avenue Pad 6: the six-button pad reports its extra buttons only to games that ask for them, and the
//ABI has no bits for them.
auto connectControllers() -> void {
  auto port = backend.root->find<ares::Node::Port>("Controller Port");
  if(!port) return;
  if(!backend.multitap) {
    port->allocate("Gamepad");
    port->connect();
    return;
  }
  port->allocate("Multitap");
  port->connect();
  for(u32 player = 1; player <= playerCount; player++) {
    if(auto inner = backend.root->find<ares::Node::Port>(string{"Controller Port ", player})) {
      inner->allocate("Gamepad");
      inner->connect();
    }
  }
}

}

extern "C" {

EMSCRIPTEN_KEEPALIVE auto ares_pce_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_free(void* memory) -> void {
  std::free(memory);
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_load(const u8* data, u32 size) -> int {
  //a previous load may have written the other extension, so drop that file before the path is
  //re-resolved and the old name is forgotten
  if(backend.gamePath) std::remove(backend.gamePath.data());
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");

  //the Duo and the LaserActive boot from a CD BIOS in the system pak and run software off a disc.
  //mia's PC Engine system pak carries neither, and this module has no way to hand it one, so the
  //machine would come up on 256 KiB of zeroes with an empty tray. Say so instead.
  if(backend.model.find("Duo") || backend.model.find("LaserActive")) {
    return fail("This module has no disc drive or CD BIOS: the Duo and LaserActive models cannot be loaded");
  }

  //resolved before the MEMFS write, because the write needs the extension and mia needs the name.
  //An empty model is a HuCard console, which keeps the autodetect below.
  if(backend.model.find("SuperGrafx")) backend.superGrafx = true;
  //a chosen model is the answer; the table only speaks when the caller had none. It is an exact
  //match, so it cannot promote a PC Engine cartridge by mistake -- what it misses is a SuperGrafx
  //image that is not one of the five: an alternate or bad dump, a hack, a translation, homebrew.
  if(!backend.model && isSuperGrafxImage(data, size)) backend.superGrafx = true;
  backend.systemName = backend.superGrafx ? "SuperGrafx" : "PC Engine";
  backend.gamePath = backend.superGrafx ? gamePathSuperGrafx : gamePathPCEngine;

  auto file = std::fopen(backend.gamePath.data(), "wb");
  if(!file) return fail("Could not create the in-memory ROM file");
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  if(written != size) return fail("Could not write the in-memory ROM file");

  backend.game = mia::Medium::create(backend.systemName);
  auto result = backend.game->load(backend.gamePath);
  if(result != successful) return fail("Could not load the cartridge", result);

  backend.system = mia::System::create(backend.systemName);
  result = backend.system->load();
  if(result != successful) return fail("Could not load the system", result);

  string model = backend.model;
  if(!model && backend.superGrafx) {
    //the medium and the system pak were built as a SuperGrafx above, and the pak callback answers to
    //that name and no other, so the model has to name the same machine or System::load brings up a
    //console whose nodes nothing can service. The SuperGrafx never left Japan and enumerate() lists
    //exactly one of them (ares/pce/system/system.cpp:12), so there is no region to resolve.
    model = "[NEC] SuperGrafx (NTSC-J)";
  }
  if(!model) {
    //mia's analyzer stamps NTSC-U on everything it does not recognise as Japanese, so the default is
    //the TurboGrafx 16 the American library was written for.
    auto region = backend.game->pak->attribute("region");
    model = region.find("NTSC-J") ? "[NEC] PC Engine (NTSC-J)" : "[NEC] TurboGrafx 16 (NTSC-U)";
  }

  //VDPBase::implementation is a null pointer until setAccurate() runs, and System::load dereferences
  //it in vdp.load(). Only ares::PCEngine::option() reaches it, and it ignores the value it is given
  //and forces the accurate renderer regardless (ares/pce/system/system.cpp:25), so this call is the
  //one thing standing between a load and a null dereference rather than a quality setting.
  ares::PCEngine::option("Pixel Accuracy", "true");

  if(!ares::PCEngine::load(backend.root, model)) {
    return fail("Could not initialize the PC Engine core");
  }

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else {
    return fail("The PC Engine core did not expose a cartridge slot");
  }

  connectControllers();

  backend.streams = backend.root->find<ares::Node::Audio::Stream>();
  backend.root->power();
  backend.applyOverscan();
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(backend.audioFrequency);
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_unload() -> void {
  //read before unload(), which forgets which of the two paths was written
  auto path = backend.gamePath;
  backend.unload();
  if(path) std::remove(path.data());
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_set_input(u32 player, u32 mask) -> void {
  if(player < playerCount) backend.inputMask[player] = mask;
}

//the console has one controller port; the five-port Multitap is how every two-player PC Engine game
//reaches a second pad. Off by default, because a bare console is what a cartridge expects to find.
//takes effect on the next ares_pce_load().
EMSCRIPTEN_KEEPALIVE auto ares_pce_set_multitap(int multitap) -> void {
  backend.multitap = multitap != 0;
}

//the vce renders a border around the picture that a television's bezel hid and that games leave
//filled with the backdrop colour. overscan != 0 hands that border to the caller; the default crops
//to the picture a set actually showed. the vdp re-reads this at the end of every frame
//(ares/pce/vdp/vdp.cpp:107-113), so a change takes effect on the next one, and the reported video
//width and height change with it.
EMSCRIPTEN_KEEPALIVE auto ares_pce_set_overscan(int overscan) -> void {
  backend.overscan = overscan != 0;
  backend.applyOverscan();
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(frequency);
  }
}

//takes effect on the next ares_pce_load(); an empty or null name restores region autodetection.
//the name must be one of ares::PCEngine::enumerate(), less the two CD models this module rejects.
EMSCRIPTEN_KEEPALIVE auto ares_pce_set_model(const char* name) -> void {
  backend.model = name ? name : "";
}

//the vce runs the picture out at four times the pixel rate of its slowest dot clock, so a line is
//1365 samples wide and the core reports a scale of 0.25 on the horizontal axis
//(ares/pce/vdp/vdp.cpp:47). The buffer handed back here is at that sample rate: a caller drawing it
//square stretches the picture four times too wide.
EMSCRIPTEN_KEEPALIVE auto ares_pce_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_pce_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_pce_state_size,
//following the ares_pce_audio_frames / ares_pce_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores, so keeping the states of different cores apart is the
//caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_pce_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  auto s = ares::PCEngine::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_pce_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::PCEngine::system.unserialize(s)) return stateFail("Not a valid state for the PC Engine core");
  return 1;
}

//the machine's persistent memory, packed as described in save-ram.hpp. this is the battery, not the
//machine's state: it survives a different ares build, where a save state does not, and it carries
//nothing about where the game had got to. Two memories can appear in it — the console's BRAM, which
//every model has, and the RAM board's save.ram, which two cartridges have — and a blob says which by
//name. no scheduler is entered, so unlike ares_pce_state_save this could have returned the size — it
//splits size out anyway to read the same way.
EMSCRIPTEN_KEEPALIVE auto ares_pce_save_ram_save() -> void {
  backend.saveRamBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  backend.root->save();
  ares_wasm::saveRamGather(backend.game, saveMemories, backend.system, saveFiles, backend.saveRamBytes);
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_save_ram_size() -> u32 {
  return backend.saveRamBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_pce_save_ram_data() -> const u8* {
  return backend.saveRamBytes.empty() ? nullptr : backend.saveRamBytes.data();
}

//the board holds its own copy of the cartridge's memory and takes it from the pak only when the
//cartridge is seated, so restoring re-seats the cartridge and power cycles the machine. call it
//after ares_pce_load and before running a frame, and the machine is left where booting with the
//battery already in it would have left it.
EMSCRIPTEN_KEEPALIVE auto ares_pce_save_ram_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("Save data is empty");
  if(auto error = ares_wasm::saveRamApply(backend.game, saveMemories, backend.system, saveFiles, data, size)) {
    return stateFail(error);
  }

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  }
  //BRAM is not the cartridge's, and nothing re-seats it: PCD::load() is the only place that reads
  //backup.ram out of the system pak (ares/pce/pcd/pcd.cpp:60-62) and it ran once, when the core was
  //built. PCD::power() leaves the bytes alone, so filling them here is what booting with the battery
  //already in the machine would have left behind.
  if(auto fp = backend.system->pak->read("backup.ram")) ares::PCEngine::pcd.bram.load(fp);
  backend.root->power();
  backend.applyOverscan();
  return 1;
}

#if defined(ARES_WASM_DEBUG)
extern unsigned long long co_switch_count;

//instrumentation with no native counterpart: it exists for the smoke harness only, so it stays out
//of the default public ABI
EMSCRIPTEN_KEEPALIVE auto ares_pce_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

EMSCRIPTEN_KEEPALIVE auto ares_pce_error() -> const char* {
  return backend.error.data();
}

}
