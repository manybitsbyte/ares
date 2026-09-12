//the halt machinery PR #2630 added to CPU::main is driven by nall::GDB::server, which answers
//"keep running" whenever no socket client is attached. An in-process host has no client and no
//second process, so it needs its own arbiter of the same instruction boundary. Driving the GDB
//server's own breakpoint list from the host was rejected: reportPC() gates every decision on
//hasActiveClient, and faking a client would put the RSP state machine into a conversation nobody
//is holding up the other end of.
struct HostDebugger {
  enum class Stop : u32 { None = 0, Breakpoint = 1, Step = 2 };

  auto setEnabled(bool value) -> void {
    enabled = value;
    reset();
  }

  auto reset() -> void {
    halted = false;
    stepping = false;
    stepRequest = false;
    resumeRequest = false;
    stop = Stop::None;
  }

  auto addBreakpoint(u32 address) -> void {
    address &= 0xff'ffff;
    if(std::ranges::find(breakpoints, address) == breakpoints.end()) breakpoints.push_back(address);
  }

  auto removeBreakpoint(u32 address) -> void {
    std::erase(breakpoints, address & 0xff'ffff);
  }

  auto clearBreakpoints() -> void {
    breakpoints.clear();
  }

  auto requestStep() -> void {
    if(enabled && halted) stepRequest = true;
  }

  auto requestResume() -> void {
    if(enabled && halted) resumeRequest = true;
  }

  auto report(u32 pc, bool instruction) -> bool {
    if(!enabled) return true;
    current = pc;
    if(halted) {
      if(resumeRequest) {
        resumeRequest = false;
        stepRequest = false;
        halted = false;
        stop = Stop::None;
        return true;
      }
      if(stepRequest) {
        stepRequest = false;
        halted = false;
        stepping = true;
        stop = Stop::None;
        return true;
      }
      return false;
    }
    if(stepping) {
      stepping = false;
      halted = true;
      stop = Stop::Step;
      return false;
    }
    if(instruction && std::ranges::find(breakpoints, pc) != breakpoints.end()) {
      halted = true;
      stop = Stop::Breakpoint;
      return false;
    }
    return true;
  }

  bool enabled = false;
  bool halted = false;
  bool stepping = false;
  bool stepRequest = false;
  bool resumeRequest = false;
  Stop stop = Stop::None;
  u32 current = 0;
  std::vector<u32> breakpoints;
};

extern HostDebugger hostDebugger;
