struct MegaMouse : Controller, Thread {
  Node::Input::Axis   x;
  Node::Input::Axis   y;
  Node::Input::Button left;
  Node::Input::Button right;
  Node::Input::Button middle;
  Node::Input::Button start;

  MegaMouse(Node::Port);
  ~MegaMouse();

  auto main() -> void;
  auto readData() -> Data override;
  auto writeData(n8 data) -> void override;

  #if defined(PLATFORM_WEB)
  //main() advances exactly one timer cycle per call, so it can run as a plain function call on
  //the caller's cothread; Thread::synchronize() stands down when this is not the mouse's cothread.
  auto catchUp(u64 clock) -> void override { while(Thread::clock() < clock) main(); }
  #endif

private:
  n1  th = 1;
  n1  tr = 1;
  n1  tl = 1;
  n8  index = 0;
  n4  status[10];
  s16 maxspeed = 255;
  n32 timeout = 0;

  n32 t_data;
  n32 t_handshake;
};
