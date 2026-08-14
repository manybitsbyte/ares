function(add_ares_wasm_core target source output export_name)
  add_executable(${target} ${source})
  target_include_directories(${target} PRIVATE ${CMAKE_SOURCE_DIR})
  target_compile_definitions(${target} PRIVATE MIA_LIBRARY $<$<BOOL:${ARES_WASM_DEBUG}>:ARES_WASM_DEBUG>)
  target_link_libraries(${target} PRIVATE ares::ares ares::mia ares::nall)
  target_link_options(
    ${target}
    PRIVATE
      --no-entry
      $<$<BOOL:${ARES_WASM_PROFILE}>:--profiling-funcs>
      -sASYNCIFY=1
      #Asyncify instruments every function it believes can be on the stack when a fiber swaps, and
      #it reaches mia through the invoke_* wrappers rather than through any real call: 664 of the
      #functions it instruments are the ROM loader's, in every core. mia runs while a cartridge is
      #being seated or written back, never while a frame is in flight, so it cannot be on that
      #stack. Saying so takes 134 KB off each module -- 3.8% of sfc, 7.0% of gb.
      #The SH-2 interpreter batches on the CCR ledger (see SH2::instruction), so nothing between the
      #batch's start and its single step() can reach Thread::synchronize: the opcode handlers never
      #step, and every bus access banks. That makes the execute/read/write/cache tree provably absent
      #from any suspended stack. Templates need the leading * -- the demangled name leads with the
      #return type, so ares::SH2::* silently matches none of them.
      "-sASYNCIFY_REMOVE=mia::*,*ares::SH2::execute*,*ares::SH2::read*,*ares::SH2::write*,*ares::SH2::Cache::*"
      -fwhole-program-vtables
      -sALLOW_MEMORY_GROWTH=1
      -sFILESYSTEM=1
      -sMODULARIZE=1
      -sEXPORT_ES6=1
      -sEXPORT_NAME=${export_name}
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString
      -sNO_EXIT_RUNTIME=1
  )
  set_target_properties(${target} PROPERTIES OUTPUT_NAME ${output} SUFFIX .mjs)
endfunction()

if(fc IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-fc-wasm fc.cpp ares-fc createAresFc)
  target_link_libraries(ares-fc-wasm PRIVATE ymfm)
  target_link_options(
    ares-fc-wasm
    PRIVATE
      "SHELL:--preload-file \"${CMAKE_SOURCE_DIR}/mia/Database/Famicom.bml@/Database/Famicom.bml\""
  )
endif()

if(sfc IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-sfc-wasm sfc.cpp ares-sfc createAresSfc)
  target_link_options(
    ares-sfc-wasm
    PRIVATE
      "SHELL:--preload-file \"${CMAKE_SOURCE_DIR}/mia/Database/Super Famicom.bml@/Database/Super Famicom.bml\""
      "SHELL:--preload-file \"${CMAKE_SOURCE_DIR}/mia/Database/Super Famicom Boards.bml@/Database/Super Famicom Boards.bml\""
  )
endif()

if(ms IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-ms-wasm ms.cpp ares-ms createAresMs)
endif()

if(md IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-md-wasm md.cpp ares-md createAresMd)
endif()

if(gb IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-gb-wasm gb.cpp ares-gb createAresGb)
endif()

if(gba IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-gba-wasm gba.cpp ares-gba createAresGba)
endif()

if(pce IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-pce-wasm pce.cpp ares-pce createAresPce)
endif()

if(ng IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-ng-wasm ng.cpp ares-ng createAresNg)
  target_link_libraries(ares-ng-wasm PRIVATE ymfm)
  target_link_options(
    ares-ng-wasm
    PRIVATE
      "SHELL:--preload-file \"${CMAKE_SOURCE_DIR}/mia/Database/Neo Geo.bml@/Database/Neo Geo.bml\""
  )
endif()

if(ps1 IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-ps1-wasm ps1.cpp ares-ps1 createAresPs1)
  #the only module here that needs more than Emscripten's 64 KiB default stack, and it needs it
  #before the first frame rather than during one. sizeof(nall::CD::Session) is 80,820 bytes -- 100
  #tracks of 100 indices -- and a disc load puts two of them on the stack at once, one in
  #vfs::cdrom::loadCue and one in the loadSub it calls. A native host answers that out of an 8 MB
  #thread stack without noticing; wasm traps, and with no overflow check in a release build it
  #traps as an out-of-bounds access a long way from the write that caused it.
  target_link_options(ares-ps1-wasm PRIVATE -sSTACK_SIZE=1048576)
endif()

add_executable(libco-wasm-smoke EXCLUDE_FROM_ALL libco-smoke.c)
target_link_libraries(libco-wasm-smoke PRIVATE libco)
target_link_options(libco-wasm-smoke PRIVATE -sASYNCIFY=1)
set_target_properties(libco-wasm-smoke PROPERTIES SUFFIX .js)
