#include <ares/ares.hpp>
#include <ares/ng/ng.hpp>
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
  A      = 1 << 4,
  B      = 1 << 5,
  C      = 1 << 6,
  D      = 1 << 7,
  Select = 1 << 8,
  Start  = 1 << 9,
};

struct Backend : ares::Platform {
  auto pak(ares::Node::Object node) -> std::shared_ptr<vfs::directory> override {
    if(node->name() == "Neo Geo AES") return system ? system->pak : nullptr;
    //a .neo cartridge is assembled here rather than by mia, so it answers ahead of the mia pak
    if(node->name() == "Neo Geo Cartridge") {
      if(neoPak) return neoPak;
      return game ? game->pak : nullptr;
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
    if(input->name() == "A") bit = A;
    if(input->name() == "B") bit = B;
    if(input->name() == "C") bit = C;
    if(input->name() == "D") bit = D;
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
    neoPak.reset();
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
  std::shared_ptr<vfs::directory> neoPak;  //set only for a .neo cartridge; see loadNeo
  std::shared_ptr<mia::Pak> system;
  ares::Node::System root;
  std::vector<ares::Node::Audio::Stream> streams;
  std::vector<u32> videoPixels;
  std::vector<float> audioSamples;
  std::vector<u8> stateBytes;
  //the BIOS is kept until it is replaced, so one call covers every cartridge the page goes on to
  //load, exactly as a console keeps the same BIOS across cartridges. see ares_ng_set_bios.
  std::vector<u8> bios;
  u32 videoWidth = 0;
  u32 videoHeight = 0;
  u32 inputMask[2] = {};
  f64 audioFrequency = 48000.0;
  string error;
};

Backend backend;

//mia branches on the extension, not on the contents: NeoGeoAES::load opens a ".zip" as an archive
//and looks inside it for the single member named "neo-epo.bin", and takes anything else as the raw
//image. So the path this is written to has to agree with what the caller actually handed over, or a
//zip container gets byte-swapped and installed as though it were 68000 code. Both forms are worth
//accepting because both are what a BIOS arrives as: MAME's "aes" set is a zip of fourteen files,
//of which mia selects exactly the one it wants, and a BIOS dumped off a board is a bare image.
constexpr auto biosRawPath = "/ares-bios.bin";
constexpr auto biosZipPath = "/ares-bios.zip";

auto biosIsArchive() -> bool {
  auto& b = backend.bios;
  return b.size() >= 4 && b[0] == 'P' && b[1] == 'K' && b[2] == 0x03 && b[3] == 0x04;
}

auto biosPath() -> const char* {
  return biosIsArchive() ? biosZipPath : biosRawPath;
}

//Every cartridge is a MAME-format .zip, and mia identifies the romset by the zip's BASENAME:
//NeoGeo::load calls manifestDatabaseArcade(Medium::name(location)) to find the entry in
//"Neo Geo.bml" that says which file inside the archive supplies each of the six ROM regions and at
//what offset. So the set name is not cosmetic and cannot be defaulted -- it is the database key,
//and a zip written under the wrong name loads nothing. That is why ares_ng_load takes a name.
//
//The same reasoning is why staging exists. A clone set's archive holds only the files that differ
//from its parent, and Mame::loadRomFile falls back to {Location::path(location), parent, ".zip"} --
//a sibling path in the same directory. Writing both zips into the same MEMFS directory is what
//makes that fallback resolve, so ares_ng_stage lets the caller seat the parent archive first.
auto romPath(string name) -> string {
  return {"/", name, ".zip"};
}

auto writeFile(string path, const u8* data, u32 size) -> bool {
  auto file = std::fopen(path, "wb");
  if(!file) return false;
  auto written = std::fwrite(data, 1, size, file);
  std::fclose(file);
  return written == size;
}

auto fail(string message) -> int;

//A NeoSD .neo cartridge: a 4096-byte header naming the size of each of the six ROM regions, then
//those regions back to back. It is assembled into a pak here rather than handed to mia, because
//mia's Neo Geo path is MAME-shaped all the way down -- it keys the romset on the archive's basename,
//looks that up in "Neo Geo.bml" to learn which member file fills which region at which offset, and
//has nothing to say about a single file that simply states its own layout. Everything below stays
//in this file, so no shared or upstream code learns about the format.
//
//P is the one region that needs touching. Interface::load reads program.rom through fp->readm(2L),
//so the pak must hold big-endian words, and mia reaches that for a MAME set by applying the
//database's load16_word_swap. A .neo stores P in raw dump order, which was confirmed rather than
//assumed: read as-is the reset vectors are SSP=0x100000f3 / PC=0xc0000204, and word-swapped they
//are SSP=0x0010f300 -- work RAM -- and PC=0x00c00402, which is the BIOS entry a Neo Geo cartridge
//is supposed to hand control to. The other five regions are byte-addressed by the board and are
//stored in the order the hardware reads them, so they are copied straight across.
//
//What this path does NOT do is decrypt. mia's NeoGeo::decrypt handles the CMC42 and CMC50 boards,
//keyed on a database entry this format has no equivalent of, so an encrypted cartridge loaded this
//way would run scrambled graphics and, on CMC50, a scrambled Z80 program. Plain "rom" boards --
//which is most of the library, Double Dragon included -- are unaffected.
struct NeoHeader {
  u32 p, s, m, v1, v2, c;
  string name;
};

constexpr u32 neoHeaderSize = 4096;

auto neoRead32(const u8* p) -> u32 {
  return p[0] << 0 | p[1] << 8 | p[2] << 16 | p[3] << 24;  //the header is little-endian
}

auto neoIsCartridge(const u8* data, u32 size) -> bool {
  return size >= neoHeaderSize && data[0] == 'N' && data[1] == 'E' && data[2] == 'O';
}

auto loadNeo(const u8* data, u32 size) -> int {
  NeoHeader h;
  h.p  = neoRead32(data +  4);
  h.s  = neoRead32(data +  8);
  h.m  = neoRead32(data + 12);
  h.v1 = neoRead32(data + 16);
  h.v2 = neoRead32(data + 20);
  h.c  = neoRead32(data + 24);

  //the name field is a fixed 33 bytes and is not guaranteed to be terminated
  char title[34] = {};
  std::memcpy(title, data + 44, 33);
  h.name = (const char*)title;
  if(!h.name) h.name = "Neo Geo Cartridge";

  //every region must fall inside the file. a truncated download otherwise reads past the buffer.
  u64 total = (u64)neoHeaderSize + h.p + h.s + h.m + h.v1 + h.v2 + h.c;
  if(total > size) return fail("The .neo file is truncated: its header describes more data than the file holds");
  if(!h.p || !h.s || !h.m) return fail("The .neo file declares no program, static or music ROM");

  auto region = [&](u32 offset, u32 length) {
    return std::vector<u8>(data + offset, data + offset + length);
  };
  u32 offset = neoHeaderSize;
  auto p = region(offset, h.p); offset += h.p;
  auto s = region(offset, h.s); offset += h.s;
  auto m = region(offset, h.m); offset += h.m;
  auto va = region(offset, h.v1); offset += h.v1;
  auto vb = region(offset, h.v2); offset += h.v2;
  auto c = region(offset, h.c);

  for(u32 index = 0; index + 1 < p.size(); index += 2) std::swap(p[index], p[index + 1]);

  backend.neoPak = std::make_shared<vfs::directory>();
  backend.neoPak->setAttribute("title", h.name);
  backend.neoPak->setAttribute("board", "rom");
  backend.neoPak->append("program.rom", p);
  backend.neoPak->append("music.rom", m);
  backend.neoPak->append("character.rom", c);
  backend.neoPak->append("static.rom", s);
  backend.neoPak->append("voice-a.rom", va);
  backend.neoPak->append("voice-b.rom", vb);
  return 1;
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

EMSCRIPTEN_KEEPALIVE auto ares_ng_alloc(u32 size) -> void* {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_free(void* memory) -> void {
  std::free(memory);
}

//the BIOS the caller supplied, as a raw neo-epo.bin image. ares has no substitute for it: the AES
//holds the 68000 in reset until it fetches its vectors from the BIOS at 0x000000, and the BIOS is
//what seats the cartridge, clears RAM and jumps into the P ROM. SNK's BIOS is not in this
//repository and will not be. mia byte-swaps the image on load, so hand over the file as it sits on
//disk. Passing size 0 (or a null pointer) forgets the BIOS.
EMSCRIPTEN_KEEPALIVE auto ares_ng_set_bios(const u8* data, u32 size) -> void {
  backend.bios.assign(data, data + (data ? size : 0));
}

//seat an additional MAME archive in the same directory as the one ares_ng_load will name, so that
//a clone set can reach the files it inherits from its parent. call it before ares_ng_load; it
//touches no core state and does not need a machine.
EMSCRIPTEN_KEEPALIVE auto ares_ng_stage(const char* name, const u8* data, u32 size) -> int {
  if(!name || !*name) return stateFail("A romset name is required");
  if(!data || !size) return stateFail("Archive is empty");
  if(!writeFile(romPath(name), data, size)) return stateFail("Could not write the in-memory archive");
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_load(const u8* data, u32 size, const char* name) -> int {
  backend.unload();
  backend.error = {};
  ares::platform = &backend;

  if(!data || !size) return fail("ROM is empty");
  if(backend.bios.empty()) return fail("No BIOS is loaded; call ares_ng_set_bios first");

  if(!writeFile(biosPath(), backend.bios.data(), backend.bios.size())) {
    return fail("Could not write the in-memory BIOS file");
  }

  //the BIOS is loaded before the cartridge so that a bad BIOS is reported as a bad BIOS. the two
  //loads are independent, and with the cartridge first every BIOS failure arrived wearing a
  //cartridge error's name.
  backend.system = mia::System::create("Neo Geo AES");
  auto result = backend.system->load(biosPath());
  if(result != successful) {
    if(biosIsArchive()) return fail("Could not load the BIOS: the archive has no neo-epo.bin", result);
    return fail("Could not load the BIOS", result);
  }

  //a .neo states its own layout, so it needs neither a romset name nor the database
  if(neoIsCartridge(data, size)) {
    if(!loadNeo(data, size)) return 0;  //loadNeo has already reported through fail()
  } else {
    if(!name || !*name) return fail("A romset name is required for a MAME archive");
    auto path = romPath(name);
    if(!writeFile(path, data, size)) return fail("Could not write the in-memory ROM file");

    backend.game = mia::Medium::create("Neo Geo");
    result = backend.game->load(path);
    if(result != successful) return fail("Could not load the cartridge", result);
  }

  if(!ares::NeoGeo::load(backend.root, "[SNK] Neo Geo AES")) {
    return fail("Could not initialize the Neo Geo core");
  }

  if(auto port = backend.root->find<ares::Node::Port>("Cartridge Slot")) {
    port->allocate();
    port->connect();
  } else {
    return fail("The Neo Geo core did not expose a cartridge slot");
  }

  for(auto portName : {"Controller Port 1", "Controller Port 2"}) {
    if(auto port = backend.root->find<ares::Node::Port>(portName)) {
      port->allocate("Arcade Stick");
      port->connect();
    }
  }

  //the memory card is the AES's only writable medium. ares gives it no pak and no save path, so it
  //lives and dies with a save state; it is seated anyway because a game that probes for one and
  //finds nothing takes a different branch than one that finds a blank card.
  if(auto port = backend.root->find<ares::Node::Port>("Memory Card Slot")) {
    port->allocate("Memory Card");
    port->connect();
  }

  backend.streams = backend.root->find<ares::Node::Audio::Stream>();
  backend.root->power();
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(backend.audioFrequency);
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_unload() -> void {
  backend.unload();
  std::remove(biosRawPath);
  std::remove(biosZipPath);
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_run_frame() -> void {
  if(!backend.root) return;
  backend.audioSamples.clear();
  backend.root->run();
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_set_input(u32 player, u32 mask) -> void {
  if(player < 2) backend.inputMask[player] = mask;
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_set_audio_frequency(u32 frequency) -> void {
  if(frequency < 8000 || frequency > 192000) return;
  backend.audioFrequency = frequency;
  for(auto stream : backend.streams) {
    stream->setResamplerFrequency(frequency);
  }
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_video_data() -> const u32* {
  return backend.videoPixels.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_video_width() -> u32 {
  return backend.videoWidth;
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_video_height() -> u32 {
  return backend.videoHeight;
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_audio_data() -> const float* {
  return backend.audioSamples.data();
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_audio_frames() -> u32 {
  return backend.audioSamples.size() / 2;
}

//a synchronized save runs the scheduler to a safe point, which crosses an Asyncify fiber switch, so
//this returns void for the same reason ares_ng_run_frame does: the export unwinds and JS is handed
//the unwind's value rather than the function's. the size is read back with ares_ng_state_size,
//following the ares_ng_audio_frames / ares_ng_audio_data split, which exists for the same reason.
//synchronize != 0 yields a persistable state; synchronize == 0 yields a run-ahead state that also
//embeds raw cothread stacks full of host pointers, so it is only valid inside this process.
//a state is validated against a shared SerializerSignature plus a per-core version string, and those
//version strings are not unique across cores, so keeping the states of different cores apart is the
//caller's job.
EMSCRIPTEN_KEEPALIVE auto ares_ng_state_save(int synchronize) -> void {
  backend.stateBytes.clear();
  if(!backend.root) { stateFail("No cartridge is loaded"); return; }
  auto s = ares::NeoGeo::system.serialize(synchronize != 0);
  if(!s.size()) { stateFail("Could not serialize the machine state"); return; }
  //the serializer is a local, so the bytes are copied into the backend to outlive it; they are held
  //exactly like the video and audio buffers and stay valid until the next save or unload
  backend.stateBytes.assign(s.data(), s.data() + s.size());
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_state_size() -> u32 {
  return backend.stateBytes.size();
}

EMSCRIPTEN_KEEPALIVE auto ares_ng_state_data() -> const u8* {
  return backend.stateBytes.empty() ? nullptr : backend.stateBytes.data();
}

//unserialize reads the machine back and, for a synchronized state, power cycles it; neither path
//enters the scheduler, so no fiber switch is crossed and the return value survives
EMSCRIPTEN_KEEPALIVE auto ares_ng_state_load(const u8* data, u32 size) -> int {
  if(!backend.root) return stateFail("No cartridge is loaded");
  if(!data || !size) return stateFail("State is empty");
  serializer s{data, size};
  if(!ares::NeoGeo::system.unserialize(s)) return stateFail("Not a valid state for the Neo Geo core");
  return 1;
}

//there is deliberately no ares_ng_save_ram_* here. The AES writes to exactly one thing that outlives
//a power cycle -- the memory card -- and ares models the card as 2 KiB of RAM with no pak behind it:
//CardSlot::save() is empty and mia's NeoGeoAES::save() and NeoGeo::save() both return true without
//writing. The card's contents ride in a save state and nowhere else. Exporting a battery API that
//could only ever gather zero bytes would say the opposite of what is true.

#if defined(ARES_WASM_DEBUG)
extern unsigned long long co_switch_count;

//instrumentation with no native counterpart: it exists for the smoke harness only, so it stays out
//of the default public ABI
EMSCRIPTEN_KEEPALIVE auto ares_ng_switch_count() -> u32 {
  return (u32)co_switch_count;
}
#endif

EMSCRIPTEN_KEEPALIVE auto ares_ng_error() -> const char* {
  return backend.error.data();
}

}
