#pragma once
//started: 2011-09-05

#include <ares/ares.hpp>
#include <vector>

#include <component/processor/mos6502/mos6502.hpp>
#include <component/audio/ym2149/ym2149.hpp>
#include <component/audio/ym2413/ym2413.hpp>
#include <component/eeprom/m24c/m24c.hpp>
#include <component/flash/sst39sf0x0/sst39sf0x0.hpp>
#include "ymfm_opn.h"

namespace ares::Famicom {
  #if defined(PLATFORM_WEB) && defined(ARES_FC_COTHREAD)
  //fidelity reference build: -DARES_FC_COTHREAD compiles this core's web fast paths out so the
  //cothread scheduler runs instead, which is what the fc golden comparisons measure the web build
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

  struct Region {
    static inline auto NTSCJ() -> bool;
    static inline auto NTSCU() -> bool;
    static inline auto PAL()   -> bool;
    static inline auto Dendy() -> bool;
  };

  #include <fc/controller/controller.hpp>
  #include <fc/expansion/expansion.hpp>
  #include <fc/system/system.hpp>
  #include <fc/cartridge/cartridge.hpp>
  #include <fc/cpu/cpu.hpp>
  #include <fc/apu/apu.hpp>
  #include <fc/ppu/ppu.hpp>
  #include <fc/fds/fds.hpp>
}
