#include <sfc/sfc.hpp>

namespace ares::SuperFamicom {

DSP dsp;
#include "memory.cpp"
#include "gaussian.cpp"
#include "counter.cpp"
#include "envelope.cpp"
#include "brr.cpp"
#include "misc.cpp"
#include "voice.cpp"
#include "echo.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto DSP::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("DSP");

  stream = node->append<Node::Audio::Stream>("DSP");
  stream->setChannels(2);
  stream->setFrequency(system.apuFrequency() / 768.0);

  debugger.load(node);
}

auto DSP::unload() -> void {
  debugger = {};
  node->remove(stream);
  stream.reset();
  node.reset();
}

auto DSP::main() -> void {
  #if defined(PLATFORM_WEB)
  //the web build steps the dsp through runCycle() so that the smp can run it as plain function
  //calls (see SMP::catchUpDSP); routing the cothread through the same stepper keeps the phase
  //counter consistent however the dsp is advanced. run a whole sample cycle so the scheduler's
  //safe point between main() invocations is still a phase boundary, as it is natively.
  do runCycle(); while(phase);
  #else
  voice5(voice[0]);
  voice2(voice[1]);
  tick();

  voice6(voice[0]);
  voice3(voice[1]);
  tick();

  voice7(voice[0]);
  voice4(voice[1]);
  voice1(voice[3]);
  tick();

  voice8(voice[0]);
  voice5(voice[1]);
  voice2(voice[2]);
  tick();

  voice9(voice[0]);
  voice6(voice[1]);
  voice3(voice[2]);
  tick();

  voice7(voice[1]);
  voice4(voice[2]);
  voice1(voice[4]);
  tick();

  voice8(voice[1]);
  voice5(voice[2]);
  voice2(voice[3]);
  tick();

  voice9(voice[1]);
  voice6(voice[2]);
  voice3(voice[3]);
  tick();

  voice7(voice[2]);
  voice4(voice[3]);
  voice1(voice[5]);
  tick();

  voice8(voice[2]);
  voice5(voice[3]);
  voice2(voice[4]);
  tick();

  voice9(voice[2]);
  voice6(voice[3]);
  voice3(voice[4]);
  tick();

  voice7(voice[3]);
  voice4(voice[4]);
  voice1(voice[6]);
  tick();

  voice8(voice[3]);
  voice5(voice[4]);
  voice2(voice[5]);
  tick();

  voice9(voice[3]);
  voice6(voice[4]);
  voice3(voice[5]);
  tick();

  voice7(voice[4]);
  voice4(voice[5]);
  voice1(voice[7]);
  tick();

  voice8(voice[4]);
  voice5(voice[5]);
  voice2(voice[6]);
  tick();

  voice9(voice[4]);
  voice6(voice[5]);
  voice3(voice[6]);
  tick();

  voice1(voice[0]);
  voice7(voice[5]);
  voice4(voice[6]);
  tick();

  voice8(voice[5]);
  voice5(voice[6]);
  voice2(voice[7]);
  tick();

  voice9(voice[5]);
  voice6(voice[6]);
  voice3(voice[7]);
  tick();

  voice1(voice[1]);
  voice7(voice[6]);
  voice4(voice[7]);
  tick();

  voice8(voice[6]);
  voice5(voice[7]);
  voice2(voice[0]);
  tick();

  voice3a(voice[0]);
  voice9(voice[6]);
  voice6(voice[7]);
  echo22();
  tick();

  voice7(voice[7]);
  echo23();
  tick();

  voice8(voice[7]);
  echo24();
  tick();

  voice3b(voice[0]);
  voice9(voice[7]);
  echo25();
  tick();

  echo26();
  tick();

  misc27();
  echo27();
  tick();

  misc28();
  echo28();
  tick();

  misc29();
  echo29();
  tick();

  misc30();
  voice3c(voice[0]);
  echo30();
  tick();

  voice4(voice[0]);
  voice1(voice[2]);
  tick();
  #endif
}

#if defined(PLATFORM_WEB)
//one 24-clock tick of the 32-phase sample cycle: the flat twin of main() above, dispatching on
//the transient phase counter instead of holding the position in the cothread's program counter.
//the phase blocks must mirror main() exactly.
auto DSP::runCycle() -> void {
  switch(phase) {
  case  0: voice5(voice[0]); voice2(voice[1]); break;
  case  1: voice6(voice[0]); voice3(voice[1]); break;
  case  2: voice7(voice[0]); voice4(voice[1]); voice1(voice[3]); break;
  case  3: voice8(voice[0]); voice5(voice[1]); voice2(voice[2]); break;
  case  4: voice9(voice[0]); voice6(voice[1]); voice3(voice[2]); break;
  case  5: voice7(voice[1]); voice4(voice[2]); voice1(voice[4]); break;
  case  6: voice8(voice[1]); voice5(voice[2]); voice2(voice[3]); break;
  case  7: voice9(voice[1]); voice6(voice[2]); voice3(voice[3]); break;
  case  8: voice7(voice[2]); voice4(voice[3]); voice1(voice[5]); break;
  case  9: voice8(voice[2]); voice5(voice[3]); voice2(voice[4]); break;
  case 10: voice9(voice[2]); voice6(voice[3]); voice3(voice[4]); break;
  case 11: voice7(voice[3]); voice4(voice[4]); voice1(voice[6]); break;
  case 12: voice8(voice[3]); voice5(voice[4]); voice2(voice[5]); break;
  case 13: voice9(voice[3]); voice6(voice[4]); voice3(voice[5]); break;
  case 14: voice7(voice[4]); voice4(voice[5]); voice1(voice[7]); break;
  case 15: voice8(voice[4]); voice5(voice[5]); voice2(voice[6]); break;
  case 16: voice9(voice[4]); voice6(voice[5]); voice3(voice[6]); break;
  case 17: voice1(voice[0]); voice7(voice[5]); voice4(voice[6]); break;
  case 18: voice8(voice[5]); voice5(voice[6]); voice2(voice[7]); break;
  case 19: voice9(voice[5]); voice6(voice[6]); voice3(voice[7]); break;
  case 20: voice1(voice[1]); voice7(voice[6]); voice4(voice[7]); break;
  case 21: voice8(voice[6]); voice5(voice[7]); voice2(voice[0]); break;
  case 22: voice3a(voice[0]); voice9(voice[6]); voice6(voice[7]); echo22(); break;
  case 23: voice7(voice[7]); echo23(); break;
  case 24: voice8(voice[7]); echo24(); break;
  case 25: voice3b(voice[0]); voice9(voice[7]); echo25(); break;
  case 26: echo26(); break;
  case 27: misc27(); echo27(); break;
  case 28: misc28(); echo28(); break;
  case 29: misc29(); echo29(); break;
  case 30: misc30(); voice3c(voice[0]); echo30(); break;
  case 31: voice4(voice[0]); voice1(voice[2]); break;
  }
  //advance before tick(): on the dsp's own cothread tick() switches to the smp, whose catchUpDSP()
  //re-enters runCycle() while this frame is parked. no state lives across the switch, so the
  //re-entrant calls are safe -- but only because phase already names the next tick. incrementing
  //after tick() would repeat this phase and double-increment when the parked frame unwinds.
  phase++;  //n5 wraps the 32-phase cycle
  tick();
}
#endif

auto DSP::tick() -> void {
  Thread::step(3 * 8);
  Thread::synchronize(smp);
}

auto DSP::sample(i16 left, i16 right) -> void {
  stream->frame(left / 32768.0, right / 32768.0);
}

auto DSP::power(bool reset) -> void {
  Thread::create(system.apuFrequency(), std::bind_front(&DSP::main, this));

  if(!reset) {
    random.array({(u8*)apuram, sizeof(apuram)});
    random.array({(u8*)registers, sizeof(registers)});
  }

  #if defined(PLATFORM_WEB)
  phase = 0;
  #endif
  mainvol = {};
  echo = {};
  noise = {};
  brr = {};
  latch = {};
  for(u32 n : range(8)) {
    voice[n] = {};
    voice[n].index = n << 4;
  }

  gaussianConstructTable();
}

}
