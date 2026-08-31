#include <ares/ares.hpp>
#include <ares/ps1/ps1.hpp>
#include <mia/mia.hpp>
#include "save-ram.hpp"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

//the fourteen buttons a Digital Gamepad reports, in the order the pad's own node tree lists them
//(ares/ps1/peripheral/digital-gamepad/digital-gamepad.cpp:4-17). The DualShock's sticks, L3, R3 and
//Mode have no bits here because this module never allocates one.
enum Button : u32 {
  Up       = 1 <<  0,
  Down     = 1 <<  1,
  Left     = 1 <<  2,
  Right    = 1 <<  3,
  Cross    = 1 <<  4,
  Circle   = 1 <<  5,
  Square   = 1 <<  6,
  Triangle = 1 <<  7,
  L1       = 1 <<  8,
  L2       = 1 <<  9,
  R1       = 1 << 10,
  R2       = 1 << 11,
  Select   = 1 << 12,
  Start    = 1 << 13,
};

constexpr u32 playerCount = 2;

//one 128 KiB memory card per slot, which is the whole of this console's persistent memory: the disc
//is read-only and there is no cartridge, so nothing else on the machine survives a power cut.
constexpr u32 cardCount = 2;
const char* const cardPorts[cardCount] = {"Memory Card Port 1", "Memory Card Port 2"};

//the names the battery blob gives the two cards. They cannot be the cards' own file name: MemoryCard
//reads and writes "save.card" out of whichever pak it was handed and has no idea which slot it is in
//(ares/ps1/peripheral/memory-card/memory-card.cpp:8,24), so both cards call their file the same
//thing, and a blob whose entries are told apart by name cannot carry two entries under one name. The
//battery pak below is what holds them under names that differ, and these are that pak's own file
//names, so save-ram.hpp's rule -- a blob names the pak files it came out of -- still holds.
const std::vector<const char*> saveFiles = {"memory-card-1.card", "memory-card-2.card"};

struct Backend : ares::Platform {
  //four nodes ask for a pak on this machine: the system node, which System::load names "PlayStation"
  //(ares/ps1/system/system.cpp:46-48,72); the disc, which Disc::allocate names "PlayStation Disc"
  //(disc.cpp:49); and the two Memory Cards, which are both named "Memory Card" and can only be told
  //apart by the port they were appended to. Disc::load also appends a plain object called
  //"PlayStation" (disc.cpp:16), but nothing ever asks it for a pak, so those two names cannot be
  //confused here.
  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name() == "PlayStation") return system ? system->pak : nullptr;
    if(node->name() == "PlayStation Disc") return game ? game->pak : nullptr;
    if(node->name() == "Memory Card") {
      //Object::append sets the parent before PlatformAttach (ares/ares/node/object.hpp:41-47), and
      //MemoryCard appends its node before it asks for the pak (memory-card.cpp:2-3), so the port is
      //already reachable from here. What comes back is dereferenced without a null check, so every
      //slot this module allocates has its pak made first -- see ares_ps1_load.
      auto port = ares::Node::parent(node);
      for(u32 slot = 0; slot < cardCount; slot++) {
        if(port && port->name() == cardPorts[slot]) return card[slot] ? card[slot]->pak : nullptr;
      }
    }
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
    if(!device) return;
    auto port = ares::Node::parent(device);
    if(!port) return;
    auto player = port->name() == "Controller Port 2" ? 1 : 0;

    u32 bit = 0;
    if(input->name() == "Up") bit = Up;
    if(input->name() == "Down") bit = Down;
    if(input->name() == "Left") bit = Left;
    if(input->name() == "Right") bit = Right;
    if(input->name() == "Cross") bit = Cross;
    if(input->name() == "Circle") bit = Circle;
    if(input->name() == "Square") bit = Square;
    if(input->name() == "Triangle") bit = Triangle;
    if(input->name() == "L1") bit = L1;
    if(input->name() == "L2") bit = L2;
    if(input->name() == "R1") bit = R1;
    if(input->name() == "R2") bit = R2;
    if(input->name() == "Select") bit = Select;
    if(input->name() == "Start") bit = Start;
    button->setValue(bit && (inputMask[player] & bit));
  }

  //there is deliberately no applyOverscan() here, and no ares_ps1_set_overscan to call it. GPU::load
  //gives the screen a size and nothing else -- no viewport, no scale, no aspect
  //(ares/ps1/gpu/gpu.cpp:25,42) -- and every frame the blitter hands over is the display area the
  //machine was programmed to show. There is no border to crop, so the call would have no meaning.

  auto unload() -> void {
    if(root) {
      root->unload();
      root.reset();
    }
    game.reset();
    system.reset();
    for(auto& pak : card) pak.reset();
    battery.reset();
    streams.clear();
    //stagedPaths is deliberately not cleared here: ares_ps1_load calls this before it reads the
    //files a caller staged for it, and dropping their names would leak the files themselves.
    videoPixels.clear();
    audioSamples.clear();
    stateBytes.clear();
    saveRamBytes.clear();
    videoWidth = 0;
    videoHeight = 0;
    for(auto& mask : inputMask) mask = 0;
  }

  //empty names the NTSC-U machine; anything else must be one of ares::PlayStation::enumerate().
  string model;

  std::shared_ptr<mia::Pak> game;
  std::shared_ptr<mia::Pak> system;
  //one pak per memory card, each holding the single blank 128 KiB save.card its card reads when it is
  //seated and writes back when the machine is asked to save; and the pak the battery blob is gathered
  //out of and applied into, which holds a copy of both under names that say which slot they came from.
  std::shared_ptr<mia::Pak> card[cardCount];
  std::shared_ptr<mia::Pak> battery;
  ares::Node::System root;
  std::vector<ares::Node::Audio::Stream> streams;
  std::vector<u32> videoPixels;
  std::vector<float> audioSamples;
  std::vector<u8> stateBytes;
  std::vector<u8> saveRamBytes;
  //the BIOS is kept until it is replaced, so one call covers every medium the page goes on to load,
  //exactly as a console keeps the same BIOS across discs. see ares_ps1_set_bios.
  std::vector<u8> bios;
  //every file ares_ps1_stage wrote, so the load that consumed them can drop them again.
  std::vector<string> stagedPaths;
  u32 videoWidth = 0;
  u32 videoHeight = 0;
  u32 inputMask[playerCount] = {};
  f64 audioFrequency = 48000.0;
  string error;
};

Backend backend;

//mia's PlayStation system reads whatever single file it is pointed at and appends it as bios.rom
//(mia/system/playstation.cpp:7-15), so the name of this one does not matter. The medium's extension
//does: mia dispatches on it and nothing else, sending ".cue" to vfs::cdrom and ".exe" to the PS-X
//EXE arm (mia/medium/playstation.cpp:34-42, 53, 83). The rest of the medium's name is cosmetic --
//a .cue names its tracks by their own bare filenames, and Location::path of either of these is "/",
//so the sibling lookup in vfs::cdrom::loadCue resolves against whatever ares_ps1_stage wrote.
constexpr auto biosPath = "/ares-bios.bin";
constexpr auto exePath = "/ares-game.exe";
constexpr auto cuePath = "/ares-game.cue";

//staged files land in the same directory the .cue will, under exactly the name the .cue gives them.
auto stagePath(string name) -> string {
  return {"/", name};
}

auto writeFile(string path, const u8* data, u32 size) -> bool {
  auto file = std::fopen(path, "wb");
  if(!file) return false;
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  return written == size;
}

//once the medium has been loaded the staged track files are dead weight: vfs::cdrom copies every
//sector of every one of them into a single expanded image and reads them no further, and on this
//console those files are the largest thing in the module by two orders of magnitude. Dropping them
//here is what keeps a disc resident once rather than twice.
auto clearStaged() -> void {
  for(auto& path : backend.stagedPaths) std::remove(path.data());
  backend.stagedPaths.clear();
}

auto fail(string message) -> int {
  backend.error = message;
  backend.unload();
  clearStaged();
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

//the same 128 KiB lives twice, once under the name its card knows it by and once under the name the
//blob knows it by, and these two move it between them. Neither is a cache of the other: a card writes
//its own pak when the machine is asked to save, and the battery pak is only ever what a blob is read
//out of or written into.
auto cardsToBattery() -> void {
  if(!backend.battery) return;
  for(u32 slot = 0; slot < cardCount; slot++) {
    if(!backend.card[slot]) continue;
    auto from = backend.card[slot]->pak->read("save.card");
    auto to = backend.battery->pak->write(saveFiles[slot]);
    if(!from || !to || from->size() != to->size()) continue;
    std::memcpy(to->data(), from->data(), to->size());
  }
}

auto batteryToCards() -> void {
  if(!backend.battery) return;
  for(u32 slot = 0; slot < cardCount; slot++) {
    if(!backend.card[slot]) continue;
    auto from = backend.battery->pak->read(saveFiles[slot]);
    auto to = backend.card[slot]->pak->write("save.card");
    if(!from || !to || from->size() != to->size()) continue;
    std::memcpy(to->data(), from->data(), to->size());
    //"loaded" is what tells a card being seated that its pak holds a card someone has used, rather
    //than the blank one this module created (memory-card.cpp:8-12). Without it the card that comes up
    //is the one format() just made and every restored byte is dropped on the floor. mia sets the same
    //attribute when it reads a .card off a desktop's disk (mia/pak/pak.cpp:107).
    to->setAttribute("loaded", true);
  }
}

}

extern "C" {

EMSCRIPTEN_KEEPALIVE auto ares_ps1_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_free(void* memory) -> void {
  std::free(memory);
}

//the BIOS the caller supplied, as a raw 512 KiB image. ares has no substitute for it: the CPU's
//reset vector is in the BIOS at 0xbfc0'0000, and the BIOS is what brings the hardware up, draws the
//menu and hands control to a disc. Sony's BIOS is not in this repository and will not be. Passing
//size 0 (or a null pointer) forgets it.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_set_bios(const u8* data, u32 size) -> void {
  backend.bios.assign(data, data + (data ? size : 0));
}

//seat one of a .cue's track files beside the .cue that ares_ps1_load will be given, under the bare
//filename the .cue names it by. A disc is two or more files -- the cue sheet plus one BIN or WAV per
//FILE line -- and vfs::cdrom::loadCue opens each of them as {Location::path(cue), file.name}
//(nall/vfs/cdrom.hpp:184), a sibling path, which is the whole reason this exists. Call it once per
//track file, in any order, before ares_ps1_load; it touches no core state and needs no machine. The
//load that follows drops the files again, so a second disc starts from an empty directory.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_stage(const char* name, const u8* data, u32 size) -> int {
  if(!name || !*name) return stateFail("A track filename is required");
  if(!data || !size) return stateFail("Track file is empty");
  auto path = stagePath(name);
  if(!writeFile(path, data, size)) return stateFail("Could not write the in-memory track file");
  backend.stagedPaths.push_back(path);
  return 1;
}

//data may be null: an empty tray is a configuration this machine really has, and booting the BIOS
//with nothing in the drive is what puts it in its own menu. A non-empty buffer is either a PS-X EXE,
//which the core side-loads into RAM at the shell's entry point (ares/ps1/cpu/cpu.cpp:134-155)
//without touching the disc drive at all, or a .cue sheet whose track files have already been handed
//over by ares_ps1_stage. The two are told apart by the executable's own magic, which is the same
//test mia applies (mia/medium/playstation.cpp:86); there is no positive test for a cue sheet, and
//one is not needed, because anything that is not an executable can only be the other thing this
//medium accepts and mia will refuse it by name if it is neither.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_load(const u8* data, u32 size) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(backend.bios.empty()) return fail("No BIOS is loaded; call ares_ps1_set_bios first");
  if(!writeFile(biosPath, backend.bios.data(), backend.bios.size())) {
    return fail("Could not write the in-memory BIOS file");
  }

  //the BIOS is loaded before the medium so that a bad BIOS is reported as a bad BIOS
  backend.system = mia::System::create("PlayStation");
  auto result = backend.system->load(biosPath);
  if(result != successful) return fail("Could not load the BIOS", result);

  if(data && size) {
    auto executable = size >= 8 && !std::memcmp(data, "PS-X EXE", 8);
    auto path = executable ? exePath : cuePath;
    if(!writeFile(path, data, size)) return fail("Could not write the in-memory ROM file");
    backend.game = mia::Medium::create("PlayStation");
    result = backend.game->load(path);
    if(result != successful) return fail(executable ? "Could not load the executable" : "Could not load the disc", result);
    clearStaged();
  }

  //there is nothing to autodetect from: mia stamps NTSC-U on every PS-X EXE it accepts
  //(mia/medium/playstation.cpp:92) and an empty tray says nothing at all. The region reaches one
  //place in the core, the disc's licence check (ares/ps1/disc/command.cpp:628-634), so what this
  //really wants to name is the machine the caller's BIOS came out of; ares_ps1_set_model does that.
  string model = backend.model ? backend.model : "[Sony] PlayStation (NTSC-U)";

  if(!ares::PlayStation::load(backend.root, model)) {
    return fail("Could not initialize the PlayStation core");
  }

  //seated only when there is something to seat. Disc::connect reads the pak the tray is handed
  //(ares/ps1/disc/disc.cpp:52-53), and with no medium behind it the drive would come up holding a
  //disc it could not read rather than holding no disc. the tray hangs off the drive's own object
  //rather than off the system node, and Object::find only walks one level, so it needs the path.
  if(backend.game) {
    if(auto port = backend.root->find<ares::Node::Port>("PlayStation/Disc Tray")) {
      port->allocate();
      port->connect();
    } else {
      return fail("The PlayStation core did not expose a disc tray");
    }
  }

  for(auto portName : {"Controller Port 1", "Controller Port 2"}) {
    if(auto port = backend.root->find<ares::Node::Port>(portName)) {
      port->allocate("Digital Gamepad");
      port->connect();
    }
  }

  //a card in each slot, seated the way desktop-ui does (desktop-ui/emulator/playstation.cpp:120-126):
  //one pak per slot holding one blank 128 KiB save.card. Both paks are made before either port is
  //allocated because MemoryCard's constructor dereferences what Backend::pak hands it without
  //checking it (memory-card.cpp:3-8). The appended file is zeros and carries no "loaded" attribute,
  //which is deliberate: the card that comes up is then the one MemoryCard::format() writes, a blank
  //but formatted card, exactly as desktop-ui gets when no .card file is found beside the game. Mark
  //it loaded here and the machine would seat a card full of zeros, which is an unformatted one.
  for(u32 slot = 0; slot < cardCount; slot++) {
    backend.card[slot] = mia::Pak::create("PlayStation");
    backend.card[slot]->pak->append("save.card", 128_KiB);
  }
  backend.battery = mia::Pak::create("PlayStation");
  for(auto file : saveFiles) backend.battery->pak->append(file, 128_KiB);

  for(u32 slot = 0; slot < cardCount; slot++) {
    if(auto port = backend.root->find<ares::Node::Port>(cardPorts[slot])) {
      port->allocate("Memory Card");
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

EMSCRIPTEN_KEEPALIVE auto ares_ps1_unload() -> void {
  backend.unload();
  clearStaged();
  std::remove(biosPath);
  std::remove(exePath);
  std::remove(cuePath);
}

//the two halves of a disc change, split so the caller can put real emulated frames between them --
//DECISIONS.md 8.18. Both report through stateFail's shape: a failed change leaves a working machine
//with an open tray, never a dead one.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_disc_open() -> int {
  if(!backend.root) return stateFail("No machine is loaded");
  auto port = backend.root->find<ares::Node::Port>("PlayStation/Disc Tray");
  if(!port) return stateFail("The PlayStation core did not expose a disc tray");
  port->disconnect();
  backend.game.reset();
  return 1;
}

//data/size is the incoming .cue, its track files already handed over by ares_ps1_stage exactly as
//ares_ps1_load takes them. Neither ares::PlayStation::load nor root->power() is called: the machine
//keeps running and the game sees the door close on a new disc.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_disc_close(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No machine is loaded");
  if(!data || !size) return stateFail("Disc is empty");
  auto port = backend.root->find<ares::Node::Port>("PlayStation/Disc Tray");
  if(!port) return stateFail("The PlayStation core did not expose a disc tray");
  if(!writeFile(cuePath, data, size)) return stateFail("Could not write the in-memory disc file");
  auto medium = mia::Medium::create("PlayStation");
  auto result = medium->load(cuePath);
  if(result != successful) {
    clearStaged();
    string message = "Could not load the disc";
    if(result.info) message.append(": ", result.info);
    return stateFail(message);
  }
  backend.game = medium;
  port->allocate();
  port->connect();
  clearStaged();
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_set_input(u32 player, u32 mask) -> void {
  if(player < playerCount) backend.inputMask[player] = mask;
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(frequency);
  }
}

//takes effect on the next ares_ps1_load(); an empty or null name restores the NTSC-U default.
//the name must be one of ares::PlayStation::enumerate().
EMSCRIPTEN_KEEPALIVE auto ares_ps1_set_model(const char* name) -> void {
  backend.model = name ? name : "";
}

//the blitter hands over the display area the machine programmed, inside the 640x512 canvas the GPU
//declares (ares/ps1/gpu/gpu.cpp:25,42), so the width and height move as software changes the video
//mode. The pixels are square: no scale is set on either axis.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_ps1_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_ps1_state_size,
//following the ares_ps1_audio_frames / ares_ps1_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores, so keeping the states of different cores apart is the
//caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No machine is loaded"); return; }
  auto s = ares::PlayStation::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_ps1_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No machine is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::PlayStation::system.unserialize(s)) return stateFail("Not a valid state for the PlayStation core");
  return 1;
}

//the machine's persistent memory, packed as described in save-ram.hpp: the two memory cards, 128 KiB
//each, under the names given above. This is the battery, not the machine's state. It survives a
//different ares build, where a save state does not, and it carries nothing about where the game had
//got to -- and the two are not two views of one thing, because a card is deliberately not in a state
//at all: PeripheralPort::serialize has an empty body (ares/ps1/peripheral/port.cpp:60-61), so a state
//taken with a written card and loaded into a machine holding blank ones leaves them blank, exactly as
//a console's save state on real hardware says nothing about what is in the slots.
//no scheduler is entered by any of these four, so unlike ares_ps1_state_save this one could have
//returned its size; it splits size out anyway so the two read the same way.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_save_ram_save() -> void {
  backend.saveRamBytes.clear();
  if(!backend.root) { stateFail("No machine is loaded"); return; }
  //System::save() is what walks the two ports and asks each card to write its pak
  //(ares/ps1/system/system.cpp:122-126, peripheral/port.cpp:29-31)
  backend.root->save();
  cardsToBattery();
  ares_wasm::saveRamGather({}, {}, backend.battery, saveFiles, backend.saveRamBytes);
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_save_ram_size() -> u32 {
  return backend.saveRamBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_ps1_save_ram_data() -> const u8* {
  return backend.saveRamBytes.empty() ? nullptr : backend.saveRamBytes.data();
}

//a card fills its own 128 KiB from its pak once, in its constructor, and never looks again, so
//restoring re-seats both cards and power cycles the machine. Call it after ares_ps1_load and before
//running a frame and the machine is left where switching on with those two cards already in the slots
//would have left it.
EMSCRIPTEN_KEEPALIVE auto ares_ps1_save_ram_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No machine is loaded");
  if(!data || !size) return stateFail("Save data is empty");
  if(auto error = ares_wasm::saveRamApply({}, {}, backend.battery, saveFiles, data, size)) {
    return stateFail(error);
  }

  batteryToCards();
  for(u32 slot = 0; slot < cardCount; slot++) {
    if(auto port = backend.root->find<ares::Node::Port>(cardPorts[slot])) {
      port->allocate("Memory Card");
      port->connect();
    }
  }
  backend.root->power();
  return 1;
}

#if defined(ARES_WASM_DEBUG)
extern unsigned long long co_switch_count;

//instrumentation with no native counterpart: it exists for the smoke harness only, so it stays out
//of the default public ABI
EMSCRIPTEN_KEEPALIVE auto ares_ps1_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

EMSCRIPTEN_KEEPALIVE auto ares_ps1_error() -> const char* {
  return backend.error.data();
}

}
