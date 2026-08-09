auto OPN2::serialize(serializer& s) -> void {
  YM2612::serialize(s);
  Thread::serialize(s);

  #if defined(PLATFORM_WEB)
  //main() always leaves a sample held, so a run-ahead state -- which System::unserialize restores
  //without a power(false) -- must carry it. gated exactly as Thread::serialize() gates the cothread
  //stack, so the synchronized layout stays byte-identical to native; see pending in opn2.hpp.
  if(!scheduler.getSynchronize()) s(pending);
  #endif
}
