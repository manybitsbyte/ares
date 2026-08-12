#pragma once
//started: 2021-05-18

#include <ares/ares.hpp>
#include <vector>

#include <component/processor/m68000/m68000.hpp>
#include <component/processor/z80/z80.hpp>
#include "ymfm_opn.h"

namespace ares::NeoGeo {
  #if defined(PLATFORM_WEB) && defined(ARES_NG_COTHREAD)
  //fidelity reference build: -DARES_NG_COTHREAD compiles this core's web fast paths out so the
  //cothread scheduler runs instead, which is what wasm/ng-sweep.mjs compares the web build
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

  struct Model {
    inline static auto NeoGeoAES() -> bool;
    inline static auto NeoGeoMVS() -> bool;
  };

  #include <ng/system/system.hpp>
  #include <ng/cartridge/cartridge.hpp>
  #include <ng/controller/controller.hpp>
  #include <ng/card/card.hpp>
  #include <ng/cpu/cpu.hpp>
  #include <ng/apu/apu.hpp>
  #include <ng/lspc/lspc.hpp>
  #include <ng/opnb/opnb.hpp>
}
