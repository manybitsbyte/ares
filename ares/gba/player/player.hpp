struct Player : Thread {
  auto main() -> void;
  auto step(u32 clocks) -> void;

  #if defined(PLATFORM_WEB)
  //one main() is one whole unit and it suspends at the end of it, so unlike the ppu, apu and
  //display there is no mid-unit position to carry and nothing to retire at a safe point
  auto webAdvance(const Thread& caller) -> bool override;
  #endif

  auto power() -> void;
  auto frame() -> void;

  auto keyinput() -> maybe<n16>;
  auto read() -> maybe<n32>;
  auto write(n2 address, n8 byte) -> void;

  auto serialize(serializer& s) -> void;

private:
  struct Status {
    n1  enable;
    n1  rumble;

    n1  logoDetected;
    n32 logoCounter;

    n32 packet;
    n32 send;
    n32 recv;

    n32 timeout;
  } status;
};

extern Player player;
