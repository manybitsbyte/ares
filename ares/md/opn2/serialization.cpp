auto OPN2::serialize(serializer& s) -> void {
  YM2612::serialize(s);
  Thread::serialize(s);

  #if defined(PLATFORM_WEB)
  //gated exactly as Thread::serialize() gates the cothread stack, and sound only because CPU::main()
  //runs finishSample() before the scheduler's safe point: the sample main() always leaves held is
  //computed on every synchronized state, and only a run-ahead state -- which System::unserialize
  //restores without a power(false) -- can carry one. see pending in opn2.hpp.
  if(!scheduler.getSynchronize()) s(pending);
  #endif
}
