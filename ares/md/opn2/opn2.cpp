#include <md/md.hpp>

namespace ares::MegaDrive {

OPN2 opn2;
#include "serialization.cpp"

auto OPN2::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("YM2612");

  stream = node->append<Node::Audio::Stream>("YM2612");
  stream->setChannels(2);
  stream->setFrequency(system.frequency() / 7.0 / 144.0);
  stream->addHighPassFilter(  20.0, 1);
  stream->addLowPassFilter (2840.0, 1);
}

auto OPN2::unload() -> void {
  node->remove(stream);
  stream.reset();
  node.reset();
}

auto OPN2::main() -> void {
  #if defined(PLATFORM_WEB)
  //this cothread is only ever entered by the scheduler's synchronization protocol, and natively
  //that resumes step()'s wait on the 68000 -- Thread::synchronize() stands down while the scheduler
  //is walking auxiliary threads -- and runs only the trailing sample(), advancing the clock no
  //further. so retire the held sample and nothing more; CPU::main() has usually done it already.
  if(scheduler.synchronizing()) return finishSample();

  //see pending, in opn2.hpp: the sample belonging to the window just stepped over is computed on
  //the following call, which is where the cothread build computes it -- after step() returns from
  //waiting on the 68000.
  if(pending) sample();
  step(144);
  pending = 1;
  #else
  step(144);
  sample();
  #endif
}

#if defined(PLATFORM_WEB)
//compute the held sample, which is what the native main() has already done when it returns and so
//where a synchronized save state has to find this chip. called from CPU::main() -- the cothread the
//ym2612 is actually advanced on -- because its own cothread cannot be relied upon to reach that
//point: Thread::Enter answers the scheduler's first synchronization before running the entry point,
//so after every power, reset, or state load the first synchronized save finds a cothread that has
//never executed anything.
auto OPN2::finishSample() -> void {
  if(!pending) return;
  pending = 0;
  sample();
}
#endif

auto OPN2::sample() -> void {
  auto samples = YM2612::clock();
  stream->frame(samples[0] / 32768.0, samples[1] / 32768.0);
}

auto OPN2::step(u32 clocks) -> void {
  Thread::step(clocks);
  Thread::synchronize(cpu);
}

auto OPN2::power(bool reset) -> void {
  YM2612::power();
  Thread::create(system.frequency() / 7.0, std::bind_front(&OPN2::main, this));
  #if defined(PLATFORM_WEB)
  pending = 0;
  #endif
}

auto OPN2::restart() -> void {
  YM2612::power();
  Thread::restart(std::bind_front(&OPN2::main, this));
  #if defined(PLATFORM_WEB)
  //Thread::restart re-derives the cothread stack, discarding the held sample along with it
  pending = 0;
  #endif
}

}
