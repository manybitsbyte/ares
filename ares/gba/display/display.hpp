struct Display : Thread, IO {
  Node::Object node;

  auto load(Node::Object) -> void;
  auto unload() -> void;

  auto step(u32 clocks) -> void;
  auto main() -> void;

  #if defined(PLATFORM_WEB)
  //the cpu advances the display by plain function calls. main() suspends inside each of its seven
  //step() calls, so unit.phase says which of them is next; the chunk sizes are kept, rather than
  //stepping one clock at a time, because the cothread build overshoots the cpu by a whole chunk and
  //its side effects land at that overshot position.
  auto webAdvance(const Thread& caller) -> bool override;
  auto runChunk() -> void;
  auto finishUnit() -> void;

  struct Unit {
    u32 phase;  //0-7: which run of statements between main()'s step() calls comes next
  } unit;
  #endif

  auto power() -> void;

  //io.cpp
  auto readIO(n32 address) -> n8;
  auto writeIO(n32 address, n8 byte) -> void;

  //serialization.cpp
  auto serialize(serializer&) -> void;

  struct IO {
    n1  vblank;
    n1  hblank;
    n1  vcoincidence;
    n1  irqvblank;
    n1  irqhblank;
    n1  irqvcoincidence;
    n8  vcompare;

    n16 vcounter;
  } io;
  
  n1 videoCapture = 0;
};

extern Display display;
