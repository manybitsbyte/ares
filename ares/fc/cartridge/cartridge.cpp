#include <fc/fc.hpp>

namespace ares::Famicom {

Cartridge& cartridge = cartridgeSlot.cartridge;
#include "slot.cpp"
#include "board/board.cpp"
#include "serialization.cpp"

auto Cartridge::allocate(Node::Port parent) -> Node::Peripheral {
  return node = parent->append<Node::Peripheral>(string{system.name(), " Cartridge"});
}

auto Cartridge::connect() -> void {
  if(!node->setPak(pak = platform->pak(node))) return;

  information = {};
  information.title  = pak->attribute("title");
  information.region = pak->attribute("region");

  board.reset(Board::Interface::create(pak->attribute("board")));
  board->pak = pak;
  board->load();

  power();
  if(fds.present) {
    fds.load(node);
  }
}

auto Cartridge::disconnect() -> void {
  if(!node) return;
  if(fds.present) {
    fds.unload();
    fds.present = 0;
  }
  board->unload();
  board->pak.reset();
  board.reset();
  pak.reset();
  node.reset();
}

auto Cartridge::save() -> void {
  if(!node) return;
  board->save();
}

auto Cartridge::power() -> void {
  Thread::create(system.frequency(), std::bind_front(&Cartridge::main, this));
  board->power();
}

auto Cartridge::main() -> void {
  #if defined(PLATFORM_WEB)
  //the cpu advances the cartridge by plain calls to main(), so reaching this on the cartridge's
  //own cothread means the scheduler is walking auxiliary threads to their safe points. natively
  //the board is suspended in tick() at that moment and only unwinds it, advancing no further;
  //CPU::catchUpCartridge() has already left it at the same clock, so running a whole cycle here
  //would put it one ahead -- and a per-cycle board would also clock its irq counter once more
  //than the native machine ever does at this point. the region sits flush between two non-blank
  //lines so the native preprocessor's single line marker for it swallows no blank lines and the
  //preprocessed text stays byte-identical.
  if(scheduler.synchronizing()) return;
  #endif
  board->main();
}

auto Cartridge::readPRG(n32 address, n8 data) -> n8 {
  return board->readPRG(address, data);
}

auto Cartridge::writePRG(n32 address, n8 data) -> void {
  return board->writePRG(address, data);
}

auto Cartridge::readCHR(n32 address, n8 data) -> n8 {
  return board->readCHR(address, data);
}

auto Cartridge::writeCHR(n32 address, n8 data) -> void {
  return board->writeCHR(address, data);
}

auto Cartridge::ppuAddressBus(n14 address) -> void {
  return board->ppuAddressBus(address);
}

auto Cartridge::scanline(n32 y) -> void {
  return board->scanline(y);
}

}
