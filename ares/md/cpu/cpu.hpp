//Motorola 68000

struct CPU : M68000, Thread {
  Node::Object node;
  Memory::Readable<n16> tmss;
  Memory::Writable<n16> ram;

  // Bus locking is unavailable for the main cpu of MegaDrive models 1 & 2,
  // preventing the TAS instruction from working correctly in most cases.
  auto lockable() -> bool override { return false; }

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

  enum class Interrupt : u32 {
    Reset,
    External,
    HorizontalBlank,
    VerticalBlank,
  };

  //cpu.cpp
  auto load(Node::Object) -> void;
  auto unload() -> void;

  auto main() -> void;
  auto step(u32 clocks) -> void;
  auto idle(u32 clocks) -> void override;
  auto wait(u32 clocks) -> void override;

  #if defined(PLATFORM_WEB)
  u64 sinceWaitClock = 0;  //clock stepped since the end of the most recent wait; see main().
  //stored as a delta rather than an absolute clock: Scheduler::exit rebases every thread's
  //clock when the frame event fires mid-catch-up, which would leave an absolute value stale.

  //the catch-up functions advance the z80, ym2612, vdp, psg and controllers by plain function
  //calls on the current cothread instead of switching to their cothreads: under Asyncify a
  //cothread switch is the single largest cost of cycle-accurate scheduling. the flags identify
  //which chip is logically executing during such a catch-up (see busActive below) and guard
  //against re-entry through the bus hooks. they are not serialized because both are zero at a
  //Thread::Enter safe point, which is the only point System::serialize(true) can save at. a
  //frame-event exit is not such a point -- VDP::finishSlot calls frame() with vdp set, which is
  //why the catch-up in main() targets a rebase-invariant delta rather than an absolute clock.
  struct WebCatchUp {
    n1 apu;
    n1 vdp;
  } webCatchUp;

  auto catchUpAPU() -> void;
  auto catchUpOPN2() -> void;
  auto catchUpVDP() -> void;
  auto catchUpAuxiliary() -> void;
  #endif

  //the logical bus-master test: on the web build the z80 or vdp may be advanced by plain calls on
  //the cpu's cothread, so cothread identity alone would misattribute their accesses to the cpu.
  auto busActive() const -> bool {
    #if defined(PLATFORM_WEB)
    return Thread::active() && !webCatchUp.apu && !webCatchUp.vdp;
    #else
    return Thread::active();
    #endif
  }

  auto raise(Interrupt) -> void;
  auto lower(Interrupt) -> bool;

  auto power(bool reset) -> void;

  //bus.cpp
  auto read(n1 upper, n1 lower, n24 address, n16 _ = 0) -> n16 override;
  auto write(n1 upper, n1 lower, n24 address, n16 data) -> void override;

  //io.cpp
  auto readIO(n1 upper, n1 lower, n24 address, n16 data) -> n16;
  auto writeIO(n1 upper, n1 lower, n24 address, n16 data) -> void;

  //serialization.cpp
  auto serialize(serializer&) -> void;

  n1 tmssEnable;

  struct IO {
    b1 version;  //0 = Model 1; 1 = Model 2+
    b1 romEnable;
    b1 vdpEnable[2];
  } io;

  struct Refresh {
    int ram;
    int ramEnd;
    int external;
    int externalEnd;

    static constexpr int ramLowBound       = 113;
    static constexpr int ramHighBound      = 132;
    static constexpr int ramLength         = 3;
    static constexpr int externalLowBound  = 121;
    static constexpr int externalHighBound = 128;
    static constexpr int externalLength    = 2;

  } refresh;

  struct State {
    n32 interruptPending;
    int stolenMcycles = 0;
  } state;

  int cyclesUntilFullSync = 0;
  int minCyclesBetweenSyncs = 0;
};

extern CPU cpu;
