struct Accuracy {
  //enable all accuracy flags
  static constexpr bool Reference = 0;

//measurement only: the literal that the browser's !supported term already forces to 1, exposed so a
//desktop build can be made to run the browser's interpreter without a second copy of this header.
#ifndef ARES_SH2_FORCE_INTERPRETER
  #define ARES_SH2_FORCE_INTERPRETER 0
#endif
  static constexpr bool Interpreter = ARES_SH2_FORCE_INTERPRETER | Reference | !recompiler::generic::supported;
  static constexpr bool CachedInterpreter = 0 & !Interpreter;
  static constexpr bool Recompiler = !Interpreter;

  //exceptions when the CPU or DMA accesses unaligned memory addresses
  //unemulated: access of Purge, Address, or IO areas by PC-relative addressing
  //unemulated: address errors caused by stacking of address error exception handling
  static constexpr bool AddressErrors = 0 | Reference & !Recompiler;
};
