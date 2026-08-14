#pragma once
//started: 2020-06-17

#include <ares/ares.hpp>
#include <span>
#include <vector>
#include <nall/hashset.hpp>
#include <component/processor/m68hc05/m68hc05.hpp>

namespace ares::PlayStation {
  #if defined(PLATFORM_WEB) && defined(ARES_PS1_COTHREAD)
  //fidelity reference build: -DARES_PS1_COTHREAD compiles this core's web fast paths out so the
  //cothread scheduler runs instead, which is what wasm/ps1-sweep.mjs compares the web build
  //against. placed inside the namespace, ahead of <ares/inline.hpp>, so this core's copy of the
  //scheduler's inline code loses its web arms too and only this core is affected; and between two
  //adjacent non-blank lines because the native preprocessor replaces a skipped region of eight or
  //more lines with a single line marker, swallowing any neighbouring blank lines with it -- here
  //there are none to swallow, so native's preprocessed text stays byte-identical to upstream's.
  #undef PLATFORM_WEB
  #endif
  #include <ares/inline.hpp>
  auto enumerate() -> std::vector<string>;
  auto load(Node::System& node, string name) -> bool;
  auto option(string name, string value) -> bool;

  enum : bool { Read = 0, Write = 1 };
  enum : u32  { Byte = 1, Half = 2, Word = 4 };

  struct Region {
    inline static auto NTSCJ() -> bool;
    inline static auto NTSCU() -> bool;
    inline static auto PAL() -> bool;
  };

  #include <ps1/accuracy.hpp>
  #include <ps1/memory/memory.hpp>
  #include <ps1/system/system.hpp>
  #include <ps1/disc/disc.hpp>
  #include <ps1/cpu/cpu.hpp>
  #include <ps1/gpu/gpu.hpp>
  #include <ps1/spu/spu.hpp>
  #include <ps1/mdec/mdec.hpp>
  #include <ps1/interrupt/interrupt.hpp>
  #include <ps1/peripheral/peripheral.hpp>
  #include <ps1/dma/dma.hpp>
  #include <ps1/timer/timer.hpp>
  #include <ps1/memory/bus.hpp>
}
