#define LIBCO_C
#include "libco.h"
#include "settings.h"

#include <emscripten/fiber.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  emscripten_fiber_t fiber;
  void (*entry)(void);
} cothread_struct;

enum { primary_asyncify_stack_size = 64 * 1024 };

static cothread_struct co_primary;
static unsigned char co_primary_asyncify_stack[primary_asyncify_stack_size];
static cothread_struct* co_running;

static void co_init(void) {
  if(co_running) return;
  co_running = &co_primary;
  emscripten_fiber_init_from_current_context(
    &co_primary.fiber, co_primary_asyncify_stack, sizeof(co_primary_asyncify_stack)
  );
}

static void co_entry(void* opaque) {
  cothread_struct* thread = (cothread_struct*)opaque;
  thread->entry();
  abort();
}

cothread_t co_active(void) {
  co_init();
  return (cothread_t)co_running;
}

cothread_t co_derive(void* memory, unsigned int size, void (*entry)(void)) {
  co_init();
  if(!memory || size <= sizeof(cothread_struct) + 32) return 0;

  cothread_struct* thread = (cothread_struct*)memory;
  uintptr_t stack_begin = ((uintptr_t)memory + sizeof(cothread_struct) + 15) & ~(uintptr_t)15;
  size_t stack_size = (uintptr_t)memory + size - stack_begin;
  size_t c_stack_size = (stack_size / 2) & ~(size_t)15;
  unsigned char* c_stack = (unsigned char*)stack_begin;
  unsigned char* asyncify_stack = c_stack + c_stack_size;

  thread->entry = entry;
  emscripten_fiber_init(
    &thread->fiber,
    co_entry,
    thread,
    c_stack,
    c_stack_size,
    asyncify_stack,
    stack_size - c_stack_size
  );
  return (cothread_t)thread;
}

cothread_t co_create(unsigned int size, void (*entry)(void)) {
  void* memory = malloc(size);
  if(!memory) return 0;
  if(co_derive(memory, size, entry)) return memory;
  free(memory);
  return 0;
}

void co_delete(cothread_t thread) {
  if(thread && thread != &co_primary) free(thread);
}

#if defined(ARES_WASM_DEBUG)
//instrumentation for the wasm smoke harness. co_switch is the hottest path in the emulator, so the
//default build carries neither the counter nor its increment.
unsigned long long co_switch_count = 0;
#endif

void co_switch(cothread_t handle) {
  co_init();
  if(!handle || handle == co_running) return;
  #if defined(ARES_WASM_DEBUG)
  co_switch_count++;
  #endif

  cothread_struct* previous = co_running;
  co_running = (cothread_struct*)handle;
  emscripten_fiber_swap(&previous->fiber, &co_running->fiber);
  co_running = previous;
}

int co_serializable(void) {
  return 0;
}
