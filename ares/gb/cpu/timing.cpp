//70224 clocks/frame
//  456 clocks/scanline
//  154 scanlines/frame

auto CPU::step() -> void {
  step(1);
}

#if defined(PLATFORM_WEB)
//the ppu is advanced by plain calls to runCycle(), its clock-at-a-time twin of main(), rather than
//by entering its cothread -- under asyncify a cothread switch is the single largest cost in the
//profile, and gb switches once per master clock. PPU::step() notices it is not on its own cothread
//and skips the switch back to the cpu.
auto CPU::catchUpPPU() -> void {
  if(scheduler.synchronizing()) return;  //mirror Thread::synchronize(), which stands down here
  while(ppu.Thread::clock() < Thread::clock()) ppu.runCycle();
}

//the apu holds no state in its cothread's program counter: each APU::main() performs exactly one
//apu clock and returns to the entry loop. that makes entering its cothread pure overhead, so it is
//caught up with plain calls to the same function.
auto CPU::catchUpAPU() -> void {
  if(scheduler.synchronizing()) return;
  while(apu.Thread::clock() < Thread::clock()) apu.main();
}
#endif

auto CPU::step(u32 clocks) -> void {
  //determine which bit of DIV is used to check timer state
  n32 timerBit = 9;
  if(status.timerClock != 0) timerBit = status.timerClock * 2 + 1;

  for(auto n : range(clocks)) {
    if(!r.stop) status.div++;

    //tick timer on falling edge
    n1 timerLineNew = status.div.bit(timerBit) & status.timerEnable;
    if(timerLineNew == 0 && status.timerLine == 1) timerTick();

    if((n9 )status.div == 0) timer8192hz();  //serial
    if((n12)status.div == 0) timer1024hz();  //joypad

    status.timerLine = timerLineNew;

    Thread::step(1);
    #if defined(PLATFORM_WEB)
    catchUpPPU();
    catchUpAPU();
    Thread::synchronizeExcept(ppu, apu);  //the cartridge is still a real cothread
    #else
    Thread::synchronize();
    #endif
  }

  if(Model::SuperGameBoy()) {
    system.information.clocksExecuted += clocks;
  }
}

auto CPU::timerTick() -> void {
  if(++status.tima == 0) {
    status.tima = status.tma;
    raise(Interrupt::Timer);
  }
}

auto CPU::timer8192hz() -> void {
  if(status.serialTransfer && status.serialClock) {
    status.serialData <<= 1;
    status.serialData |= 1;
    if(--status.serialBits == 0) {
      status.serialTransfer = 0;
      raise(Interrupt::Serial);
    }
  }
}

auto CPU::timer1024hz() -> void {
  joypPoll();
}

auto CPU::hblankIn() -> void {
  hdmaTrigger(1, status.hdmaActive);
  status.hblank = 1;
}

auto CPU::hblankOut() -> void {
  status.hblank = 0;
}

auto CPU::hdmaTrigger(n1 hblank, n1 active) -> void {
  //HDMA is triggered on rising edge of combined signal
  n1 previousState = status.hdmaActive && status.hblank;
  n1 newState = active && hblank;
  status.hdmaPending = previousState == 0 && newState == 1;
}

auto CPU::performHdma() -> void {
  step(4);
  for(u32 loop : range(16)) {
    writeDMA(status.dmaTarget++, readDMA(status.dmaSource++, 0xff));
    step(2 << status.speedDouble);
  }
  if(status.dmaLength-- == 0) {
    status.hdmaActive = 0;
  }
}
