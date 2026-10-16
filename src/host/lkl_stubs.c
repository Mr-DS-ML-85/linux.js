/*
 * linux.js — kernel symbol stubs.
 *
 * Library-mode LKL on wasm32 doesn't exercise printk, dump_stack, io_uring,
 * initramfs, or maple-tree iteration. We never call kernel syscalls that
 * would trigger them. But many kernel object files (panic.o, fork.o,
 * init_task.o, softirq.o, etc.) emit relocations against these symbols
 * via transitive dependencies, so wasm-ld demands they be defined.
 *
 * This file provides minimal stubs so the link succeeds. If at runtime
 * one of these is somehow reached, behavior is benign (returns 0 / does
 * nothing). When LKL's own kernel sources are fully built (i.e. when we
 * enable more CONFIG_* options that turn on the real implementations),
 * each weak stub gets overridden by the real symbol.
 *
 * License: GPL v2 (linked into the kernel binary).
 */
#include <stddef.h>
#include <stdint.h>

#ifndef __weak
#define __weak __attribute__((weak))
#endif

typedef long long s64;
typedef long ssize_t;
typedef unsigned long size_t_kernel;

/* ─── lib/ string + parse helpers ────────────────────────────────────── */

__weak int vscnprintf(char *buf, size_t size, const char *fmt, void *args) {
    (void)fmt; (void)args;
    if (buf && size) buf[0] = 0;
    return 0;
}

__weak int scnprintf(char *buf, size_t size, const char *fmt, ...) {
    (void)fmt;
    if (buf && size) buf[0] = 0;
    return 0;
}

__weak char *strnchr(const char *s, size_t count, int c) {
    for (size_t i = 0; i < count && s[i]; i++) if (s[i] == c) return (char *)&s[i];
    return NULL;
}

__weak int get_option(char **str, int *pint) {
    (void)str;
    if (pint) *pint = 0;
    return 0;
}

__weak ssize_t sized_strscpy(char *dest, const char *src, ssize_t size) {
    if (!dest || size <= 0) return 0;
    ssize_t i = 0;
    if (src) for (; i < size - 1 && src[i]; i++) dest[i] = src[i];
    dest[i] = 0;
    return i;
}

__weak unsigned long simple_strtoul(const char *cp, char **endp, unsigned int base) {
    (void)cp; (void)base;
    if (endp) *endp = (char *)cp;
    return 0;
}

__weak int _kstrtoul(const char *s, unsigned int base, unsigned long *res) {
    (void)s; (void)base;
    if (res) *res = 0;
    return 0;
}

/* Returns u64 per kernel ABI, not unsigned long. */
__weak unsigned long long memparse(const char *ptr, char **retptr) {
    if (retptr) *retptr = (char *)ptr;
    return 0;
}

/* ─── lib/ debugging stubs ──────────────────────────────────────────── */

__weak void dump_stack(void) { }
__weak void bust_spinlocks(int yes) { (void)yes; }
__weak void __show_mem(unsigned int filter, void *nodemask, int max_zone_idx) {
    (void)filter; (void)nodemask; (void)max_zone_idx;
}
__weak int  debug_locks_off(void) { return 0; }
__weak int  debug_locks = 0;
__weak void refcount_warn_saturate(void *r, int t) { (void)r; (void)t; }
__weak int  current_is_single_threaded(void) { return 1; }

/* ─── lib/maple_tree.c ──────────────────────────────────────────────── */

__weak void *mas_find(void *mas, unsigned long max) {
    (void)mas; (void)max;
    return NULL;
}

/* ─── io_uring/ subsystem — not enabled in our config ───────────────── */

__weak void __io_uring_free(void *tsk) { (void)tsk; }
__weak void io_uring_unreg_ringfd(void) { }
__weak void __io_uring_cancel(int cancel_all) { (void)cancel_all; }

/* ─── initramfs decompression — not used in library mode ────────────── */

__weak unsigned long __initramfs_size = 0;
__weak char __initramfs_start[1] = { 0 };
__weak const char *decompress_method(const void *inbuf, long len, const char **name) {
    (void)inbuf; (void)len;
    if (name) *name = "none";
    return NULL;
}

/* ─── mm/ kernel allocator stubs ─────────────────────────────────────── */

__weak void  kmem_cache_free(void *cache, void *obj) { (void)cache; (void)obj; }
__weak void *contig_page_data = NULL;
__weak void *mem_map = NULL;
__weak long  vm_node_stat[64];


/* jiffies, init_mm and init_stack used to have weak fallbacks here. They
 * were the wrong size/identity (jiffies must alias jiffies_64, init_stack
 * must alias init_thread_union — see patches 0020/0023) and silently won
 * over the real definitions, so they were removed. */

/* ─── generic 64-bit atomic fallbacks (lib/atomic64.c) ──────────────── */

/*
 * Real atomic implementations using C11 stdatomic.
 * The kernel's lib/atomic64.c provides these properly when built, but
 * if it isn't pulled into liblkl.a our weak stubs win. No-op stubs
 * silently break printk and any other lockless data structure that
 * needs atomic 64-bit ops. Use real atomics so behavior is correct.
 */
#include <stdatomic.h>
__weak void generic_atomic64_or(s64 i, void *v) {
    atomic_fetch_or((_Atomic long long *)v, i);
}
__weak void generic_atomic64_add(s64 i, void *v) {
    atomic_fetch_add((_Atomic long long *)v, i);
}

/* ─── Kernel init machinery stubs (normally from vmlinux.lds.S) ─────── */

/* These functions get called during start_kernel() to set up data
 * structures. Library mode never reaches start_kernel proper, but if
 * symbols are needed for the link they get weak no-op fallbacks. */
__weak void radix_tree_init(void) { }
__weak void maple_tree_init(void) { }

/* Linker-script section bounds. These are NOT the real tables: patch 0024
 * moves initcalls/__setup into C-identifier sections and walks
 * __start_<sec>/__stop_<sec> instead (wasm-ld synthesizes those). The
 * sentinels below only satisfy leftover references such as main.c's
 * initcall_levels[] array, which the wasm path never dereferences. Never
 * iterate between two of them — they are unrelated objects. */
__weak char __setup_start[1]    = { 0 };
__weak char __setup_end[1]      = { 0 };
__weak char __initcall_start[1] = { 0 };
__weak char __initcall_end[1]   = { 0 };
__weak char __initcall0_start[1] = { 0 };
__weak char __initcall1_start[1] = { 0 };
__weak char __initcall2_start[1] = { 0 };
__weak char __initcall3_start[1] = { 0 };
__weak char __initcall4_start[1] = { 0 };
__weak char __initcall5_start[1] = { 0 };
__weak char __initcall6_start[1] = { 0 };
__weak char __initcall7_start[1] = { 0 };
__weak char __initcall0_end[1]   = { 0 };
__weak char __initcall1_end[1]   = { 0 };
__weak char __initcall2_end[1]   = { 0 };
__weak char __initcall3_end[1]   = { 0 };
__weak char __initcall4_end[1]   = { 0 };
__weak char __initcall5_end[1]   = { 0 };
__weak char __initcall6_end[1]   = { 0 };
__weak char __initcall7_end[1]   = { 0 };

/* ─── Empty linker-script tables (tracing) ──────────────────────────── */

/* arch/lkl/Kconfig selects TRACING, so trace code references these
 * vmlinux.lds table bounds, which wasm-ld never emits. Each start/stop
 * pair aliases ONE anchor, so start == stop and every table is provably
 * empty — never give the two bounds separate storage. Event tracing is
 * therefore inert (no trace events are registered). */
char linuxjs_empty_table[1] __attribute__((aligned(8)));
#define LINUXJS_EMPTY_TABLE(start, stop)                                       \
    extern char start[1] __attribute__((weak, alias("linuxjs_empty_table"))); \
    extern char stop[1]  __attribute__((weak, alias("linuxjs_empty_table")));
LINUXJS_EMPTY_TABLE(__start_ftrace_events, __stop_ftrace_events)
LINUXJS_EMPTY_TABLE(__start_ftrace_eval_maps, __stop_ftrace_eval_maps)
LINUXJS_EMPTY_TABLE(__start___trace_bprintk_fmt, __stop___trace_bprintk_fmt)
LINUXJS_EMPTY_TABLE(__start___tracepoint_str, __stop___tracepoint_str)
