#pragma once

//The ares debugger node tree, flattened for the wasm C ABI.
//
//Include this after <ares/ares.hpp> and <mia/mia.hpp> and take nall's string and vfs types and the
//ares::Node aliases from them, for the reason save-ram.hpp records: mia.hpp carries no include guard
//and pulls in a second copy of every medium declaration when it is included twice.
//
//Nothing is added to ares here. Every node this walks is already constructed unconditionally by the
//cores themselves -- fc/cpu/debugger.cpp:2-14 appends its Memory and Tracer nodes with no
//preprocessor guard anywhere in the path -- and Backend::root in each wasm/*.cpp is the same
//ares::Node::System that desktop-ui's eight tool panes enumerate. The tree was always linked into
//the shipped module; it simply had no door on it. This header is the door: one flat index space over
//every debuggable node, six enumeration walks mirroring desktop-ui/tools/{memory,graphics,properties,
//tracer,streams,manifest}.cpp, plus the backend-owned buffers a pointer-returning ABI needs.
//
//Indices are stable only between rebuilds. A rebuild happens on the first debug call after a load;
//unload() clears the table, so seating a different cartridge renumbers everything. A screen reads the
//list, it does not cache an index across a load.
//
//Buffers are allocated on first use and never before, so a module nobody asks to debug pays for the
//19 exported wrappers and nothing else.

//ares.hpp carries a #pragma once, so naming it here costs the build nothing -- every wasm/*.cpp has
//already included it by this point. It is named so the header parses on its own, which is what a
//language server does when you open it: without this, u32 and ares::Node read as undeclared and the
//file shows hundreds of errors that have nothing to do with whether it compiles.
#include <ares/ares.hpp>

#include <cstring>
#include <deque>
#include <string>
#include <vector>

namespace ares_wasm {

//the kind codes are ABI. 0 is "out of range", not "unknown kind" -- every row in the table has a
//kind in 1..7 by construction.
enum : u32 {
  DebugKindNone         = 0,
  DebugKindMemory       = 1,
  DebugKindGraphics     = 2,
  DebugKindProperties   = 3,
  DebugKindInstruction  = 4,
  DebugKindNotification = 5,
  DebugKindStream       = 6,
  DebugKindManifest     = 7,
};

//an instruction tracer emits one line per executed instruction and these CPUs run at MHz rates, so
//an unbounded log is a page kill rather than a slow page. whichever of the two caps binds first ends
//the line's life; eviction is oldest-first, because a tail is what a reader wants.
inline constexpr u32 debugTraceLines = 4096;
inline constexpr u32 debugTraceBytes = 256 * 1024;

struct DebugSurface {
  struct Row {
    u32 kind = DebugKindNone;
    std::string name;
    ares::Node::Object node;
  };

  //---- lifetime -------------------------------------------------------------------------------

  //called from Backend::unload. the rows hold shared_ptrs into the machine, so leaving them behind
  //would keep a torn-down tree alive.
  auto clear() -> void {
    rows.clear();
    built = false;
    memoryBuffer.clear();
    memoryBuffer.shrink_to_fit();
    captureBuffer.clear();
    captureBuffer.shrink_to_fit();
    drainBuffer.clear();
    drainBuffer.shrink_to_fit();
    text.clear();
    ring.clear();
    ringBytes = 0;
    dropped = 0;
    drained = 0;
  }

  //every export enters here first. with no machine loaded nothing is built and every accessor
  //answers its empty value, which is the answer and not a failure.
  auto sync(const ares::Node::System& root) -> void {
    if(built || !root) return;
    rebuild(root);
  }

  //one walk per node class, appended into one index space. this is the only place in the tree that
  //calls Node::enumerate; a core's own file adds a macro line and no logic.
  auto rebuild(const ares::Node::System& root) -> void {
    rows.clear();
    built = true;

    for(auto node : ares::Node::enumerate<ares::Node::Debugger::Memory>(root)) {
      rows.push_back(Row{DebugKindMemory, own(node->name()), node});
    }
    for(auto node : ares::Node::enumerate<ares::Node::Debugger::Graphics>(root)) {
      rows.push_back(Row{DebugKindGraphics, own(node->name()), node});
    }
    for(auto node : ares::Node::enumerate<ares::Node::Debugger::Properties>(root)) {
      rows.push_back(Row{DebugKindProperties, own(node->name()), node});
    }
    //Instruction and Notification both derive from Tracer, so one walk finds both and the cast
    //splits them. the split is deliberate: it tells the caller whether set_mask applies without a
    //second call. the name is composed the way desktop-ui/tools/tracer.cpp:39 composes it.
    for(auto node : ares::Node::enumerate<ares::Node::Debugger::Tracer::Tracer>(root)) {
      auto kind = node->cast<ares::Node::Debugger::Tracer::Instruction>()
        ? DebugKindInstruction : DebugKindNotification;
      rows.push_back(Row{kind, own(string{node->component(), " ", node->name()}), node});
    }
    for(auto node : ares::Node::enumerate<ares::Node::Audio::Stream>(root)) {
      rows.push_back(Row{DebugKindStream, own(node->name()), node});
    }
    //a manifest node is any object carrying a pak with a manifest.bml in it, which is how
    //desktop-ui/tools/manifest.cpp:12-20 finds them. enumerate<Object> matches every node.
    for(auto node : ares::Node::enumerate<ares::Node::Object>(root)) {
      if(auto pak = node->pak()) {
        if(pak->read("manifest.bml")) rows.push_back(Row{DebugKindManifest, own(node->name()), node});
      }
    }
  }

  //---- enumeration ----------------------------------------------------------------------------

  auto count(const ares::Node::System& root) -> u32 {
    sync(root);
    return (u32)rows.size();
  }

  auto kind(const ares::Node::System& root, u32 index) -> u32 {
    sync(root);
    return index < rows.size() ? rows[index].kind : DebugKindNone;
  }

  auto name(const ares::Node::System& root, u32 index) -> const char* {
    sync(root);
    return index < rows.size() ? rows[index].name.c_str() : "";
  }

  //---- memory ---------------------------------------------------------------------------------

  auto memorySize(const ares::Node::System& root, u32 index) -> u32 {
    sync(root);
    auto node = at<ares::Node::Debugger::Memory>(index, DebugKindMemory);
    return node ? node->size() : 0;
  }

  //Memory::read is a std::function<u8 (u32)> call per byte, so a per-byte export would make a 64 KiB
  //page 65,536 boundary crossings. the length parameter makes it one crossing and 65,536 in-wasm
  //calls. the buffer is always `length` bytes so the caller's view is never short; bytes outside the
  //node's size read as zero rather than shifting the window.
  auto memoryRead(const ares::Node::System& root, u32 index, u32 address, u32 length) -> const u8* {
    sync(root);
    memoryBuffer.assign(length, 0);
    auto node = at<ares::Node::Debugger::Memory>(index, DebugKindMemory);
    if(node) {
      auto size = node->size();
      for(u32 offset = 0; offset < length && address + offset < size; offset++) {
        memoryBuffer[offset] = node->read(address + offset);
      }
    }
    return memoryBuffer.empty() ? nullptr : memoryBuffer.data();
  }

  //off unless armed. a debug write into a running game corrupts it in a way that reads as a player
  //bug, so the default has to be the safe one.
  auto memoryWrite(const ares::Node::System& root, u32 index, u32 address, u32 data) -> void {
    sync(root);
    if(!armed) return;
    auto node = at<ares::Node::Debugger::Memory>(index, DebugKindMemory);
    if(node && address < node->size()) node->write(address, (u8)data);
  }

  auto setArmed(bool value) -> void { armed = value; }

  //---- graphics -------------------------------------------------------------------------------

  auto graphicsWidth(const ares::Node::System& root, u32 index) -> u32 {
    sync(root);
    auto node = at<ares::Node::Debugger::Graphics>(index, DebugKindGraphics);
    return node ? node->width() : 0;
  }

  auto graphicsHeight(const ares::Node::System& root, u32 index) -> u32 {
    sync(root);
    auto node = at<ares::Node::Debugger::Graphics>(index, DebugKindGraphics);
    return node ? node->height() : 0;
  }

  //Graphics::capture() yields 0x00RRGGBB and returns its vector by value; desktop-ui/tools/
  //graphics.cpp:47 ORs the alpha in itself, so this does too. a caller handed 0x00-alpha pixels
  //draws nothing onto a canvas and has no way to tell that from a black picture.
  auto graphicsCapture(const ares::Node::System& root, u32 index) -> const u32* {
    sync(root);
    captureBuffer.clear();
    auto node = at<ares::Node::Debugger::Graphics>(index, DebugKindGraphics);
    if(!node) return nullptr;
    auto pixels = node->capture();
    captureBuffer.assign((size_t)node->width() * node->height(), 255u << 24);
    for(size_t offset = 0; offset < captureBuffer.size() && offset < pixels.size(); offset++) {
      captureBuffer[offset] = 255u << 24 | pixels[offset];
    }
    return captureBuffer.empty() ? nullptr : captureBuffer.data();
  }

  //---- properties -----------------------------------------------------------------------------

  auto propertiesQuery(const ares::Node::System& root, u32 index) -> const char* {
    sync(root);
    text.clear();
    auto node = at<ares::Node::Debugger::Properties>(index, DebugKindProperties);
    if(node) text = own(node->query());
    return text.c_str();
  }

  //---- manifest -------------------------------------------------------------------------------

  auto manifestText(const ares::Node::System& root, u32 index) -> const char* {
    sync(root);
    text.clear();
    if(index < rows.size() && rows[index].kind == DebugKindManifest) {
      if(auto pak = rows[index].node->pak()) {
        if(auto fp = pak->read("manifest.bml")) text = own(fp->reads());
      }
    }
    return text.c_str();
  }

  //---- streams --------------------------------------------------------------------------------

  auto streamChannels(const ares::Node::System& root, u32 index) -> u32 {
    sync(root);
    auto node = at<ares::Node::Audio::Stream>(index, DebugKindStream);
    return node ? node->channels() : 0;
  }

  //whole Hz, matching desktop-ui/tools/streams.cpp:32
  auto streamFrequency(const ares::Node::System& root, u32 index) -> u32 {
    sync(root);
    auto node = at<ares::Node::Audio::Stream>(index, DebugKindStream);
    return node ? (u32)(node->frequency() + 0.5) : 0;
  }

  auto streamSetMuted(const ares::Node::System& root, u32 index, int muted) -> void {
    sync(root);
    auto node = at<ares::Node::Audio::Stream>(index, DebugKindStream);
    if(node) node->setMuted(muted != 0);
  }

  //---- tracers --------------------------------------------------------------------------------

  //setTerminal is the flag Tracer::enabled() reads, and enabled() is what gates every notify().
  auto tracerSetEnabled(const ares::Node::System& root, u32 index, int on) -> void {
    sync(root);
    auto node = tracerAt(index);
    if(node) node->setTerminal(on != 0);
  }

  //a no-op on a notification tracer, which has no mask
  auto tracerSetMask(const ares::Node::System& root, u32 index, int on) -> void {
    sync(root);
    if(index >= rows.size() || rows[index].kind != DebugKindInstruction) return;
    if(auto node = rows[index].node->cast<ares::Node::Debugger::Tracer::Instruction>()) {
      node->setMask(on != 0);
    }
  }

  //the ring's producer: Platform::log lands here, one call per emitted line.
  auto trace(const char* data, u32 size) -> void {
    ring.emplace_back(data, size);
    ringBytes += size + 1;
    //oldest-first: a full ring drops its head and keeps the line that just arrived. the guard is for
    //a single line larger than the byte cap, which would otherwise empty the ring and loop.
    while(ring.size() > 1 && (ring.size() > debugTraceLines || ringBytes > debugTraceBytes)) {
      ringBytes -= (u32)ring.front().size() + 1;
      ring.pop_front();
      dropped++;
    }
  }

  //drain mirrors the audio pair: a size call, then a pointer call. lines are NUL-separated rather
  //than newline-separated because a trace line can contain anything but a NUL.
  auto tracerDrain() -> u32 {
    drainBuffer.clear();
    drainBuffer.reserve(ringBytes);
    for(auto& line : ring) {
      drainBuffer.insert(drainBuffer.end(), line.begin(), line.end());
      drainBuffer.push_back(0);
    }
    ring.clear();
    ringBytes = 0;
    //the counter resets on drain, but the caller reads it after the drain that produced it, so the
    //value is carried across rather than zeroed outright.
    drained = dropped;
    dropped = 0;
    return (u32)drainBuffer.size();
  }

  auto tracerData() -> const u8* {
    return drainBuffer.empty() ? nullptr : drainBuffer.data();
  }

  auto tracerDropped() -> u32 {
    return drained;
  }

private:
  template<typename T>
  auto at(u32 index, u32 wanted) -> T {
    if(index >= rows.size() || rows[index].kind != wanted) return {};
    return rows[index].node->cast<T>();
  }

  auto tracerAt(u32 index) -> ares::Node::Debugger::Tracer::Tracer {
    if(index >= rows.size()) return {};
    if(rows[index].kind != DebugKindInstruction && rows[index].kind != DebugKindNotification) return {};
    return rows[index].node->cast<ares::Node::Debugger::Tracer::Tracer>();
  }

  //nall::string is refcounted and shared; the table outlives the call that built it, so the bytes
  //are copied into a std::string whose c_str() a C caller can hold until the next rebuild.
  static auto own(const string& value) -> std::string {
    return std::string(value.data(), value.size());
  }

  std::vector<Row> rows;
  bool built = false;
  bool armed = false;
  std::vector<u8> memoryBuffer;
  std::vector<u32> captureBuffer;
  std::vector<u8> drainBuffer;
  std::string text;
  std::deque<std::string> ring;
  u32 ringBytes = 0;
  u32 dropped = 0;
  u32 drained = 0;
};

inline DebugSurface debug;

}

//19 exports per core, every one a single line forwarding into the header above. `k` is the core key
//-- fc sfc ms md gb gba ng pce ps1 -- and `backend` is the file-local Backend every wasm/*.cpp
//already declares. Expand once inside a core's extern "C" block; the core adds no other debug code
//beyond the Platform::log override and the clear() in its unload.
#define ARES_WASM_DEBUG_EXPORTS(k) \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_node_count() -> u32 { return ares_wasm::debug.count(backend.root); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_node_kind(u32 index) -> u32 { return ares_wasm::debug.kind(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_node_name(u32 index) -> const char* { return ares_wasm::debug.name(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_memory_size(u32 index) -> u32 { return ares_wasm::debug.memorySize(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_memory_read(u32 index, u32 address, u32 length) -> const u8* { return ares_wasm::debug.memoryRead(backend.root, index, address, length); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_memory_write(u32 index, u32 address, u32 data) -> void { ares_wasm::debug.memoryWrite(backend.root, index, address, data); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_graphics_width(u32 index) -> u32 { return ares_wasm::debug.graphicsWidth(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_graphics_height(u32 index) -> u32 { return ares_wasm::debug.graphicsHeight(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_graphics_capture(u32 index) -> const u32* { return ares_wasm::debug.graphicsCapture(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_properties_query(u32 index) -> const char* { return ares_wasm::debug.propertiesQuery(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_manifest_text(u32 index) -> const char* { return ares_wasm::debug.manifestText(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_stream_channels(u32 index) -> u32 { return ares_wasm::debug.streamChannels(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_stream_frequency(u32 index) -> u32 { return ares_wasm::debug.streamFrequency(backend.root, index); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_stream_set_muted(u32 index, int muted) -> void { ares_wasm::debug.streamSetMuted(backend.root, index, muted); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_tracer_set_enabled(u32 index, int on) -> void { ares_wasm::debug.tracerSetEnabled(backend.root, index, on); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_tracer_set_mask(u32 index, int on) -> void { ares_wasm::debug.tracerSetMask(backend.root, index, on); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_tracer_drain() -> u32 { return ares_wasm::debug.tracerDrain(); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_tracer_data() -> const u8* { return ares_wasm::debug.tracerData(); } \
  EMSCRIPTEN_KEEPALIVE auto ares_##k##_debug_tracer_dropped() -> u32 { return ares_wasm::debug.tracerDropped(); }
