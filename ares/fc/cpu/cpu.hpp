struct CPU : MOS6502, Thread {
  Node::Object node;
  Memory::Writable<n8> ram;

  struct Debugger {
    //debugger.cpp
    auto load(Node::Object) -> void;
    auto instruction() -> void;
    auto interrupt(string_view) -> void;

    struct Memory {
      Node::Debugger::Memory ram;
    } memory;

    struct Tracer {
      Node::Debugger::Tracer::Instruction instruction;
      Node::Debugger::Tracer::Notification interrupt;
    } tracer;
  } debugger;

  auto rate() const -> u32 { return system.cpuDivider(); }

  //The APU runs at the CPU clock, so every CPU cycle forces it to be caught up: about half of the
  //roughly 119,000 synchronization points in a frame. A cothread switch is a few nanoseconds
  //natively but ruinous under Emscripten, where each one is an Asyncify unwind and rewind, so the
  //web build never enters the APU or PPU cothreads at all: neither holds any state in its
  //cothread's program counter, and catchUpAPU()/catchUpPPU() run them as plain function calls on
  //the CPU's own cothread instead (the PPU through runCycle(), the dot-at-a-time twin of
  //renderScanline()).
  //Catching the APU up in batches instead trades a bounded amount of latency on the APU's two
  //pushes into the CPU -- the frame counter and DMC IRQ lines, and the DMC's DMA request -- for
  //throughput. APU register accesses still synchronize exactly, so the CPU never observes a stale
  //$4015 or writes into an APU that has not caught up.
  //The default stays cycle-exact; a frontend that prefers speed opts in explicitly.
  //The PPU is the other half of those switches. It is batched the same way, but its coupling back
  //into the CPU is narrow enough to hold exactly: the CPU catches it up on every $2000-$3fff access
  //and again in lastCycle(), where the NMI line is latched. Since a 6502 only recognizes an
  //interrupt at an instruction boundary, that second point makes NMI delivery cycle-exact regardless
  //of granularity. What is left is what a cartridge board sees of the PPU between those points --
  //the A12 line an MMC3-style scanline counter watches -- so this stays opt-in as well.
  #if defined(PLATFORM_WEB)
  static u32 apuSyncGranularity;  //CPU cycles between APU catch-ups; 1 is cycle-exact
  static u32 ppuSyncGranularity;  //CPU cycles between PPU catch-ups; 1 is cycle-exact
  u32 apuSyncCounter = 0;         //cycles since the last catch-up; a pure timing hint, not state
  u32 ppuSyncCounter = 0;

  //timing.cpp
  auto catchUpAPU() -> void;
  auto catchUpPPU() -> void;
  #endif

  //cpu.cpp
  auto load(Node::Object) -> void;
  auto unload() -> void;

  auto main() -> void;
  auto step(u32 clocks) -> void;

  auto power(bool reset) -> void;

  //memory.cpp
  auto readBus(n16 address) -> n8;
  auto writeBus(n16 address, n8 data) -> void;

  auto readIO(n16 address) -> n8;
  auto writeIO(n16 address, n8 data) -> void;

  auto readDebugger(n16 address) -> n8 override;

  auto serialize(serializer&) -> void;

  //timing.cpp
  auto read(n16 address) -> n8 override;
  auto write(n16 address, n8 data) -> void override;
  auto lastCycle() -> void override;
  auto cancelNmi() -> void override;
  auto delayIrq() -> void override;
  auto irqPending() -> bool override;
  auto nmi(n16& vector) -> void override;

  auto dmcDMAPending() -> void;
  auto dma(n16 address) -> void;

  auto nmiLine(bool) -> void;
  auto irqLine(bool) -> void;
  auto apuLine(bool) -> void;

  auto isWriting() -> bool {
    return io.rwLine == 0;
  }

//protected:
  struct IO {
    n1  interruptPending;
    n1  resetPending;
    n1  nmiPending;
    n1  nmiLine;
    n1  irqLine;
    n1  apuLine;
    n1  oddCycle;
    n1  dmcDMAPending;
    n1  dmcDummyRead;
    n1  oamDMAPending;
    n8  oamDMAPage;
    n8  openBus;
    n1  rwLine;
  } io;
};

extern CPU cpu;
