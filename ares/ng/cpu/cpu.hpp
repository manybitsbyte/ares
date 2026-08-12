//Motorola 68000

struct CPU : M68000, Thread {
  Node::Object node;

  struct Debugger {
    //debugger.cpp
    auto load(Node::Object) -> void;
    auto instruction() -> void;
    auto interrupt(string_view) -> void;

    struct Tracer {
      Node::Debugger::Tracer::Instruction instruction;
      Node::Debugger::Tracer::Notification interrupt;
    } tracer;
  } debugger;

  enum class Interrupt : u32 {
    Power,
    Reset,
    Vblank,
    Timer,
  };

  //cpu.cpp
  auto load(Node::Object) -> void;
  auto unload() -> void;

  auto main() -> void;
  auto idle(u32 clocks) -> void override;
  auto wait(u32 clocks) -> void override;

  auto raise(Interrupt) -> void;
  #if defined(PLATFORM_WEB)
  //cpu.cpp -- the web build advances the apu, the lspc and the opnb by plain function calls on
  //this cothread instead of by cothread switches, which under Asyncify are each a full unwind and
  //rewind of the suspended stack. the recipe and its evidence are in wasm/README.md.
  //catchUpAPU runs whole z80 instructions; catchUpOPNB runs the ym2610 to the z80's clock and is
  //also called from the apu's port handlers so an access lands on a chip standing where the
  //cothread build's per-step synchronization would have put it; catchUpLSPC advances the lspc a
  //clock at a time through runCycle().
  auto catchUpAPU() -> void;
  auto catchUpOPNB() -> void;
  auto catchUpLSPC() -> void;
  #endif
  auto lower(Interrupt) -> bool;

  auto power(bool reset) -> void;

  //memory.cpp
  auto read(n1 upper, n1 lower, n24 address, n16 data = 0) -> n16 override;
  auto write(n1 upper, n1 lower, n24 address, n16 data) -> void override;

  auto readIO(n1 upper, n1 lower, n24 address, n16 data) -> n16;
  auto writeIO(n1 upper, n1 lower, n24 address, n16 data) -> void;

  //serialization.cpp
  auto serialize(serializer&) -> void;

  struct IO {
    n32 interruptPending;
    n1  vectorSelect;  //0 = BIOS; 1 = cartridge
    n1  fixSelect;     //0 = embedded SFIX + SM1 ROM; 1 = cartridge SROM + M1 ROM
  } io;
};

extern CPU cpu;
