auto CPU::serialize(serializer& s) -> void {
  M68000::serialize(s);
  Thread::serialize(s);
  s(ram);
  s(io.version);
  s(io.romEnable);
  s(io.vdpEnable);
  s(refresh.ram);
  s(refresh.ramEnd);
  s(refresh.external);
  s(refresh.externalEnd);
  s(state.interruptPending);
  s(state.stolenMcycles);

  #if defined(PLATFORM_WEB)
  //the interrupt-sampling catch-up in main() targets the clock of the most recent wait, so a state
  //taken between waits must carry the delta. gating on the same condition Thread::serialize() uses
  //for the cothread stack keeps the synchronized layout byte-identical to native: there power(false)
  //zeroes it instead, which over-advances the vdp by one instruction's trailing cycles exactly once
  //per load, before the next wait() re-establishes the invariant.
  if(!scheduler.getSynchronize()) s(sinceWaitClock);
  #endif
}
