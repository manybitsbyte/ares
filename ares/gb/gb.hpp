#pragma once
//started: 2010-12-27

#include <ares/ares.hpp>
#include <vector>

//fidelity reference build: -DARES_GB_COTHREAD compiles this core's web fast paths out so the
//cothread scheduler runs instead, which is what wasm/gb-sweep.mjs compares the web build against.
//placed after <ares/ares.hpp> so nall and the scheduler keep their web builds.
//
//unlike ares/ms/ms.hpp, which nothing else includes, this header is pulled in at file scope by
//ares/sfc/sfc.hpp when CORE_GB is defined -- so the #undef would stay in force for the rest of
//every Super Famicom translation unit and silently compile out sfc's own web paths too.
//**configure the reference build with -DARES_CORES=gb**, which is what wasm/README.md specifies
//and what keeps this to one core.
#if defined(PLATFORM_WEB) && defined(ARES_GB_COTHREAD)
  #undef PLATFORM_WEB
#endif

#include <component/processor/sm83/sm83.hpp>
#include <component/eeprom/m93lcx6/m93lcx6.hpp>

namespace ares::GameBoy {
  #include <ares/inline.hpp>
  auto enumerate() -> std::vector<string>;
  auto load(Node::System& node, string name) -> bool;

  struct Model {
    inline static auto GameBoy() -> bool;
    inline static auto GameBoyColor() -> bool;
    inline static auto SuperGameBoy() -> bool;
  };

  struct SuperGameBoyInterface {
    virtual auto ppuHreset() -> void = 0;
    virtual auto ppuVreset() -> void = 0;
    virtual auto ppuWrite(n2 color) -> void = 0;
    virtual auto joypWrite(n1 p14, n1 p15) -> void = 0;
  };

  #include <gb/system/system.hpp>
  #include <gb/bus/bus.hpp>
  #include <gb/cartridge/cartridge.hpp>
  #include <gb/cpu/cpu.hpp>
  #include <gb/ppu/ppu.hpp>
  #include <gb/apu/apu.hpp>
}
