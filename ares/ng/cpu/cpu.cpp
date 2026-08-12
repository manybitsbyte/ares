#include <ng/ng.hpp>

namespace ares::NeoGeo {

CPU cpu;
#include "memory.cpp"
#include "debugger.cpp"
#include "serialization.cpp"

auto CPU::load(Node::Object parent) -> void {
  node = parent->append<Node::Object>("CPU");
  debugger.load(node);
}

auto CPU::unload() -> void {
  debugger = {};
  node.reset();
}
#if !defined(PLATFORM_WEB)
auto CPU::main() -> void {
  if(io.interruptPending) {
    if(lower(Interrupt::Reset)) {
      r.a[7] = read(1, 1, 0) << 16 | read(1, 1, 2) << 0;
      r.pc   = read(1, 1, 4) << 16 | read(1, 1, 6) << 0;
      prefetch();
      prefetch();
      debugger.interrupt("Reset");
    }

    if(3 > r.i && lower(Interrupt::Power)) {
      debugger.interrupt("Power");
      return interrupt(Vector::Level3, 3);
    }

    if(2 > r.i && lower(Interrupt::Timer)) {
      debugger.interrupt("Timer");
      return interrupt(Vector::Level2, 2);
    }

    if(1 > r.i && lower(Interrupt::Vblank)) {
      debugger.interrupt("Vblank");
      return interrupt(Vector::Level1, 1);
    }
  }

  debugger.instruction();
  instruction();
}
#endif
auto CPU::idle(u32 clocks) -> void {
  Thread::step(clocks);
}
#if !defined(PLATFORM_WEB)
auto CPU::wait(u32 clocks) -> void {
  Thread::step(clocks);
  Thread::synchronize();
}
#endif
auto CPU::raise(Interrupt interrupt) -> void {
  io.interruptPending.bit((u32)interrupt) = 1;
}

auto CPU::lower(Interrupt interrupt) -> bool {
  if(!io.interruptPending.bit((u32)interrupt)) return false;
  return io.interruptPending.bit((u32)interrupt) = 0, true;
}

auto CPU::power(bool reset) -> void {
  M68000::power();
  Thread::create(12'000'000, std::bind_front(&CPU::main, this));
  io = {};
  raise(Interrupt::Reset);
}

}
#if defined(PLATFORM_WEB)
//the web expressions of CPU::main() and CPU::wait(). native's are kept verbatim above, inside
//#if !defined(PLATFORM_WEB), because the web forms need every return path to fall through to the
//retire hook and the catch-ups, and restructuring native's early returns for that would be a
//native edit this port does not make. placed at end of file because a skipped preprocessor region
//swallows the blank lines on both of its edges, and here there is nothing to swallow.
namespace ares::NeoGeo {

//native semantics with the early returns folded into an else-if chain, so the retire hook at the
//end is reached on every path. lower()'s side effects are reached in the same order: an interrupt
//that is taken still skips the checks below it, exactly as the returns did.
auto CPU::main() -> void {
  bool interrupted = false;
  if(io.interruptPending) {
    if(lower(Interrupt::Reset)) {
      r.a[7] = read(1, 1, 0) << 16 | read(1, 1, 2) << 0;
      r.pc   = read(1, 1, 4) << 16 | read(1, 1, 6) << 0;
      prefetch();
      prefetch();
      debugger.interrupt("Reset");
    }

    if(3 > r.i && lower(Interrupt::Power)) {
      debugger.interrupt("Power");
      interrupt(Vector::Level3, 3);
      interrupted = true;
    } else if(2 > r.i && lower(Interrupt::Timer)) {
      debugger.interrupt("Timer");
      interrupt(Vector::Level2, 2);
      interrupted = true;
    } else if(1 > r.i && lower(Interrupt::Vblank)) {
      debugger.interrupt("Vblank");
      interrupt(Vector::Level1, 1);
      interrupted = true;
    }
  }

  if(!interrupted) {
    debugger.instruction();
    instruction();
  }

  //the scheduler takes the primary's safe point the moment this returns, and a save state is
  //written from there. the lspc is advanced by plain calls from this cothread, so its own cothread
  //may never have run -- Thread::Enter answers the scheduler's first synchronization before
  //executing anything -- and it cannot retire the clock tail it still owes. do it here instead; the
  //lspc is an auxiliary thread and is walked after the primary, so its own main() then finds
  //nothing left to finish.
  if(scheduler.synchronizingPrimary()) lspc.finishCycle();
}

//native's wait is Thread::step() plus a full Thread::synchronize() on every bus cycle, with no
//throttle between chips -- which is why, unlike the Mega Drive's, this cpu needs no clock
//bookkeeping for interrupt sampling: every wait leaves every chip exactly where native's
//synchronization leaves it, and nothing between waits advances either build's chips. the order
//mirrors the scheduler's thread order (apu, lspc, opnb). there is no trailing ym2610 catch-up:
//APU::step pays that per z80 step, and still owes the crossing step's sync at a save exactly as
//the cothread build's suspension does -- retiring it here put the ym2610 a sample ahead of the
//reference on saves whose z80 had overshot the 68000.
auto CPU::wait(u32 clocks) -> void {
  Thread::step(clocks);
  catchUpAPU();
  catchUpLSPC();
}

//the z80 holds no state in its cothread's program counter between instructions: each APU::main()
//performs one instruction (or one interrupt dispatch) and returns to the entry loop. that makes
//entering its cothread pure overhead, so catch it up with plain function calls on this cothread;
//the generic guard in Thread::synchronize makes the z80's own synchronization a no-op while it
//runs here. the only divergence from the cothread build is that an instruction that overshoots
//the 68000's clock completes atomically instead of yielding mid-instruction at the first step
//past it. the scheduler.synchronizing() bail mirrors Thread::synchronize(), which stands down
//there -- and without it a guarded APU::main() that declines to advance would spin this loop.
auto CPU::catchUpAPU() -> void {
  if(scheduler.synchronizing()) return;
  while(apu.Thread::clock() < Thread::clock()) apu.main();
}

//natively every APU::step ends in a full synchronize, so the ym2610 tracks the z80's clock step by
//step. here a whole z80 instruction runs inside catchUpAPU, so the apu's port handlers and its
//instruction boundary call this to bring the ym2610 to the z80 before an access, or an irq.pending
//sample, reads state the cothread build would already have advanced.
auto CPU::catchUpOPNB() -> void {
  if(scheduler.synchronizing()) return;
  while(opnb.Thread::clock() < apu.Thread::clock()) opnb.main();
}

//the lspc is caught up through runCycle(), which finishes one clock's tail and steps the next, so
//the loop leaves it in the cothread build's exact mid-clock position. both clocks are re-read
//every iteration because a frame() fired from inside finishCycle() rebases all thread clocks
//through Scheduler::exit; both sides rebase together, so the comparison stays valid across it.
auto CPU::catchUpLSPC() -> void {
  if(scheduler.synchronizing()) return;
  while(lspc.Thread::clock() < Thread::clock()) lspc.runCycle();
}

}
#endif
