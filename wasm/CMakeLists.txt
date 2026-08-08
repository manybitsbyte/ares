function(add_ares_wasm_core target source output export_name)
  add_executable(${target} ${source})
  target_include_directories(${target} PRIVATE ${CMAKE_SOURCE_DIR})
  target_compile_definitions(${target} PRIVATE MIA_LIBRARY)
  target_link_libraries(${target} PRIVATE ares::ares ares::mia ares::nall)
  target_link_options(
    ${target}
    PRIVATE
      --no-entry
      $<$<BOOL:${ARES_WASM_PROFILE}>:--profiling-funcs>
      -sASYNCIFY=1
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

if(md IN_LIST ARES_CORES)
  add_ares_wasm_core(ares-md-wasm md.cpp ares-md createAresMd)
endif()

add_executable(libco-wasm-smoke EXCLUDE_FROM_ALL libco-smoke.c)
target_link_libraries(libco-wasm-smoke PRIVATE libco)
target_link_options(libco-wasm-smoke PRIVATE -sASYNCIFY=1)
set_target_properties(libco-wasm-smoke PROPERTIES SUFFIX .js)
