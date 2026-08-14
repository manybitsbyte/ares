struct Accuracy {
  //enable all accuracy flags
  static constexpr bool Reference = 0;

  struct CPU {
    //exceptions when the CPU accesses unaligned memory addresses
    static constexpr bool AddressErrors = 1 | Reference;

    //exceptions when the CPU accesses unmapped memory addresses
    static constexpr bool BusErrors = 1 | Reference;

    //breakpoints are expensive and not used by any commercial games (but are used by Action Replay, etc)
    static constexpr bool Breakpoints = 1 | Reference;
  };

  struct GPU {
    #if defined(__EMSCRIPTEN__)
    //that separate thread is a real OS thread -- nall::thread is pthread_create -- and the wasm build
    //links no pthreads at all, so the create fails and nothing ever drains the queue the GPU writes
    //its primitives into. 0 executes each primitive inline from the GPU's own cothread instead
    //(renderer.cpp:426-431), through the same Render::execute onto the same vram; Threaded reaches
    //only queue, kill and power, none of which any serialize() reads. keyed on __EMSCRIPTEN__ as
    //ares::Video::Threaded is (ares.hpp:64), not PLATFORM_WEB, which ARES_PS1_COTHREAD undefines.
    static constexpr bool Threaded = 0;
    #else
    //performs GPU primitive rendering on a separate thread
    static constexpr bool Threaded = 1;
    #endif
  };
};
