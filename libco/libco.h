#ifndef LIBCO_H
#define LIBCO_H

#ifdef __cplusplus
extern "C" {
#endif

typedef void* cothread_t;

cothread_t co_active(void);
cothread_t co_derive(void*, unsigned int, void (*)(void));
cothread_t co_create(unsigned int, void (*)(void));
void co_delete(cothread_t);
void co_switch(cothread_t);
int co_serializable(void);

#if defined(__EMSCRIPTEN__)
/* Report the region of a suspended cothread's memory that holds nothing live: the C stack below its
   saved stack pointer. `offset` receives that region's distance from the handle; the return value is
   its size, and is zero for the running cothread, whose stack pointer has not been saved. */
unsigned int co_dead_stack(cothread_t, unsigned int*);
#endif

#ifdef __cplusplus
}
#endif

/* ifndef LIBCO_H */
#endif
