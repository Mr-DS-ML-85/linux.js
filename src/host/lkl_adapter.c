/*
 * linux.js — LKL WASM adapter.
 *
 * Implements `lkl_host_operations` for the Emscripten/WASM environment
 * and exposes a small C ABI that the TypeScript bridge calls via the
 * Emscripten loader.
 *
 * Model:
 *   - One LKL kernel instance per WASM module.
 *   - Kernel boots with `init=/bin/busybox sh` and uses an embedded
 *     initramfs containing a wasm32-LKL build of BusyBox.
 *   - We allocate a host-managed virtio-console-style pipe: init's stdin
 *     reads from `input_pipe`, init's stdout/stderr write through
 *     `host_print` into `output_ring`.
 *   - `lkl_send_input` pushes bytes into `input_pipe`; `lkl_drain_output`
 *     pops bytes from `output_ring`. The JS side wraps these with the
 *     sentinel protocol used by `Linux.exec`.
 *
 * File I/O bypasses the shell entirely and goes through `lkl_sys_*`
 * against the real kernel VFS — same kernel, just no roundtrip.
 *
 * License: GPL v2 (linked into the kernel binary).
 */
#include <string.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <time.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdint.h>
#include <unistd.h>      /* write(2) */
#include <emscripten.h>  /* emscripten_get_callstack */

/*
 * Use the KERNEL's actual struct lkl_host_operations definition.
 *
 * The hand-rolled struct we used before was missing ~15 fields
 * (memcpy/memset/memmove, mmap/munmap, tls_*, page_alloc/free,
 * thread_self/equal/stack, jmp_buf_set/longjmp, shmem_*, pci_ops).
 * Hand-rolling produced a layout where the kernel called
 * function pointers at the wrong offsets → "null function or function
 * signature mismatch" at runtime.
 *
 * Including <asm/host_ops.h> directly guarantees ABI match. The build
 * script adds -I/build/lkl/arch/lkl/include/uapi for this.
 */
#include <asm/host_ops.h>

typedef size_t lkl_size_t;

extern int  lkl_init(struct lkl_host_operations *ops);
extern int  lkl_start_kernel(const char *cmdline, ...);
extern long lkl_syscall(long no, long *params);
extern long lkl_sys_halt(void);
extern void lkl_cleanup(void);

/*
 * Syscall numbers and flags from the kernel's asm-generic UAPI
 * (include/uapi/asm-generic/unistd.h, .../fcntl.h) — LKL uses the generic
 * table, NOT x86_64's. (This file used to hardcode x86_64 numbers, so
 * e.g. "read" (0) actually invoked io_setup.) Only *at variants are used;
 * the legacy open/mkdir/unlink entries aren't in the generic table.
 */
#define LKL_NR_dup3        24
#define LKL_NR_mkdirat     34
#define LKL_NR_unlinkat    35
#define LKL_NR_mount       40
#define LKL_NR_openat      56
#define LKL_NR_close       57
#define LKL_NR_pipe2       59
#define LKL_NR_getdents64  61
#define LKL_NR_read        63
#define LKL_NR_write       64
#define LKL_NR_pread64     67
#define LKL_NR_sync        81
#define LKL_NR_statx       291

#define LKL_O_RDONLY       00000000
#define LKL_O_WRONLY       00000001
#define LKL_O_CREAT        00000100
#define LKL_O_TRUNC        00001000
#define LKL_O_APPEND       00002000
#define LKL_O_LARGEFILE    00100000   /* required for >2 GiB files on 32-bit */
#define LKL_O_DIRECTORY    00200000
#define LKL_O_CLOEXEC      02000000
#define LKL_AT_FDCWD       (-100)
#define LKL_AT_REMOVEDIR   0x200

/* Kernel return values use Linux errno numbers. Emscripten's <errno.h>
 * uses WASI numbering (EEXIST=20, ENOENT=44), so never compare kernel
 * results against libc E* constants. */
#define LKL_ENOENT         2
#define LKL_EEXIST         17

/* dirent layout from kernel uapi */
struct lkl_linux_dirent64 {
    uint64_t d_ino;
    int64_t  d_off;
    unsigned short d_reclen;
    unsigned char  d_type;
    char     d_name[];
};

/* Thin wrappers so the rest of the adapter reads like before. */
static inline long lkl_sys_open(const char *path, int flags, int mode) {
    long p[6] = { LKL_AT_FDCWD, (long)path, flags | LKL_O_LARGEFILE | LKL_O_CLOEXEC, mode, 0, 0 };
    return lkl_syscall(LKL_NR_openat, p);
}
static inline long lkl_sys_close(int fd) {
    long p[6] = { fd, 0, 0, 0, 0, 0 };
    return lkl_syscall(LKL_NR_close, p);
}
static inline long lkl_sys_read(int fd, void *buf, long count) {
    long p[6] = { fd, (long)buf, count, 0, 0, 0 };
    return lkl_syscall(LKL_NR_read, p);
}
static inline long lkl_sys_write(int fd, const void *buf, long count) {
    long p[6] = { fd, (long)buf, count, 0, 0, 0 };
    return lkl_syscall(LKL_NR_write, p);
}
static inline long lkl_sys_mkdir(const char *path, int mode) {
    long p[6] = { LKL_AT_FDCWD, (long)path, mode, 0, 0, 0 };
    return lkl_syscall(LKL_NR_mkdirat, p);
}
static inline long lkl_sys_unlink(const char *path) {
    long p[6] = { LKL_AT_FDCWD, (long)path, 0, 0, 0, 0 };
    return lkl_syscall(LKL_NR_unlinkat, p);
}
static inline long lkl_sys_rmdir(const char *path) {
    long p[6] = { LKL_AT_FDCWD, (long)path, LKL_AT_REMOVEDIR, 0, 0, 0 };
    return lkl_syscall(LKL_NR_unlinkat, p);
}
static inline long lkl_sys_mount(const char *src, const char *tgt, const char *type,
                                  unsigned long flags, const void *data) {
    long p[6] = { (long)src, (long)tgt, (long)type, (long)flags, (long)data, 0 };
    return lkl_syscall(LKL_NR_mount, p);
}
static inline long lkl_sys_sync(void) {
    long p[6] = { 0, 0, 0, 0, 0, 0 };
    return lkl_syscall(LKL_NR_sync, p);
}
static inline long lkl_sys_dup2(int oldfd, int newfd) {
    if (oldfd == newfd) return newfd;
    long p[6] = { oldfd, newfd, 0, 0, 0, 0 };
    return lkl_syscall(LKL_NR_dup3, p);
}
static inline long lkl_sys_pipe2(int fds[2], int flags) {
    long p[6] = { (long)fds, flags, 0, 0, 0, 0 };
    return lkl_syscall(LKL_NR_pipe2, p);
}
static inline long lkl_sys_getdents64(int fd, void *buf, long count) {
    long p[6] = { fd, (long)buf, count, 0, 0, 0 };
    return lkl_syscall(LKL_NR_getdents64, p);
}

/*
 * statx: unlike `struct stat`, `struct statx` has the same layout on every
 * architecture (include/uapi/linux/stat.h), so we can read it by offset
 * without the kernel headers. The previous plain-stat path used a 40-byte
 * guess at a ~64-byte 32-bit `struct stat`: the kernel wrote past the
 * stack buffer and st_size was read from padding.
 */
#define STATX_BUF_SIZE    256
#define STATX_OFF_MODE    28   /* __u16 stx_mode */
#define STATX_OFF_SIZE    40   /* __u64 stx_size */
#define LKL_STATX_BASIC   0x000007ffU

static inline long lkl_sys_statx(const char *path, void *buf) {
    long p[6] = { LKL_AT_FDCWD, (long)path, 0, LKL_STATX_BASIC, (long)buf, 0 };
    return lkl_syscall(LKL_NR_statx, p);
}

/*
 * Positional I/O. On wasm32 the syscall table maps pread64/pwrite64 to
 * LKL's sys32_* shims, which take the 64-bit offset split as (lo, hi).
 */
static inline long lkl_sys_pread64(int fd, void *buf, long count, long long pos) {
#if __SIZEOF_LONG__ == 4
    long p[6] = { fd, (long)buf, count, (long)(unsigned long)(pos & 0xffffffffULL),
                  (long)(unsigned long)((unsigned long long)pos >> 32), 0 };
#else
    long p[6] = { fd, (long)buf, count, (long)pos, 0, 0 };
#endif
    return lkl_syscall(LKL_NR_pread64, p);
}

/* ─── Constants ───────────────────────────────────────────────────── */

#define OUTPUT_RING_SIZE (1 * 1024 * 1024)   /* 1 MB console scrollback */
#define INPUT_PIPE_SIZE  (64 * 1024)         /* host -> guest stdin */
#define ERROR_BUF_SIZE   256
#define CMDLINE_MAX      4096
#define PATH_BUF_MAX     4096
#define DIRENT_BUF_MAX   (32 * 1024)

/* ─── Global state ────────────────────────────────────────────────── */

static volatile int kernel_running = 0;

/* Per-thread error message slot. */
static pthread_key_t  error_key;
static pthread_once_t error_key_once = PTHREAD_ONCE_INIT;

/* Console output ring buffer (kernel + init writes -> host reads). */
static char            output_ring[OUTPUT_RING_SIZE];
static int             output_head = 0;   /* next write position */
static int             output_tail = 0;   /* next read position */
static int             output_filled = 0; /* bytes currently buffered */
static pthread_mutex_t output_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Host->guest input pipe FDs (created with lkl_sys_pipe2). */
static int input_pipe_read_fd  = -1;   /* read end given to init's stdin */
static int input_pipe_write_fd = -1;   /* write end retained by the host */

/* ─── Error helpers ───────────────────────────────────────────────── */

static void make_error_key(void)
{
    pthread_key_create(&error_key, free);
}

static void set_error(const char *fmt, ...)
{
    pthread_once(&error_key_once, make_error_key);

    char *buf = malloc(ERROR_BUF_SIZE);
    if (!buf) return;

    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, ERROR_BUF_SIZE, fmt, ap);
    va_end(ap);

    void *prev = pthread_getspecific(error_key);
    free(prev);
    pthread_setspecific(error_key, buf);
}

static const char *get_error(void)
{
    pthread_once(&error_key_once, make_error_key);
    const char *err = pthread_getspecific(error_key);
    return err ? err : "unknown error";
}

/* ─── Output ring buffer ──────────────────────────────────────────── */

static void ring_push(const char *data, int len)
{
    if (len <= 0) return;
    pthread_mutex_lock(&output_mutex);

    /* If the payload is larger than the ring, retain only the tail. */
    if (len >= OUTPUT_RING_SIZE) {
        data += (len - OUTPUT_RING_SIZE);
        len = OUTPUT_RING_SIZE;
        output_head = output_tail = 0;
        output_filled = 0;
    }

    /* Drop oldest bytes if needed to make room (lossy ring). */
    int free_space = OUTPUT_RING_SIZE - output_filled;
    if (len > free_space) {
        int drop = len - free_space;
        output_tail = (output_tail + drop) % OUTPUT_RING_SIZE;
        output_filled -= drop;
    }

    /* Copy in, possibly wrapping. */
    int first = OUTPUT_RING_SIZE - output_head;
    if (first > len) first = len;
    memcpy(output_ring + output_head, data, first);
    if (len > first) {
        memcpy(output_ring, data + first, len - first);
    }
    output_head = (output_head + len) % OUTPUT_RING_SIZE;
    output_filled += len;

    pthread_mutex_unlock(&output_mutex);
}

static int ring_pop(char *dst, int max)
{
    pthread_mutex_lock(&output_mutex);
    int n = output_filled < max ? output_filled : max;
    if (n > 0) {
        int first = OUTPUT_RING_SIZE - output_tail;
        if (first > n) first = n;
        memcpy(dst, output_ring + output_tail, first);
        if (n > first) {
            memcpy(dst + first, output_ring, n - first);
        }
        output_tail = (output_tail + n) % OUTPUT_RING_SIZE;
        output_filled -= n;
    }
    pthread_mutex_unlock(&output_mutex);
    return n;
}

/* ─── lkl_host_operations ─────────────────────────────────────────── */

/* Opt-in (Linux.create({ debug: true })): mirror kernel console output to
 * stderr. Nobody can drain the ring while linuxjs_boot() blocks, so this
 * is how boot hangs are diagnosed. */
static volatile int debug_stderr = 0;
void linuxjs_set_debug(int on) { debug_stderr = on; }

static void host_print(const char *str, int len)
{
    ring_push(str, len);
    if (debug_stderr && len > 0) {
        long w = write(2, str, (size_t)len);
        (void)w;
    }
}

/* Set once by host_panic(); every host wait primitive checks it. */
static volatile int kernel_panicked = 0;
static void wake_all_sems(void);

/*
 * The kernel has stopped for good. Wake every thread blocked in a host
 * semaphore (including the JS caller blocked in linuxjs_boot()) so each
 * one traps instead of hanging, then trap this thread. Do NOT call
 * abort(): under --whole-archive that resolves to the kernel's own
 * abort(), which calls panic() again → infinite recursion.
 */
static void host_panic(void)
{
    static const char msg[] = "\n[linux.js] LKL kernel panic\n";
    host_print(msg, (int)sizeof(msg) - 1);
    kernel_running = 0;
    __atomic_store_n(&kernel_panicked, 1, __ATOMIC_SEQ_CST);
    wake_all_sems();
    __builtin_trap();
}

/* Exported so the JS side can tell a kernel panic from other traps. */
int linuxjs_kernel_panicked(void)
{
    return __atomic_load_n(&kernel_panicked, __ATOMIC_SEQ_CST);
}

/*
 * lkl_printf / lkl_bug normally come from LKL's host library
 * (tools/lkl/lib/utils.c), which we don't build. The kernel calls them
 * from arch/lkl (CPU-ownership checks, thread_sched_jb, early init
 * failures). vsnprintf resolves to the kernel's lib/vsprintf.c, which is
 * safe here: these are only ever called from kernel context.
 */
int lkl_printf(const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0) return n;
    if (n >= (int)sizeof(buf)) n = (int)sizeof(buf) - 1;
    host_print(buf, n);
    return n;
}

/*
 * Called by the kernel's show_stack() (patch 0027) for WARN/BUG/panic
 * splats. Native frame walking is meaningless on wasm; Emscripten can
 * produce the real call stack with wasm function names instead. Kernel
 * code runs one thread at a time (LKL CPU lock), so a static buffer is
 * fine.
 */
void linuxjs_host_backtrace(void)
{
    static char buf[16384];
    /* V8 keeps only 10 frames by default; kernel splats need more. */
    EM_ASM({ Error.stackTraceLimit = 64; });
    int n = emscripten_get_callstack(EM_LOG_JS_STACK | EM_LOG_NO_PATHS,
                                     buf, (int)sizeof(buf));
    if (n <= 0) return;
    n = (int)strnlen(buf, sizeof(buf));
    host_print(buf, n);
    if (n > 0 && buf[n - 1] != '\n') host_print("\n", 1);
}

void lkl_bug(const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n >= (int)sizeof(buf)) n = (int)sizeof(buf) - 1;
    static const char prefix[] = "[linux.js] LKL BUG: ";
    host_print(prefix, (int)sizeof(prefix) - 1);
    if (n > 0) host_print(buf, n);
    host_panic();
}

/* Counting semaphore over pthread mutex + condition variable. */
struct lkl_sem {
    pthread_mutex_t mutex;
    pthread_cond_t  cond;
    int             count;
    struct lkl_sem *prev, *next;   /* registry, for wake_all_sems() */
};

/* Every live semaphore, so a panic can wake all waiters at once. */
static pthread_mutex_t sem_registry_lock = PTHREAD_MUTEX_INITIALIZER;
static struct lkl_sem *sem_registry = NULL;

static void wake_all_sems(void)
{
    pthread_mutex_lock(&sem_registry_lock);
    for (struct lkl_sem *s = sem_registry; s; s = s->next) {
        pthread_mutex_lock(&s->mutex);
        pthread_cond_broadcast(&s->cond);
        pthread_mutex_unlock(&s->mutex);
    }
    pthread_mutex_unlock(&sem_registry_lock);
}

static struct lkl_sem *host_sem_alloc(int count)
{
    struct lkl_sem *s = malloc(sizeof(*s));
    if (!s) return NULL;
    pthread_mutex_init(&s->mutex, NULL);
    pthread_cond_init(&s->cond, NULL);
    s->count = count;
    pthread_mutex_lock(&sem_registry_lock);
    s->prev = NULL;
    s->next = sem_registry;
    if (sem_registry) sem_registry->prev = s;
    sem_registry = s;
    pthread_mutex_unlock(&sem_registry_lock);
    return s;
}

static void host_sem_free(struct lkl_sem *s)
{
    if (!s) return;
    pthread_mutex_lock(&sem_registry_lock);
    if (s->prev) s->prev->next = s->next; else sem_registry = s->next;
    if (s->next) s->next->prev = s->prev;
    pthread_mutex_unlock(&sem_registry_lock);
    pthread_mutex_destroy(&s->mutex);
    pthread_cond_destroy(&s->cond);
    free(s);
}

static void host_sem_up(struct lkl_sem *s)
{
    if (!s) return;
    pthread_mutex_lock(&s->mutex);
    s->count++;
    pthread_cond_signal(&s->cond);
    pthread_mutex_unlock(&s->mutex);
}

static void host_sem_down(struct lkl_sem *s)
{
    if (!s) return;
    pthread_mutex_lock(&s->mutex);
    while (s->count <= 0) {
        if (__atomic_load_n(&kernel_panicked, __ATOMIC_SEQ_CST)) {
            pthread_mutex_unlock(&s->mutex);
            __builtin_trap();   /* kernel is dead: unwind this thread */
        }
        pthread_cond_wait(&s->cond, &s->mutex);
    }
    s->count--;
    pthread_mutex_unlock(&s->mutex);
}

/* Mutex pass-through (LKL distinguishes semaphores from mutexes). */
struct lkl_mutex { pthread_mutex_t m; };

static struct lkl_mutex *host_mutex_alloc(int recursive)
{
    struct lkl_mutex *mx = malloc(sizeof(*mx));
    if (!mx) return NULL;
    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    if (recursive) pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&mx->m, &attr);
    pthread_mutexattr_destroy(&attr);
    return mx;
}

static void host_mutex_free(struct lkl_mutex *mx) {
    if (!mx) return;
    pthread_mutex_destroy(&mx->m);
    free(mx);
}
static void host_mutex_lock(struct lkl_mutex *mx)   { pthread_mutex_lock(&mx->m); }
static void host_mutex_unlock(struct lkl_mutex *mx) { pthread_mutex_unlock(&mx->m); }

struct thread_args {
    void (*fn)(void *);
    void *arg;
};

/* Live and peak host-thread counts (kernel threads + timers + boot). The
 * peak must stay below PTHREAD_POOL_SIZE: a thread created while the pool
 * is empty needs the main JS thread to spawn a Worker, and the main thread
 * may be blocked in a syscall waiting for exactly that thread. */
static int live_threads = 0;
static int peak_threads = 0;

static void thread_started(void)
{
    int n = __atomic_add_fetch(&live_threads, 1, __ATOMIC_SEQ_CST);
    int p = __atomic_load_n(&peak_threads, __ATOMIC_SEQ_CST);
    while (n > p && !__atomic_compare_exchange_n(&peak_threads, &p, n, 0,
                                                 __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST))
        ;
}

static void thread_finished(void)
{
    __atomic_sub_fetch(&live_threads, 1, __ATOMIC_SEQ_CST);
}

int linuxjs_host_threads(void) { return __atomic_load_n(&live_threads, __ATOMIC_SEQ_CST); }
int linuxjs_peak_host_threads(void) { return __atomic_load_n(&peak_threads, __ATOMIC_SEQ_CST); }

static void *thread_trampoline(void *raw)
{
    struct thread_args *a = raw;
    void (*fn)(void *) = a->fn;
    void *arg = a->arg;
    free(a);
    thread_started();
    fn(arg);
    thread_finished();
    return NULL;
}

static long host_thread_create(void (*fn)(void *), void *arg)
{
    struct thread_args *a = malloc(sizeof(*a));
    if (!a) return 0;
    a->fn = fn;
    a->arg = arg;
    pthread_t t;
    int rc = pthread_create(&t, NULL, thread_trampoline, a);
    if (rc != 0) {
        /* LKL turns tid == 0 into BUG_ON(!_next->tid) in __switch_to, far
         * from the cause. Say why here. EAGAIN almost always means the
         * Emscripten worker pool (PTHREAD_POOL_SIZE) is exhausted: new
         * workers can only be spawned by the main JS thread, which is
         * blocked inside linuxjs_boot(). */
        static const char msg[] = "[linux.js] pthread_create failed (worker pool exhausted? raise PTHREAD_POOL_SIZE)\n";
        long w = write(2, msg, sizeof(msg) - 1);
        (void)w;
        free(a);
        return 0;
    }
    /* Left joinable: LKL's kill_thread() joins a dying kernel thread before
     * freeing its semaphore and memory. (Detaching here and making join a
     * no-op caused use-after-free on the semaphore at halt.) */
    return (long)t;
}

static void host_thread_detach(void) { pthread_detach(pthread_self()); }
static void host_thread_exit(void)   { thread_finished(); pthread_exit(NULL); }

static int host_thread_join(lkl_thread_t tid)
{
    pthread_t t = (pthread_t)tid;
    /* lkl_sys_halt() joins the calling host task's own tid. */
    if (pthread_equal(t, pthread_self()))
        return 0;
    return pthread_join(t, NULL) == 0 ? 0 : -1;
}

static void *host_mem_alloc(unsigned long size) { return malloc(size); }
static void  host_mem_free(void *p)             { free(p); }

static unsigned long long host_time(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long long)ts.tv_sec * 1000000000ULL +
           (unsigned long long)ts.tv_nsec;
}

/* Timer = one pthread per active timer. LKL re-arms via timer_set_oneshot. */
struct lkl_timer {
    pthread_t       thread;
    pthread_mutex_t mutex;
    pthread_cond_t  cond;
    void          (*fn)(void);   /* LKL passes a no-arg callback */
    unsigned long   delta_ns;
    int             active;
    int             armed;
};

static void *timer_thread_fn(void *raw)
{
    struct lkl_timer *t = raw;
    thread_started();

    pthread_mutex_lock(&t->mutex);
    while (t->active) {
        if (!t->armed) {
            pthread_cond_wait(&t->cond, &t->mutex);
            continue;
        }

        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        unsigned long long target =
            (unsigned long long)ts.tv_sec * 1000000000ULL +
            (unsigned long long)ts.tv_nsec + t->delta_ns;
        ts.tv_sec  = target / 1000000000ULL;
        ts.tv_nsec = target % 1000000000ULL;

        int rc = pthread_cond_timedwait(&t->cond, &t->mutex, &ts);
        if (rc == ETIMEDOUT && t->armed) {
            t->armed = 0;
            void (*fn)(void) = t->fn;
            pthread_mutex_unlock(&t->mutex);
            /* Must be called with its real type: wasm traps on an
             * indirect call whose signature doesn't match. */
            fn();
            pthread_mutex_lock(&t->mutex);
        }
    }
    pthread_mutex_unlock(&t->mutex);
    thread_finished();
    return NULL;
}

/* Kernel-expected timer_alloc signature: `void (*fn)(void)` with NO arg.
 * The kernel allocates one host timer per kernel timer; the fn is unique
 * to that timer, so the callback knows which timer it is via being a
 * specialized function rather than via an explicit arg. */
static void *host_timer_alloc(void (*fn)(void))
{
    struct lkl_timer *t = malloc(sizeof(*t));
    if (!t) return NULL;
    pthread_mutex_init(&t->mutex, NULL);
    pthread_cond_init(&t->cond, NULL);
    t->fn = fn;
    t->delta_ns = 0;
    t->active = 1;
    t->armed = 0;
    if (pthread_create(&t->thread, NULL, timer_thread_fn, t) != 0) {
        pthread_mutex_destroy(&t->mutex);
        pthread_cond_destroy(&t->cond);
        free(t);
        return NULL;
    }
    return t;
}

static int host_timer_set_oneshot(void *timer, unsigned long delta_ns)
{
    struct lkl_timer *t = timer;
    if (!t) return -1;
    pthread_mutex_lock(&t->mutex);
    t->delta_ns = delta_ns;
    t->armed = 1;
    pthread_cond_signal(&t->cond);
    pthread_mutex_unlock(&t->mutex);
    return 0;
}

static void host_timer_free(void *timer)
{
    struct lkl_timer *t = timer;
    if (!t) return;
    pthread_mutex_lock(&t->mutex);
    t->active = 0;
    t->armed = 0;
    pthread_cond_signal(&t->cond);
    pthread_mutex_unlock(&t->mutex);
    pthread_join(t->thread, NULL);
    pthread_mutex_destroy(&t->mutex);
    pthread_cond_destroy(&t->cond);
    free(t);
}

/* WASM has no MMIO; LKL block devices ride virtio over host ops. */
static void *host_ioremap(long addr, int size) {
    (void)size;
    return (void *)(uintptr_t)addr;
}

static int host_iomem_access(const volatile void *addr, void *val,
                             int size, int write)
{
    (void)addr; (void)val; (void)size; (void)write;
    return 0;
}

/* ─── Additional host ops the kernel's struct requires ───────────── */

#include <string.h>
#include <setjmp.h>
#include <sys/mman.h>

static lkl_thread_t host_thread_self(void) {
    return (lkl_thread_t)(uintptr_t)pthread_self();
}

static int host_thread_equal(lkl_thread_t a, lkl_thread_t b) {
    return pthread_equal((pthread_t)(uintptr_t)a, (pthread_t)(uintptr_t)b);
}

static void *host_thread_stack(unsigned long *size) {
    /* Best-effort. WASM doesn't expose stack info; report a fixed window. */
    static __thread char stack_anchor;
    if (size) *size = 64 * 1024;
    return &stack_anchor;
}

/* TLS via pthread_key. */
struct lkl_tls_key { pthread_key_t key; };

static struct lkl_tls_key *host_tls_alloc(void (*destructor)(void *)) {
    struct lkl_tls_key *k = malloc(sizeof(*k));
    if (!k) return NULL;
    if (pthread_key_create(&k->key, destructor) != 0) { free(k); return NULL; }
    return k;
}
static void host_tls_free(struct lkl_tls_key *k) {
    if (!k) return;
    pthread_key_delete(k->key);
    free(k);
}
static int host_tls_set(struct lkl_tls_key *k, void *data) {
    return k ? pthread_setspecific(k->key, data) : -1;
}
static void *host_tls_get(struct lkl_tls_key *k) {
    return k ? pthread_getspecific(k->key) : NULL;
}

/* Page-aligned allocator (4 KB pages). */
static void *host_page_alloc(unsigned long size) {
    void *p = NULL;
    if (posix_memalign(&p, 4096, size) != 0) return NULL;
    if (p) memset(p, 0, size);
    return p;
}
static void host_page_free(void *addr, unsigned long size) {
    (void)size;
    free(addr);
}

/*
 * setjmp/longjmp for LKL's host-task scheduling.
 *
 * When a host thread gives up the kernel CPU, thread_sched_jb() calls
 * jmp_buf_set(&ti->sched_jb, schedule): save a jump point, then schedule().
 * When that host task is later switched away from, __switch_to() — running
 * on the SAME host thread, inside that schedule() call — longjmps back to
 * the saved point so the thread unwinds out of the kernel. That is a
 * same-thread jump to a live frame, which Emscripten's setjmp/longjmp
 * supports. (The previous stub called pthread_exit() instead; on the main
 * JS thread that became exit(0) right after boot.)
 *
 * __switch_to longjmps through a by-value copy of the buffer; Emscripten's
 * jmp_buf holds only the setjmp invocation id/label, so copies are valid.
 */
_Static_assert(sizeof(jmp_buf) <= sizeof(((struct lkl_jmp_buf *)0)->buf),
               "jmp_buf must fit in struct lkl_jmp_buf");

static void host_jmp_buf_set(struct lkl_jmp_buf *jmpb, void (*f)(void)) {
    if (!setjmp(*(jmp_buf *)jmpb->buf))
        f();
}

static void host_jmp_buf_longjmp(struct lkl_jmp_buf *jmpb, int val) {
    longjmp(*(jmp_buf *)jmpb->buf, val);
}

/* memcpy/memset/memmove — kernel calls these as host ops because it doesn't
 * have a libc. We delegate to the host libc. */
static void *host_memcpy(void *dest, const void *src, unsigned long n)  { return memcpy(dest, src, n); }
static void *host_memset(void *s, int c, unsigned long n)               { return memset(s, c, n); }
static void *host_memmove(void *dest, const void *src, unsigned long n) { return memmove(dest, src, n); }

/* Anonymous mmap. wasm has no real virtual memory — emulate via aligned alloc. */
static void *host_mmap(void *addr, unsigned long size, enum lkl_prot prot) {
    (void)addr; (void)prot;
    return host_page_alloc(size);
}
static int host_munmap(void *addr, unsigned long size) {
    (void)size;
    free(addr);
    return 0;
}

/* shmem — we don't have real shared memory; stub. */
static void host_shmem_init(unsigned long size) { (void)size; }
static void *host_shmem_mmap(void *addr, unsigned long pg_off,
                              unsigned long size, enum lkl_prot prot) {
    (void)addr; (void)pg_off; (void)prot;
    return host_page_alloc(size);
}

static struct lkl_host_operations host_ops = {
    .virtio_devices    = NULL,
    .print             = host_print,
    .panic             = host_panic,

    .sem_alloc         = (struct lkl_sem *(*)(int))host_sem_alloc,
    .sem_free          = (void (*)(struct lkl_sem *))host_sem_free,
    .sem_up            = (void (*)(struct lkl_sem *))host_sem_up,
    .sem_down          = (void (*)(struct lkl_sem *))host_sem_down,

    .mutex_alloc       = (struct lkl_mutex *(*)(int))host_mutex_alloc,
    .mutex_free        = (void (*)(struct lkl_mutex *))host_mutex_free,
    .mutex_lock        = (void (*)(struct lkl_mutex *))host_mutex_lock,
    .mutex_unlock      = (void (*)(struct lkl_mutex *))host_mutex_unlock,

    .thread_create     = (lkl_thread_t (*)(void (*)(void *), void *))host_thread_create,
    .thread_detach     = host_thread_detach,
    .thread_exit       = host_thread_exit,
    .thread_join       = (int (*)(lkl_thread_t))host_thread_join,
    .thread_self       = host_thread_self,
    .thread_equal      = host_thread_equal,
    .thread_stack      = host_thread_stack,

    .tls_alloc         = host_tls_alloc,
    .tls_free          = host_tls_free,
    .tls_set           = host_tls_set,
    .tls_get           = host_tls_get,

    .mem_alloc         = host_mem_alloc,
    .mem_free          = host_mem_free,
    .page_alloc        = host_page_alloc,
    .page_free         = host_page_free,

    .time              = host_time,

    .timer_alloc       = host_timer_alloc,
    .timer_set_oneshot = host_timer_set_oneshot,
    .timer_free        = host_timer_free,

    .ioremap           = host_ioremap,
    .iomem_access      = host_iomem_access,

    .jmp_buf_set       = host_jmp_buf_set,
    .jmp_buf_longjmp   = host_jmp_buf_longjmp,

    .memcpy            = host_memcpy,
    .memset            = host_memset,
    .memmove           = host_memmove,

    .mmap              = host_mmap,
    .munmap            = host_munmap,

    .shmem_init        = host_shmem_init,
    .shmem_mmap        = host_shmem_mmap,

    .pci_ops           = NULL,
};

/* ─── init pipe forwarder ─────────────────────────────────────────── */

/*
 * The host writes raw bytes (commands + newlines) to `input_pipe_write_fd`.
 * Init reads them from `input_pipe_read_fd` as its stdin. Init's stdout/stderr
 * write into `output_ring` via the kernel print hook, which the kernel
 * console driver (CONFIG_SERIAL_LKL_CONSOLE) forwards.
 *
 * On boot we dup `input_pipe_read_fd` over kernel fd 0 of the init task
 * so BusyBox sh inherits it transparently.
 */
static int setup_init_io(void)
{
    int fds[2];
    long ret = lkl_sys_pipe2(fds, 0);
    if (ret < 0) {
        set_error("pipe2 for init stdin failed: %ld", ret);
        return -1;
    }
    input_pipe_read_fd  = fds[0];
    input_pipe_write_fd = fds[1];
    /* Steer init's stdin to the pipe's read end. */
    lkl_sys_dup2(input_pipe_read_fd, 0);
    return 0;
}

/* ─── Exported C ABI ─────────────────────────────────────────────── */

/*
 * Renamed from `lkl_init` to `linuxjs_boot` to avoid collision with the
 * kernel's own `lkl_init(struct lkl_host_operations *)` symbol. wasm-ld
 * would pick one or the other; calls from the kernel side then went
 * through OUR lkl_init with a memory_mb arg → struct pointer cast →
 * crash.
 *
 * The two-step kernel boot is:
 *   1. lkl_init(&host_ops)       // wire up host operations
 *   2. lkl_start_kernel(cmdline) // actually start
 */
int linuxjs_boot(lkl_size_t memory_mb, const char *cmdline)
{
    if (kernel_running) {
        set_error("kernel already initialized");
        return -1;
    }

    /*
     * Build the cmdline without snprintf — that symbol now resolves to
     * the KERNEL's snprintf/vsnprintf (linked in from lib/vsprintf.o
     * after we fixed the thin-archive merge). The kernel's vsnprintf
     * has its own extensions (%pSb, %pe, %pV …) dispatched via function
     * tables that aren't initialized until well into kernel boot — so
     * calling it from our adapter before lkl_init crashes with "null
     * function or function signature mismatch".
     *
     * Hand-format the cmdline using primitives only.
     */
    char full_cmdline[CMDLINE_MAX];
    char *p = full_cmdline;
    char *end = full_cmdline + sizeof(full_cmdline) - 1;

    /* Append literal prefix. */
    const char *prefix = "mem=";
    while (*prefix && p < end) *p++ = *prefix++;

    /* Append memory_mb in decimal. */
    char numbuf[32];
    size_t n = (size_t)memory_mb;
    int ni = 0;
    if (n == 0) {
        numbuf[ni++] = '0';
    } else {
        char tmp[32]; int ti = 0;
        while (n > 0 && ti < 31) { tmp[ti++] = '0' + (n % 10); n /= 10; }
        while (ti > 0) numbuf[ni++] = tmp[--ti];
    }
    for (int i = 0; i < ni && p < end; i++) *p++ = numbuf[i];

    /* Append literal middle. */
    const char *middle = "M console=ttyLKL,earlycon rdinit=/init quiet ";
    while (*middle && p < end) *p++ = *middle++;

    /* Append user-supplied cmdline. */
    if (cmdline) {
        while (*cmdline && p < end) *p++ = *cmdline++;
    }
    *p = '\0';

    /* Step 1: register host operations with LKL. */
    int ret = lkl_init(&host_ops);
    if (ret < 0) {
        set_error("lkl_init failed: %d", ret);
        return -1;
    }

    /* Step 2: actually boot the kernel. */
    /* lkl_start_kernel's first argument is a printf format: never pass
     * the (user-controlled) cmdline as the format itself. */
    ret = lkl_start_kernel("%s", full_cmdline);
    if (ret < 0) {
        set_error("lkl_start_kernel failed: %d", ret);
        return -1;
    }

    /* Standard pseudo-filesystems. rootfs starts empty (no initramfs image
     * is linked in), so create the mount points first. A failure here is
     * logged but not fatal: the filesystem API still works on rootfs. */
    static const struct { const char *dir, *src, *type, *opts; } mounts[] = {
        { "/proc", "proc",     "proc",     NULL },
        { "/sys",  "sysfs",    "sysfs",    NULL },
        { "/dev",  "devtmpfs", "devtmpfs", NULL },
        { "/tmp",  "tmpfs",    "tmpfs",    "mode=1777" },
        { "/run",  "tmpfs",    "tmpfs",    "mode=0755" },
    };
    for (size_t i = 0; i < sizeof(mounts) / sizeof(mounts[0]); i++) {
        long r = lkl_sys_mkdir(mounts[i].dir, 0755);
        if (r < 0 && r != -LKL_EEXIST) {
            lkl_printf("[linux.js] mkdir %s failed: %ld\n", mounts[i].dir, r);
            continue;
        }
        r = lkl_sys_mount(mounts[i].src, mounts[i].dir, mounts[i].type, 0,
                          mounts[i].opts);
        if (r < 0)
            lkl_printf("[linux.js] mount %s on %s failed: %ld\n",
                       mounts[i].type, mounts[i].dir, r);
    }

    if (setup_init_io() < 0) {
        return -1;
    }

    kernel_running = 1;
    return 0;
}

int lkl_send_input(const unsigned char *data, int len)
{
    if (!kernel_running) {
        set_error("kernel not initialized");
        return -1;
    }
    if (input_pipe_write_fd < 0) {
        set_error("init stdin pipe not initialized");
        return -1;
    }
    long ret = lkl_sys_write(input_pipe_write_fd, (void *)data, len);
    if (ret < 0) {
        set_error("write to init stdin failed: %ld", ret);
        return (int)ret;
    }
    return (int)ret;
}

int lkl_drain_output(char *buf, int buf_size)
{
    if (buf_size <= 0 || !buf) return 0;
    return ring_pop(buf, buf_size);
}

/*
 * Write `len` bytes. append == 0 creates/truncates (first chunk of a file),
 * append != 0 appends (subsequent chunks) — the host streams large files in
 * chunks, and truncating on every chunk used to keep only the last one.
 * Loops over short writes; returns bytes written or a negative errno.
 */
int lkl_write_file(const char *path, const unsigned char *data, int len, int append)
{
    if (!kernel_running) { set_error("kernel not initialized"); return -1; }

    int flags = LKL_O_WRONLY | LKL_O_CREAT | (append ? LKL_O_APPEND : LKL_O_TRUNC);
    long fd = lkl_sys_open(path, flags, 0644);
    if (fd < 0) {
        set_error("open(%s) failed: %ld", path, -fd);
        return (int)fd;
    }
    long total = 0;
    while (total < len) {
        long ret = lkl_sys_write(fd, (void *)(data + total), len - total);
        if (ret < 0) {
            set_error("write(%s) failed: %ld", path, -ret);
            lkl_sys_close(fd);
            return (int)ret;
        }
        if (ret == 0) break;
        total += ret;
    }
    lkl_sys_close(fd);
    return (int)total;
}

/*
 * Read up to `len` bytes starting at the 64-bit offset (off_hi:off_lo).
 * Returns bytes read (0 at EOF) or a negative errno. The offset used to be
 * implicit 0, so any file >= one chunk was re-read from the start forever.
 */
int lkl_read_file(const char *path, unsigned char *data, int len,
                  unsigned int off_lo, unsigned int off_hi)
{
    if (!kernel_running) { set_error("kernel not initialized"); return -1; }

    long fd = lkl_sys_open(path, LKL_O_RDONLY, 0);
    if (fd < 0) {
        set_error("open(%s) failed: %ld", path, -fd);
        return (int)fd;
    }
    long long pos = ((long long)off_hi << 32) | off_lo;
    long total = 0;
    while (total < len) {
        long ret = lkl_sys_pread64(fd, data + total, len - total, pos + total);
        if (ret < 0) {
            set_error("read(%s) failed: %ld", path, -ret);
            lkl_sys_close(fd);
            return (int)ret;
        }
        if (ret == 0) break;   /* EOF */
        total += ret;
    }
    lkl_sys_close(fd);
    return (int)total;
}

int lkl_stat(const char *path, int *mode_out, long long *size_out)
{
    if (!kernel_running) { set_error("kernel not initialized"); return -1; }

    unsigned char stx[STATX_BUF_SIZE] __attribute__((aligned(8)));
    long ret = lkl_sys_statx(path, stx);
    if (ret < 0) {
        set_error("stat(%s) failed: %ld", path, -ret);
        return (int)ret;
    }
    uint16_t mode;
    uint64_t size;
    memcpy(&mode, stx + STATX_OFF_MODE, sizeof(mode));
    memcpy(&size, stx + STATX_OFF_SIZE, sizeof(size));
    if (mode_out) *mode_out = (int)mode;
    if (size_out) *size_out = (long long)size;
    return 0;
}

/*
 * Directory listing via lkl_sys_getdents64.
 * We open the directory, read raw dirent records, and serialize entry
 * names into the host buffer as a stream of NUL-terminated strings.
 * Returns bytes used, -1 on error, or -2 if buf_size is too small (the
 * caller retries with a larger buffer).
 */
int lkl_readdir(const char *path, char *entries_buf, int buf_size)
{
    if (!kernel_running) { set_error("kernel not initialized"); return -1; }

    long fd = lkl_sys_open(path, LKL_O_RDONLY | LKL_O_DIRECTORY, 0);
    if (fd < 0) {
        set_error("open(%s) failed: %ld", path, -fd);
        return -1;
    }

    /* Heap, not stack: syscalls run on the caller's (small) stack too. */
    char *raw = malloc(DIRENT_BUF_MAX);
    if (!raw) { lkl_sys_close(fd); set_error("out of memory"); return -1; }
    int written = 0;

    for (;;) {
        long n = lkl_sys_getdents64(fd, (struct lkl_linux_dirent64 *)raw, DIRENT_BUF_MAX);
        if (n < 0) {
            set_error("getdents64(%s) failed: %ld", path, -n);
            written = -1;
            goto done;
        }
        if (n == 0) break;
        for (long off = 0; off < n; ) {
            struct lkl_linux_dirent64 *de = (struct lkl_linux_dirent64 *)(raw + off);
            const char *name = de->d_name;
            int name_len = (int)strlen(name);
            if (name_len > 0 && !(name_len == 1 && name[0] == '.') &&
                !(name_len == 2 && name[0] == '.' && name[1] == '.')) {
                int need = name_len + 1;
                if (written + need > buf_size) {
                    /* Caller's buffer is too small: say so rather than
                     * returning a silently truncated listing. */
                    set_error("readdir(%s): listing exceeds %d bytes", path, buf_size);
                    written = -2;
                    goto done;
                }
                memcpy(entries_buf + written, name, name_len);
                entries_buf[written + name_len] = '\0';
                written += need;
            }
            off += de->d_reclen;
        }
    }

done:
    free(raw);
    lkl_sys_close(fd);
    return written;
}

int lkl_mkdir(const char *path)
{
    if (!kernel_running) { set_error("kernel not initialized"); return -1; }

    long ret = lkl_sys_mkdir(path, 0755);
    if (ret == -LKL_EEXIST) return 0;
    if (ret < 0) {
        /* Try to create parents (mkdir -p semantics). */
        const char *slash = strrchr(path, '/');
        if (slash && slash != path) {
            size_t plen = (size_t)(slash - path);
            char *parent = plen < PATH_BUF_MAX ? malloc(plen + 1) : NULL;
            if (parent) {
                memcpy(parent, path, plen);
                parent[plen] = '\0';
                int prc = lkl_mkdir(parent);
                free(parent);
                if (prc == 0) {
                    ret = lkl_sys_mkdir(path, 0755);
                    if (ret == -LKL_EEXIST) return 0;
                }
            }
        }
    }
    if (ret < 0) {
        set_error("mkdir(%s) failed: %ld", path, -ret);
        return -1;
    }
    return 0;
}

static int rm_recursive(const char *path)
{
    long fd = lkl_sys_open(path, LKL_O_RDONLY | LKL_O_DIRECTORY, 0);
    if (fd < 0) {
        /* Not a directory — treat as file unlink. */
        long u = lkl_sys_unlink(path);
        if (u < 0) {
            set_error("unlink(%s) failed: %ld", path, -u);
            return -1;
        }
        return 0;
    }

    /* Heap buffers: this recurses, and kernel syscalls share the stack. */
    char *raw = malloc(DIRENT_BUF_MAX);
    char *child = malloc(PATH_BUF_MAX);
    int rc = 0;
    if (!raw || !child) {
        set_error("out of memory");
        rc = -1;
        goto out;
    }

    for (;;) {
        long n = lkl_sys_getdents64(fd, (struct lkl_linux_dirent64 *)raw, DIRENT_BUF_MAX);
        if (n < 0) {
            set_error("getdents64(%s) failed: %ld", path, -n);
            rc = -1;
            goto out;
        }
        if (n == 0) break;
        for (long off = 0; off < n; ) {
            struct lkl_linux_dirent64 *de = (struct lkl_linux_dirent64 *)(raw + off);
            const char *name = de->d_name;
            if (!(name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0')))) {
                size_t plen = strlen(path), nlen = strlen(name);
                if (plen + 1 + nlen + 1 > PATH_BUF_MAX) {
                    set_error("path too long under %s", path);
                    rc = -1;
                    goto out;
                }
                memcpy(child, path, plen);
                child[plen] = '/';
                memcpy(child + plen + 1, name, nlen + 1);
                if (rm_recursive(child) < 0) { rc = -1; goto out; }
            }
            off += de->d_reclen;
        }
    }

out:
    free(raw);
    free(child);
    lkl_sys_close(fd);
    if (rc < 0) return rc;

    long r = lkl_sys_rmdir(path);
    if (r < 0) {
        set_error("rmdir(%s) failed: %ld", path, -r);
        return -1;
    }
    return 0;
}

int lkl_rm(const char *path, int recursive)
{
    if (!kernel_running) { set_error("kernel not initialized"); return -1; }
    if (recursive) return rm_recursive(path);

    long ret = lkl_sys_unlink(path);
    if (ret < 0) {
        ret = lkl_sys_rmdir(path);
    }
    if (ret < 0 && ret != -LKL_ENOENT) {
        set_error("rm(%s) failed: %ld", path, -ret);
        return -1;
    }
    return 0;
}

int lkl_mount(const char *source, const char *target,
              const char *fstype, lkl_size_t flags,
              const char *options)
{
    if (!kernel_running) { set_error("kernel not initialized"); return -1; }
    long ret = lkl_sys_mount(source, target, fstype, flags, (void *)options);
    if (ret < 0) {
        set_error("mount(%s, %s, %s) failed: %ld",
                  source, target, fstype, -ret);
        return -1;
    }
    return 0;
}

void lkl_shutdown(void)
{
    if (!kernel_running) return;
    lkl_sys_sync();
    if (input_pipe_write_fd >= 0) { lkl_sys_close(input_pipe_write_fd); input_pipe_write_fd = -1; }
    lkl_sys_halt();
    kernel_running = 0;
}

const char *lkl_get_last_error(void)
{
    return get_error();
}
