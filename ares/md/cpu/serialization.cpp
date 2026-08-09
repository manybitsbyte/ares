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
  //for the cothread stack keeps the synchronized layout byte-identical to native, where power(false)
  //zeroes it instead. that is safe rather than merely bounded now that CPU::main() ends a
  //synchronized safe point with vdp.finishScanline(): the vdp stands at a line boundary, ahead of
  //the 68000, so the catch-up on the next main() finds nothing to advance whatever this reads back
  //as. measured with a printf in this function, it is 0 at every safe point of the smoke workload.
  if(!scheduler.getSynchronize()) s(sinceWaitClock);
  #endif
}
