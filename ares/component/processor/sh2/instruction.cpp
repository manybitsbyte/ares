auto SH2::jump(u32 pc) -> void {
  PC  = pc;
  PPM = Branch::Step;
}

auto SH2::branch(u32 pc) -> void {
  PPC = pc;
  PPM = Branch::Take;
}

auto SH2::delaySlot(u32 pc) -> void {
  PPC = pc;
  PPM = Branch::Slot;
}

auto SH2::instruction() -> void {
  #if defined(SLJIT)
  if(Accuracy::Interpreter || !recompiler.enabled) {
  #endif
    #if defined(PLATFORM_WEB)
    //Every step() can reach Thread::synchronize, and on web a synchronize is an Asyncify unwind and
    //rewind rather than a register save. The recompiler already answered this shape for compiled
    //blocks, which cannot sync mid-flight either: bank cycles in CCR, run a batch, pay the whole
    //batch with one step(). The interpreter can keep the same ledger. Callers force an early exit
    //through cyclesUntilRecompilerExit exactly as they do for the recompiler.
    do {
      CCR += 1;
      exceptionHandler();
      if constexpr(Accuracy::AddressErrors) {
        if(unlikely(PC & 1)) { step(CCR); CCR = 0; return addressErrorCPU(); }
        if(unlikely(PC >> 29 == Area::IO)) { step(CCR); CCR = 0; return addressErrorCPU(); }
      }
      ID = 0;
      //Instruction fetch walks the whole read path -- address error test, area switch, cache enable
      //test, tag walk -- to reach a line the previous fetch almost always just read from: fetch is
      //sequential and a line holds eight words. Hold that line and skip straight to it. lruUpdate is
      //applied for the held way exactly as the tag walk would have applied it, so lrus, and every
      //eviction that follows from it, are unchanged. Every point that can move a line clears
      //fetchTag; see SH2::Cache::fetchRecord.
      u32 fetchAddress = PC - 4;
      u16 opcode;
      if(likely((fetchAddress & ~15) == cache.fetchTag)) {
        auto entry = fetchAddress >> 4 & 63;
        cache.lrus[entry] = cache.lruUpdate[cache.fetchIndex >> 6][cache.lrus[entry]];
        opcode = bswap16(cache.lines[cache.fetchIndex].words[fetchAddress >> 1 & 7]);
      } else {
        opcode = readWord(fetchAddress);
        cache.fetchRecord(fetchAddress);
      }
      //instructionPrologue is the debugger's per-instruction tracer hook. The web build exposes no
      //node tree to enable it with, so the call is 751k chased pointer derefs per frame that can
      //never fire -- 13.27% of a profiled frame. The native arm below keeps it.
      execute(opcode);
      instructionEpilogue();
    } while(CCR < cyclesUntilRecompilerExit);
    cyclesUntilRecompilerExit = recompilerStepCycles;
    step(CCR);
    CCR = 0;
    #else
    step(1);
    exceptionHandler();
    if constexpr(Accuracy::AddressErrors) {
      if(unlikely(PC & 1)) return addressErrorCPU();
      if(unlikely(PC >> 29 == Area::IO)) return addressErrorCPU();
    }
    ID = 0;
    u16 opcode = readWord(PC - 4);
    instructionPrologue(opcode);
    execute(opcode);
    instructionEpilogue();
    #endif
  #if defined(SLJIT)
  } else {
    exceptionHandler();

    // Recompiled blocks may be very small, negating the impact
    // minimum cycle counts ensure that the recompiler is a net positive
    do {
      auto block = recompiler.block(PC - 4);
      block->execute(*this);
      ID = 0;
    } while (CCR < cyclesUntilRecompilerExit);

    // Reset the count as it may have been set to 0 for an early exit
    cyclesUntilRecompilerExit = recompilerStepCycles;

    step(CCR);
    CCR = 0;
  }
  #endif
}

auto SH2::instructionEpilogue() -> s32 {
  switch(PPM) {
  case Branch::Step: PC = PC + 2; return 0;
  case Branch::Slot: PC = PC + 2; PPM = Branch::Take; return 0;
  case Branch::Take: PC = PPC;    PPM = Branch::Step; return 1;
  }
  unreachable;
}

auto SH2::execute(u16 opcode) -> void {
  #define op(id, name, ...) case id: return name(__VA_ARGS__)
  #define br(id, name, ...) case id: return name(__VA_ARGS__)
  #include "decoder.hpp"
  #undef op
  #undef br
}
