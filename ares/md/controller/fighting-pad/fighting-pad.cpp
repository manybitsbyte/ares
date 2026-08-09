FightingPad::FightingPad(Node::Port parent) {
  node = parent->append<Node::Peripheral>("Fighting Pad");

  up    = node->append<Node::Input::Button>("Up");
  down  = node->append<Node::Input::Button>("Down");
  left  = node->append<Node::Input::Button>("Left");
  right = node->append<Node::Input::Button>("Right");
  a     = node->append<Node::Input::Button>("A");
  b     = node->append<Node::Input::Button>("B");
  c     = node->append<Node::Input::Button>("C");
  x     = node->append<Node::Input::Button>("X");
  y     = node->append<Node::Input::Button>("Y");
  z     = node->append<Node::Input::Button>("Z");
  mode  = node->append<Node::Input::Button>("Mode");
  start = node->append<Node::Input::Button>("Start");

  Thread::create(1'000'000, std::bind_front(&FightingPad::main, this));
}

FightingPad::~FightingPad() {
  Thread::destroy();
}

#if defined(PLATFORM_WEB)
//main() advances exactly one timer cycle per call, so it can run as a plain function call on
//the caller's cothread; Thread::synchronize() stands down when this is not the pad's cothread.
//the predicate re-reads both clocks rather than taking a target on entry: every other catch-up
//in the tree does the same, because Scheduler::exit rebases every thread's clock and a
//snapshot taken before it goes stale-high afterwards.
auto FightingPad::catchUp() -> void {
  while(Thread::clock() < cpu.Thread::clock()) main();
}
#endif

auto FightingPad::main() -> void {
  #if defined(PLATFORM_WEB)
  //catchUp() owns advancing this pad and runs a whole timer cycle per call, so it is already on a
  //cycle boundary when the scheduler walks this cothread -- the only thing that still enters it.
  //natively the walk resumes step() and returns without advancing; running a cycle here would put
  //the pad one ahead, by an amount that depends on how often this cothread had been entered.
  if(scheduler.synchronizing()) return;
  #endif

  if(timeout) {
    if(!--timeout) counter = 0;
  }
  Thread::step(1);
  Thread::synchronize(cpu);
}

auto FightingPad::poll() -> void {
  platform->input(up);
  platform->input(down);
  platform->input(left);
  platform->input(right);
  platform->input(a);
  platform->input(b);
  platform->input(c);
  platform->input(x);
  platform->input(y);
  platform->input(z);
  platform->input(mode);
  platform->input(start);

  if(!(up->value() & down->value())) {
    yHold = 0, upLatch = up->value(), downLatch = down->value();
  } else if(!yHold) {
    yHold = 1, swap(upLatch, downLatch);
  }

  if(!(left->value() & right->value())) {
    xHold = 0, leftLatch = left->value(), rightLatch = right->value();
  } else if(!xHold) {
    xHold = 1, swap(leftLatch, rightLatch);
  }
}

auto FightingPad::readData() -> Data {
  n6 data;

  if(select == 0) {
    if(counter == 0 || counter == 1 || counter == 4) {
      data.bit(0) = upLatch;
      data.bit(1) = downLatch;
      data.bit(2,3) = ~0;
    }

    if(counter == 2) {
      data.bit(0,3) = ~0;  //controller type detection
    }

    if(counter == 3) {
      data.bit(0,3) = 0;
    }

    data.bit(4) = a->value();
    data.bit(5) = start->value();
  } else {
    if(counter == 0 || counter == 1 || counter == 2 || counter == 4) {
      data.bit(0) = upLatch;
      data.bit(1) = downLatch;
      data.bit(2) = leftLatch;
      data.bit(3) = rightLatch;
    }

    if(counter == 3) {
      data.bit(0) = z->value();
      data.bit(1) = y->value();
      data.bit(2) = x->value();
      data.bit(3) = mode->value();
    }

    data.bit(4) = b->value();
    data.bit(5) = c->value();
  }

  data = ~data;
  return {data, 0x3f};
}

auto FightingPad::writeData(n8 data) -> void {
  if(!select && data.bit(6)) {  //0->1 transition
    if(counter < 4) ++counter;
    timeout = 1600;  //~1.6ms
  }

  select = data.bit(6);
}
