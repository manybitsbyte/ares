inline auto Thread::EntryPoints() -> std::vector<EntryPoint>& {
  static std::vector<EntryPoint> entryPoints;
  return entryPoints;
}

inline auto Thread::Enter() -> void {
  for(u32 index : range(EntryPoints().size())) {
    if(co_active() == EntryPoints()[index].handle) {
      auto entryPoint = EntryPoints()[index].entryPoint;
      EntryPoints().erase(EntryPoints().begin() + index);
      while(true) {
        scheduler.synchronize();
        entryPoint();
      }
    }
  }
  struct ThreadNotFound{};
  throw ThreadNotFound{};
}

inline Thread::~Thread() {
  destroy();
}

inline auto Thread::active() const -> bool { return co_active() == _handle; }
inline auto Thread::handle() const -> cothread_t { return _handle; }
inline auto Thread::frequency() const -> u64 { return _frequency; }
inline auto Thread::scalar() const -> u64 { return _scalar; }
inline auto Thread::clock() const -> u64 { return _clock; }

inline auto Thread::setHandle(cothread_t handle) -> void {
  _handle = handle;
}

inline auto Thread::setFrequency(double frequency) -> void {
  _frequency = frequency + 0.5;
  _scalar = Second / _frequency;
}

inline auto Thread::setScalar(u64 scalar) -> void {
  _scalar = scalar;
}

inline auto Thread::setClock(u64 clock) -> void {
  _clock = clock;
}

inline auto Thread::create(double frequency, std::function<void ()> entryPoint) -> void {
  if(!_handle) {
    _handle = co_create(Thread::Size, &Thread::Enter);
  } else {
    co_derive(_handle, Thread::Size, &Thread::Enter);
  }
  EntryPoints().push_back({_handle, entryPoint});
  setFrequency(frequency);
  setClock(0);
  scheduler.append(*this);
}

//returns a thread to its entry point (eg for a reset), without resetting the clock value
inline auto Thread::restart(std::function<void()> entryPoint) -> void {
  co_derive(_handle, Thread::Size, &Thread::Enter);
  EntryPoints().push_back({_handle, entryPoint});
}

inline auto Thread::destroy() -> void {
  scheduler.remove(*this);
  if(_handle) co_delete(_handle);
  _handle = nullptr;
}

inline auto Thread::step(u32 clocks) -> void {
  _clock += _scalar * clocks;
}

//ensure all threads are caught up to the current thread before proceeding.
inline auto Thread::synchronize() -> void {
  //note: this will call Thread::synchronize(*this) at some point, but this is safe:
  //the comparison will always fail as the current thread can never be behind itself.
  for(auto thread : scheduler._threads) synchronize(*thread);
}

//as synchronize(), but leave the named threads behind; the caller catches them up itself later.
template<typename... P>
inline auto Thread::synchronizeExcept(P&... except) -> void {
  for(auto thread : scheduler._threads) {
    if((... || (thread == static_cast<Thread*>(&except)))) continue;  //base offsets differ per core
    synchronize(*thread);
  }
}

//ensure the specified thread(s) are caught up the current thread before proceeding.
template<typename... P>
inline auto Thread::synchronize(Thread& thread, P&&... p) -> void {
  #if defined(PLATFORM_WEB)
  //catching up costs a cothread switch, so this is only meaningful on the running thread's own
  //cothread; a chip advanced by plain function calls must not switch away, and returns instead.
  //audited whole-tree: of the 35 X.synchronize(Y) sites, the one where X is the caller runs on X's
  //cothread, and the other 34 are reached from MMIO handlers dispatched on X's cothread, so
  //active() is true at every existing call site and native behaviour is unchanged.
  if(!active()) return;
  #endif
  //switching to another thread does not guarantee it will catch up before switching back.
  //make sure not to switch to threads that were destroyed during synchronization
  while(thread.clock() < clock() && thread.handle()) {
    //disable synchronization for auxiliary threads during scheduler synchronization.
    //synchronization can begin inside of this while loop.
    if(scheduler.synchronizing()) break;
    #if defined(PLATFORM_WEB)
    //a chip that advances itself by plain function calls has never suspended inside its own entry
    //point, so a switch would run that entry point from the top rather than resume it. it catches
    //itself up here, on this cothread, and the switch is not needed. one generic hook rather than a
    //change at each of this core's call sites: the same shape as the active() guard above.
    if(thread.webAdvance(*this)) break;
    #endif
    co_switch(thread.handle());
  }
  //convenience: allow synchronizing multiple threads with one function call.
  if constexpr(sizeof...(p) > 0) synchronize(std::forward<P>(p)...);
}

inline auto Thread::serialize(serializer& s) -> void {
  s(_frequency);
  s(_scalar);
  s(_clock);

  if(!scheduler._synchronize) {
    static u8 stack[Thread::Size];
    bool resume = co_active() == _handle;

    if(s.reading()) {
      s(stack);
      s(resume);
      memory::copy(_handle, stack, Thread::Size);
      if(resume) scheduler._resume = _handle;
    }

    if(s.writing()) {
      memory::copy(stack, _handle, Thread::Size);
      #if defined(PLATFORM_WEB)
      //the C stack below a suspended cothread's stack pointer is unreachable: the calls that wrote
      //it have returned, and resuming grows the stack back down over it. copying it verbatim made a
      //run-ahead state carry whatever those calls last spilled, which on this platform includes the
      //host's audio resampler -- the web build advances the sound chips by plain calls on the cpu's
      //cothread -- and no save state describes that. two runs from one state then ended on different
      //bytes with the machine itself identical. dropping it changes nothing a resume can observe,
      //and a synchronized state does not reach here at all.
      u32 offset = 0;
      if(u32 size = co_dead_stack(_handle, &offset)) memory::fill<u8>(stack + offset, size);
      #endif
      s(stack);
      s(resume);
    }
  }
}
