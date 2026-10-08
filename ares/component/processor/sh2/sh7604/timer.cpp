auto SH2::FRT::run(int cycles) -> void {
#if defined(PROBE_B_SHIFT)
  //probe B: the four FRT prescale divisors are all powers of two, so the runtime integer divide
  //is a shift. unsigned operands, so the values are identical -- this is not an approximation.
  static constexpr u32 shifts[4] = {3, 5, 7, 0};
  auto shift = shifts[tcr.cks];

  counter += cycles;
  u32 increments = (u32)counter >> shift;
  counter -= increments << shift;
#else
  static constexpr u32 frequencies[4] = {8, 32, 128, 1};
  auto frequency = frequencies[tcr.cks];

  counter += cycles;
  auto increments = counter / frequency;
  counter -= increments * frequency;
#endif

  if (!increments) return;

  auto prevFrc = frc;
  frc += increments;

  ftcsr.ovf  |= (frc < prevFrc);
  ftcsr.ocfa |= (u32(ocra - 1 - prevFrc) < increments);
  ftcsr.ocfb |= (u32(ocrb - 1 - prevFrc) < increments);

  pendingOutputIRQ |= (tier.ovie & ftcsr.ovf) |
                      (tier.ociae & ftcsr.ocfa) |
                      (tier.ocibe & ftcsr.ocfb);

  if (ftcsr.cclra && ftcsr.ocfa) frc = 0;
}

auto SH2::WDT::run(int cycles) -> void {
  if(!wtcsr.tme || wtcsr.wtit) return; //watchdog mode (wtit) currently unsupported

#if defined(PROBE_B_SHIFT)
  static constexpr u32 shifts[8] = {1, 6, 7, 8, 9, 10, 12, 13};
  auto shift = shifts[wtcsr.cks];

  counter += cycles;
  u32 increments = (u32)counter >> shift;
  counter -= increments << shift;
#else
  static constexpr u32 frequencies[8] = {2, 64, 128, 256, 512, 1024, 4096, 8192};

  auto frequency = frequencies[wtcsr.cks];

  counter += cycles;
  auto increments = counter / frequency;
  counter %= frequency;
#endif

  if(!increments) return;

  auto prevWtcnt = wtcnt;
  wtcnt += increments;

  if (wtcnt < prevWtcnt) {
    wtcsr.ovf = 1;
    pendingIRQ = 1;
  }
}
