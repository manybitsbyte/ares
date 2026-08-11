/* the APU can write to CPU RAM, but it cannot read from CPU RAM:
 * the exact returned value varies per system, but it always fails.
 * it is unknown which other regions of the bus are inaccessible to the APU.
 * it would certainly go very badly if the APU could reference itself at $a0xxxx.
 * for now, assume that only the cartridge and expansion buses are also accessible.
 */

auto APU::read(n16 address) -> n8 {
  if(address >= 0x0000 && address <= 0x3fff) return ram.read(address);  //$2000-3fff mirrors $0000-1fff
  if(address >= 0x4000 && address <= 0x5fff) {
    #if defined(PLATFORM_WEB)
    cpu.catchUpOPN2();
    #endif
    return opn2.readStatus();
  }
  if(address >= 0x7f00 && address <= 0x7fff) return readExternal(0xc00000 | (n8)address);
  if(address >= 0x8000 && address <= 0xffff) return readExternal(state.bank << 15 | (n15)address);
  debug(unusual, "[APU] read(0x", hex(address, 4L), ")");
  return 0x00;
}

auto APU::write(n16 address, n8 data) -> void {
  if(address >= 0x0000 && address <= 0x3fff) return ram.write(address, data);  //$2000-3fff mirrors $0000-1fff
  if(address >= 0x4000 && address <= 0x5fff) {
    #if defined(PLATFORM_WEB)
    cpu.catchUpOPN2();
    #endif
    switch(0x4000 | address & 3) {
    case 0x4000: return opn2.writeAddress(0 << 8 | data);
    case 0x4001: return opn2.writeData(data);
    case 0x4002: return opn2.writeAddress(1 << 8 | data);
    case 0x4003: return opn2.writeData(data);
    }
    unreachable;
  }
  if(address >= 0x6000 && address <= 0x60ff) return (void)(state.bank = data.bit(0) << 8 | state.bank >> 1);
  if(address >= 0x7f00 && address <= 0x7fff) return writeExternal(0xc00000 | (n8)address, data);
  if(address >= 0x8000 && address <= 0xffff) return writeExternal(state.bank << 15 | (n15)address, data);
  debug(unusual, "[APU] write(0x", hex(address, 4L), ")");
  return;
}
#if !defined(PLATFORM_WEB)
auto APU::readExternal(n24 address) -> n8 {
  step(3); // approximate Z80 delay
  while(MegaDrive::bus.acquired() && !scheduler.synchronizing()) step(1);
  cpu.state.stolenMcycles += 68; // approximate 68K delay; 68 Mclk ~= 9.7 68k clk
  MegaDrive::bus.acquire(MegaDrive::Bus::APU);

  n8 data = 0xff;
  if(address >= 0x000000 && address <= 0x9fffff
  || address >= 0xa10000 && address <= 0xa1ffff
  || address >= 0xc00000 && address <= 0xc000ff) {
    if(address & 1) {
      data = MegaDrive::bus.read(0, 1, address & ~1, 0x00).byte(0);
    } else {
      data = MegaDrive::bus.read(1, 0, address & ~1, 0x00).byte(1);
    }
  } else {
    debug(unusual, "[APU] readExternal(0x", hex(address, 6L), ")");
  }

  MegaDrive::bus.release(MegaDrive::Bus::APU);
  return data;
}

auto APU::writeExternal(n24 address, n8 data) -> void {
  step(3); // approximate Z80 delay
  while(MegaDrive::bus.acquired() && !scheduler.synchronizing()) step(1);
  cpu.state.stolenMcycles += 68; // approximate 68K delay; 68 Mclk ~= 9.7 68k clk
  MegaDrive::bus.acquire(MegaDrive::Bus::APU);

  if(address >= 0x000000 && address <= 0x9fffff
  || address >= 0xa10000 && address <= 0xa1ffff
  || address >= 0xc00000 && address <= 0xc000ff
  || address >= 0xe00000 && address <= 0xffffff) {
    if(address & 1) {
      MegaDrive::bus.write(0, 1, address & ~1, data << 8 | data << 0);
    } else {
      MegaDrive::bus.write(1, 0, address & ~1, data << 8 | data << 0);
    }
  } else {
    debug(unusual, "[APU] writeExternal(0x", hex(address, 6L), ")");
  }

  MegaDrive::bus.release(MegaDrive::Bus::APU);
}
#endif
auto APU::in(n16 address) -> n8 {
  //unused on Mega Drive
  return 0xff;
}

auto APU::out(n16 address, n8 data) -> void {
  //unused on Mega Drive
}
#if defined(PLATFORM_WEB)
//A second expression of the native readExternal/writeExternal above, verbatim except that the wait
//for the 68000 bus is bounded by the 68000's own clock.
//
//The native wait cannot terminate here. The z80 is advanced by plain calls on the cpu's cothread
//(see CPU::catchUpAPU), so while it spins the 68000 is not running, and the bus it is waiting on is
//held by a 68k->vdp dma (VDP::DMA::synchronize) that only the vdp can finish -- and the vdp has no
//thread of its own either. Nothing can release the bus, so the frame never returns and the browser
//offers to kill the page. MUSHA reaches it: its z80 driver streams pcm out of rom through the bank
//window, so a z80 external access eventually lands inside a dma.
//
//The bound is what the cothread build's own structure says it should be. There, APU::step ends in
//Thread::synchronize(cpu), so the z80 can never run past the 68000; every step of this wait hands
//control back, the 68000 advances, and its wait() runs the vdp through catchUpVDP until the dma
//completes. Stopping at cpu.Thread::clock() reproduces that handover: the z80 waits as long as it
//has budget for, returns to catchUpAPU, and the 68000 resumes -- and it is the 68000, not the z80,
//that drives the vdp forward. The read then applies with the bus still nominally held, which is one
//more approximation on the path that already charges the 68000 a flat 68 Mclk below rather than
//stalling it for real.
//
//Advancing the vdp from inside this wait instead -- the shape VDP::FIFO::write and
//VDP::readDataPort use -- also clears the hang, and was measured and rejected: it lets the z80 and
//the vdp race past the 68000, so the vdp-driven frame ends with the 68000 and the ym2612 behind it.
//On MUSHA that cost 18% of the audio stream over 900 frames; here the stream length is equal to the
//cothread build's. Those two sites are entered from the vdp's side and are left as they are.
//
//It sits at the end of the file because a skipped region swallows the blank lines on both its
//edges, and at the end of what the preprocessor sees there is nothing to swallow.
auto APU::readExternal(n24 address) -> n8 {
  step(3); // approximate Z80 delay
  while(MegaDrive::bus.acquired() && !scheduler.synchronizing()
     && Thread::clock() < cpu.Thread::clock()) step(1);
  cpu.state.stolenMcycles += 68; // approximate 68K delay; 68 Mclk ~= 9.7 68k clk
  MegaDrive::bus.acquire(MegaDrive::Bus::APU);

  n8 data = 0xff;
  if(address >= 0x000000 && address <= 0x9fffff
  || address >= 0xa10000 && address <= 0xa1ffff
  || address >= 0xc00000 && address <= 0xc000ff) {
    if(address & 1) {
      data = MegaDrive::bus.read(0, 1, address & ~1, 0x00).byte(0);
    } else {
      data = MegaDrive::bus.read(1, 0, address & ~1, 0x00).byte(1);
    }
  } else {
    debug(unusual, "[APU] readExternal(0x", hex(address, 6L), ")");
  }

  MegaDrive::bus.release(MegaDrive::Bus::APU);
  return data;
}

auto APU::writeExternal(n24 address, n8 data) -> void {
  step(3); // approximate Z80 delay
  while(MegaDrive::bus.acquired() && !scheduler.synchronizing()
     && Thread::clock() < cpu.Thread::clock()) step(1);
  cpu.state.stolenMcycles += 68; // approximate 68K delay; 68 Mclk ~= 9.7 68k clk
  MegaDrive::bus.acquire(MegaDrive::Bus::APU);

  if(address >= 0x000000 && address <= 0x9fffff
  || address >= 0xa10000 && address <= 0xa1ffff
  || address >= 0xc00000 && address <= 0xc000ff
  || address >= 0xe00000 && address <= 0xffffff) {
    if(address & 1) {
      MegaDrive::bus.write(0, 1, address & ~1, data << 8 | data << 0);
    } else {
      MegaDrive::bus.write(1, 0, address & ~1, data << 8 | data << 0);
    }
  } else {
    debug(unusual, "[APU] writeExternal(0x", hex(address, 6L), ")");
  }

  MegaDrive::bus.release(MegaDrive::Bus::APU);
}
#endif
