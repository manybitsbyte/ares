#include <assert.h>
#include <stdlib.h>

#include <libco/libco.h>

static cothread_t main_thread;
static cothread_t child_thread;
static int state;

static void child_entry(void) {
  state = 1;
  co_switch(main_thread);
  state = 3;
  co_switch(main_thread);
  abort();
}

int main(void) {
  main_thread = co_active();
  child_thread = co_create(64 * 1024, child_entry);
  assert(child_thread);

  co_switch(child_thread);
  assert(state == 1);
  state = 2;
  co_switch(child_thread);
  assert(state == 3);

  co_delete(child_thread);
  return 0;
}
