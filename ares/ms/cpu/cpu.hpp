struct CPU : Z80, Z80::Bus, Thread {
  Node::Object node;
  Memory::Writable<n8> ram;  //8KB

  struct Debugger {
    //debugger.cpp
    auto load(Node::Object) -> void;
    auto instruction() -> void;
    auto interrupt(string_view) -> void;
    auto in(n16 address, n8 data) -> void;
    auto out(n16 address, n8 data) -> void;

    struct Memory {
      Node::Debugger::Memory ram;
    } memory;

    struct Tracer {
      Node::Debugger::Tracer::Instruction instruction;
      Node::Debugger::Tracer::Notification interrupt;
      Node::Debugger::Tracer::Notification io;
    } tracer;
  } debugger;

  auto synchronizing() const -> bool override { return scheduler.synchronizing(); }

  //cpu.cpp
  auto load(Node::Object) -> void;
  auto unload() -> void;

  auto main() -> void;
  auto step(u32 clocks) -> void override;

  #if defined(PLATFORM_WEB)
  //Emscripten implements each cothread switch through Asyncify. Advance the VDP and sound chips
  //directly on the CPU cothread and allow the web frontend to batch their catch-ups by a bounded
  //number of CPU clocks. Device I/O and interrupt recognition remain exact; one is the default.
  static u32 syncGranularity;
  u32 syncCounter = 0;

  auto catchUpVDP() -> void;
  auto catchUpAudio() -> void;
  auto synchronizeWeb() -> void;
  #endif

  auto setNMI(bool value) -> void;
  auto setIRQ(bool value) -> void;

  auto power() -> void;

  //memory.cpp
  auto mdr() const -> n8;
  auto read(n16 address) -> n8 override;
  auto write(n16 address, n8 data) -> void override;

  auto in(n16 address) -> n8 override;
  auto out(n16 address, n8 data) -> void override;

  //serialization.cpp
  auto serialize(serializer&) -> void;

private:
  struct State {
    n1 nmiLine;
    n1 irqLine;
  } state;

  struct Bus {
    n1 ioEnable = 1;
    n1 biosEnable = 1;
    n1 ramEnable = 1;
    n1 cardEnable = 1;
    n1 cartridgeEnable = 1;
    n1 expansionEnable = 1;

    n8 mdr;
    n8 pullup;
    n8 pulldown;
  } bus;

  //Game Gear only
  struct SIO {
    n8 parallelData = 0x7f;
    n7 dataDirection = 0x7f;
    n1 nmiEnable = 1;
    n8 transmitData = 0x00;
    n8 receiveData = 0xff;
    n1 transmitFull = 0;
    n1 receiveFull = 0;
    n1 framingError = 0;
    n3 unknown = 0;
    n2 baudRate = 0;  //0 = 4800, 1 = 2400, 2 = 1200, 3 = 300
  } sio;
};

extern CPU cpu;
