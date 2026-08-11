auto Display::serialize(serializer& s) -> void {
  Thread::serialize(s);

  s(io.vblank);
  s(io.hblank);
  s(io.vcoincidence);
  s(io.irqvblank);
  s(io.irqhblank);
  s(io.irqvcoincidence);
  s(io.vcompare);
  s(io.vcounter);

  s(videoCapture);

  #if defined(PLATFORM_WEB)
  //which chunk of the scanline is next, which natively is a suspended cothread's program counter.
  //gated exactly as Thread::serialize() gates that stack, so the persistable layout is unchanged.
  if(!scheduler.getSynchronize()) s(unit.phase);
  #endif
}
