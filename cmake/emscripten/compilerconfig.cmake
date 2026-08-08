include_guard(GLOBAL)

include(compiler_common)

set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELEASE FALSE)

add_compile_options(
  "$<$<COMPILE_LANGUAGE:C>:${_ares_clang_c_options}>"
  "$<$<COMPILE_LANGUAGE:CXX>:${_ares_clang_cxx_options}>"
  -fwrapv
  -fno-char8_t
  $<$<CONFIG:Release>:-flto>
)

add_link_options($<$<CONFIG:Release>:-flto>)
