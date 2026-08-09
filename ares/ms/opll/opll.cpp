#include <ms/ms.hpp>

namespace ares::MasterSystem {

OPLL opll;
#include "serialization.cpp"

auto OPLL::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("OPLL");

  stream = node->append<Node::Audio::Stream>("YM2413");
  stream->setChannels(1);
  stream->setFrequency(system.colorburst() / 72.0);
  stream->addHighPassFilter(20.0, 1);
}

auto OPLL::unload() -> void {
  node->remove(stream);
  stream.reset();
  node.reset();
}

auto OPLL::main() -> void {
  #if defined(PLATFORM_WEB)
  //same shape as PSG::main(): CPU::catchUpAudio() advances this chip, runCycle() emits a whole
  //sample, so the safe point is wherever the counters already are.
  #else
  runCycle();
  Thread::synchronize(cpu);
  #endif
}

auto OPLL::runCycle() -> void {
  auto output = YM2413::clock();
  if(io.mute) output = 0.0;
  stream->frame(output);
  Thread::step(1);
}

auto OPLL::step(u32 clocks) -> void {
  Thread::step(clocks);
  Thread::synchronize(cpu);
}

auto OPLL::power() -> void {
  YM2413::power();
  Thread::create(system.colorburst() / 72.0, std::bind_front(&OPLL::main, this));
  io = {};
}

}
