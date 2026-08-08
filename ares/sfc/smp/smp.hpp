//Sony CXP1100Q-1

struct SMP : SPC700, Thread {
  Node::Object node;

  struct Debugger {
    //debugger.cpp
    auto load(Node::Object) -> void;
    auto instruction() -> void;

    struct Tracer {
      Node::Debugger::Tracer::Instruction instruction;
    } tracer;
  } debugger;

  auto synchronizing() const -> bool override { return scheduler.synchronizing(); }

  //smp.cpp
  auto load(Node::Object) -> void;
  auto unload() -> void;

  auto main() -> void;
  auto power(bool reset) -> void;

  //io.cpp
  auto portRead(n2 port) const -> n8;
  auto portWrite(n2 port, n8 data) -> void;

  //serialization.cpp
  auto serialize(serializer&) -> void;

  n8 iplrom[64];

  //The SMP advances two APU clocks per cycle and the DSP advances twenty-four per tick, which
  //places them in an exact 1:1 ratio: every SMP cycle forces the DSP to be caught up. A cothread
  //switch is free on native targets but ruinous under Emscripten, where each one is an Asyncify
  //unwind/rewind through the whole SPC700 interpreter, so the web build never enters the DSP
  //cothread at all: DSP::runCycle() performs one tick per plain function call on the SMP's own
  //cothread (see SMP::catchUpDSP), holding its 32-phase position in a transient counter instead of
  //the cothread's program counter.
  //The catch-up can additionally be batched, trading a bounded amount of APU RAM coherency for
  //fewer catch-up loops. DSP register accesses still synchronize exactly, so only direct APU RAM
  //sharing observes the lag, but that covers sample, echo, and streaming memory ordering.
  //The default stays cycle-exact; a frontend that prefers speed opts in explicitly.
  #if defined(PLATFORM_WEB)
  static u32 dspSyncGranularity;  //SMP cycles between DSP catch-ups; 1 is cycle-exact
  #endif

private:
  struct IO {
    //timing
    u32 clockCounter = 0;
    u32 dspCounter = 0;  //SMP cycles since the last DSP catch-up, under PLATFORM_WEB batching

    //external
    n8 apu0;
    n8 apu1;
    n8 apu2;
    n8 apu3;

    //$00f0
    n1 timersDisable;
    n1 ramWritable = true;
    n1 ramDisable;
    n1 timersEnable = true;
    n2 externalWaitStates;
    n2 internalWaitStates;

    //$00f1
    n1 iplromEnable = true;

    //$00f2
    n8 dspAddress;

    //$00f4-00f7
    n8 cpu0;
    n8 cpu1;
    n8 cpu2;
    n8 cpu3;

    //$00f8-00f9
    n8 aux4;
    n8 aux5;
  } io;

  //memory.cpp
  auto readRAM(n16 address) -> n8;
  auto writeRAM(n16 address, n8 data) -> void;

  auto idle() -> void override;
  auto read(n16 address) -> n8 override;
  auto write(n16 address, n8 data) -> void override;

  auto readDisassembler(n16 address) -> n8 override;

  //io.cpp
  auto readIO(n16 address) -> n8;
  auto writeIO(n16 address, n8 data) -> void;

  template<u32 Frequency>
  struct Timer {
    n8 stage0;
    n8 stage1;
    n8 stage2;
    n4 stage3;
    b1 line;
    b1 enable;
    n8 target;

    //timing.cpp
    auto step(u32 clocks) -> void;
    auto synchronizeStage1() -> void;

    //serialization.cpp
    auto serialize(serializer&) -> void;
  };

  Timer<128> timer0;
  Timer<128> timer1;
  Timer< 16> timer2;

  //timing.cpp
  auto wait(bool halve, maybe<n16> address = nothing) -> void;
  auto step(u32 clocks) -> void;
  auto stepTimers(u32 clocks) -> void;
  #if defined(PLATFORM_WEB)
  auto catchUpDSP() -> void;
  #endif
};

extern SMP smp;
