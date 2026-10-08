auto CPU::read(n1 upper, n1 lower, n24 address, n16) -> n16 {
  if(bus.acquired()) probec[14]++;  //PROBE C
  while(bus.acquired()) { probec[13]++; wait(1); }  //PROBE C
  //using m68k prefetch for open-bus data
  return bus.read(upper, lower, address, r.irc);
}

auto CPU::write(n1 upper, n1 lower, n24 address, n16 data) -> void {
  if(bus.acquired()) probec[14]++;  //PROBE C
  while(bus.acquired()) { probec[13]++; wait(1); }  //PROBE C
  return bus.write(upper, lower, address, data);
}
