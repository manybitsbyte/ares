#pragma once

//Persistent cartridge memory — battery-backed RAM, EEPROM, flash and real-time clocks.
//
//Include this after <ares/ares.hpp> and <mia/mia.hpp> and take nall's string, markup and vfs types
//from them. It cannot include them itself: mia.hpp carries no include guard and pulls in a second
//copy of every medium declaration when it is included twice.
//
//ares keeps a cartridge's persistent memory in two places. The pak holds the file a front end loaded
//from disk; the board holds the copy the machine reads and writes. The board fills its copy from the
//pak once, when the cartridge is seated, and writes it back only when the system is asked to save.
//Both directions here go through the pak, which is why restoring re-seats the cartridge: writing the
//pak alone would leave the running machine on the bytes it already had.
//
//A cartridge can carry more than one persistent memory at once — a Mega Drive board with both SRAM
//and an EEPROM, a Super Famicom board with save RAM and a real-time clock — so this gathers all of
//them into one blob rather than handing the caller an anonymous byte range to split without having
//been told how:
//
//  magic    4 bytes  "ARSV"
//  version  u32      1
//  count    u32      number of entries
//  entry    u32 name size, name bytes, u32 data size, data bytes   (repeated count times)
//
//Integers are little endian. Names are the pak's own file names — save.ram, save.eeprom, time.rtc —
//so a blob says what it holds. An entry naming a memory this cartridge does not have is skipped
//rather than applied to whatever sits at the same index, and an entry naming a memory outside the
//cartridge's persistent set is skipped rather than allowed to overwrite the ROM.

namespace ares_wasm {

//one manifest memory node, identified the way mia's own Medium::save() identifies them. each core
//passes the list its console persists; the lists are not the same, and a memory mia does not save is
//not persistent even when its type suggests it is — the NES writes character RAM every frame and
//never persists a byte of it.
struct SaveMemory {
  const char* type;     //RAM, EEPROM, Flash, RTC
  const char* content;  //Save, Program, Internal, Download, Data, Time
};

inline constexpr u8 saveRamMagic[4] = {'A', 'R', 'S', 'V'};
inline constexpr u32 saveRamVersion = 1;
inline constexpr u32 saveRamHeaderSize = 12;

//the pak file name mia derives for a manifest memory node: [architecture.]content.type, downcased.
//this is Pak::save()'s own rule, and a name built any other way would not find the file.
inline auto saveRamName(Markup::Node node) -> string {
  string name;
  if(auto architecture = node["architecture"].string()) name.append(architecture, ".");
  name.append(node["content"].string(), ".");
  name.append(node["type"].string());
  name.downcase();
  return name;
}

//the pak files this cartridge's manifest declares persistent, in the order the core lists them
inline auto saveRamNames(const std::shared_ptr<mia::Pak>& game, const std::vector<SaveMemory>& memories) -> std::vector<string> {
  std::vector<string> names;
  if(!game || !game->pak) return names;
  auto document = BML::unserialize(game->manifest);
  for(auto& memory : memories) {
    auto node = document[string{"game/board/memory(type=", memory.type, ",content=", memory.content, ")"}];
    if(!node) continue;
    auto name = saveRamName(node);
    if(name && game->pak->find(name)) names.push_back(name);
  }
  return names;
}

inline auto saveRamWrite32(std::vector<u8>& output, u32 value) -> void {
  output.push_back(value >>  0 & 0xff);
  output.push_back(value >>  8 & 0xff);
  output.push_back(value >> 16 & 0xff);
  output.push_back(value >> 24 & 0xff);
}

inline auto saveRamRead32(const u8* data) -> u32 {
  return (u32)data[0] << 0 | (u32)data[1] << 8 | (u32)data[2] << 16 | (u32)data[3] << 24;
}

//the cartridge's persistent memory as one blob, empty when it has none. the caller flushes the board
//into the pak first — that belongs to the system node, which this header does not hold.
inline auto saveRamGather(const std::shared_ptr<mia::Pak>& game, const std::vector<SaveMemory>& memories, std::vector<u8>& output) -> void {
  output.clear();

  std::vector<string> names;
  std::vector<std::shared_ptr<vfs::file>> files;
  for(auto& name : saveRamNames(game, memories)) {
    auto fp = game->pak->read(name);
    if(!fp || !fp->size()) continue;
    names.push_back(name);
    files.push_back(fp);
  }
  if(names.empty()) return;

  output.insert(output.end(), saveRamMagic, saveRamMagic + 4);
  saveRamWrite32(output, saveRamVersion);
  saveRamWrite32(output, (u32)names.size());
  for(u32 index = 0; index < names.size(); index++) {
    auto& name = names[index];
    auto& fp = files[index];
    saveRamWrite32(output, name.size());
    output.insert(output.end(), (const u8*)name.data(), (const u8*)name.data() + name.size());
    saveRamWrite32(output, (u32)fp->size());
    output.insert(output.end(), fp->data(), fp->data() + fp->size());
  }
}

//writes a blob back into the pak. returns an empty string on success and the reason otherwise; the
//caller re-seats the cartridge afterwards, because the board is still holding its own copy.
inline auto saveRamApply(const std::shared_ptr<mia::Pak>& game, const std::vector<SaveMemory>& memories, const u8* data, u32 size) -> string {
  if(size < saveRamHeaderSize) return "Save data is too short to be a save";
  if(std::memcmp(data, saveRamMagic, 4)) return "Not save data written by an ares core";
  if(saveRamRead32(data + 4) != saveRamVersion) return "Save data is in a newer format than this core reads";

  auto names = saveRamNames(game, memories);
  if(names.empty()) return "This cartridge has no persistent memory";

  auto count = saveRamRead32(data + 8);
  u32 offset = saveRamHeaderSize;
  u32 applied = 0;
  for(u32 remaining = count; remaining; remaining--) {
    if(size - offset < 4) return "Save data ends mid-entry";
    auto nameSize = saveRamRead32(data + offset);
    offset += 4;
    if(nameSize > size - offset) return "Save data ends mid-entry";
    auto nameOffset = offset;
    offset += nameSize;

    if(size - offset < 4) return "Save data ends mid-entry";
    auto dataSize = saveRamRead32(data + offset);
    offset += 4;
    if(dataSize > size - offset) return "Save data ends mid-entry";

    for(auto& name : names) {
      if(name.size() != nameSize) continue;
      if(std::memcmp(name.data(), data + nameOffset, nameSize)) continue;
      if(auto fp = game->pak->write(name)) {
        //a shorter entry leaves the tail of the memory at whatever mia filled it with, which is what
        //a cartridge whose save file predates a larger battery would have seen on real hardware
        auto length = dataSize < fp->size() ? (u64)dataSize : fp->size();
        std::memcpy(fp->data(), data + offset, length);
        applied++;
      }
      break;
    }
    offset += dataSize;
  }

  if(!applied) return "Save data holds nothing this cartridge can use";
  return {};
}

}
