//Yamaha YM2612

struct OPN2 : YM2612, Thread {
  Node::Object node;
  Node::Audio::Stream stream;

  //opn2.cpp
  auto load(Node::Object) -> void;
  auto unload() -> void;

  auto main() -> void;
  auto sample() -> void;
  auto step(u32 clocks) -> void;

  auto power(bool reset) -> void;
  auto restart() -> void;

  //serialization.cpp
  auto serialize(serializer&) -> void;

  #if defined(PLATFORM_WEB)
  //main() runs as a plain call on the 68000's cothread and so cannot suspend inside step() where
  //the cothread build does: there Thread::synchronize(cpu) holds the chip between advancing its
  //clock and computing the sample, until the 68000 has caught up past it. this flag holds the
  //sample the same way, which also reproduces restart() re-deriving the cothread out from under a
  //held sample -- a z80 reset drops one ym2612 sample there, and now here.
  n1 pending;
  #endif
};

extern OPN2 opn2;
