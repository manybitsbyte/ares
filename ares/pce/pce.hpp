#pragma once
//started: 2017-01-11

#include <ares/ares.hpp>
#include <nall/decode/mmi.hpp>
#include <vector>
#include <cmath>
#include <thread>
#include <atomic>
#include <functional>

#include <qon/qon.h>
#include <qon/qoi2.h>

//fidelity reference build: -DARES_PCE_COTHREAD compiles this core's web fast paths out so the
//cothread scheduler runs instead, which is what wasm/pce-sweep.mjs compares the web build against.
//placed after <ares/ares.hpp> so nall and the scheduler keep their web builds. nothing outside
//ares/pce/ includes this header, so the #undef cannot reach another core.
#if defined(PLATFORM_WEB) && defined(ARES_PCE_COTHREAD)
  #undef PLATFORM_WEB
#endif

#include <component/processor/huc6280/huc6280.hpp>
#include <component/audio/msm5205/msm5205.hpp>

namespace ares::PCEngine {
  #include <ares/inline.hpp>
  auto enumerate() -> std::vector<string>;
  auto load(Node::System& node, string name) -> bool;
  auto option(string name, string value) -> bool;

  struct Model {
    inline static auto PCEngine() -> bool;
    inline static auto PCEngineDuo() -> bool;
    inline static auto LaserActive() -> bool;
    inline static auto SuperGrafx() -> bool;
  };

  struct Region {
    inline static auto NTSCJ() -> bool;
    inline static auto NTSCU() -> bool;
  };

  #include <pce/controller/controller.hpp>

  #include <pce/cpu/cpu.hpp>
  #include <pce/vdp/vdp.hpp>
  #include <pce/vdp-performance/vdp.hpp>
  #include <pce/psg/psg.hpp>
  #include <pce/pcd/pcd.hpp>

  #include <pce/system/system.hpp>
  #include <pce/cartridge/cartridge.hpp>
}
