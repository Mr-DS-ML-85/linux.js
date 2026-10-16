/*
 * linux.js — LKL WASM adapter (exported C ABI).
 *
 * Functions here are called from the TypeScript bridge via the Emscripten-
 * generated loader. The kernel ABI is documented; the JS side speaks UTF-8
 * pointers and counted byte buffers.
 *
 * License: GPL v2 (this file is linked into the kernel binary).
 */
#ifndef LKL_ADAPTER_H
#define LKL_ADAPTER_H

#include <stddef.h>
#include <stdint.h>

/*
 * Pointer-sized integer for values that cross the JS↔WASM ABI.
 * Using size_t (32-bit under wasm32, 64-bit under -sMEMORY64=1) means
 * the same source compiles correctly for both targets.
 */
typedef size_t lkl_size_t;

/**
 * Boot the LKL kernel.
 *
 * @memory_mb  Kernel RAM in megabytes.
 * @cmdline    Extra command-line parameters appended after the built-in
 *             defaults. May be NULL.
 *
 * On success the kernel runs in "library mode" — the host issues syscalls
 * via lkl_sys_* without a user-space init process. A shell userland (for
 * lkl_send_input / lkl_drain_output) is wired only when a wasm32-musl-elf
 * BusyBox is staged in the initramfs.
 *
 * Returns 0 on success, negative on failure.
 */
/* Renamed from lkl_init to avoid colliding with the kernel's own symbol. */
int linuxjs_boot(lkl_size_t memory_mb, const char *cmdline);

/**
 * Feed bytes into init's stdin (the guest shell).
 *
 * Non-blocking: the host pipe is sized for ~64 KB and writes that fit are
 * acknowledged synchronously. Returns bytes written, or negative on error.
 */
int lkl_send_input(const unsigned char *data, int len);

/**
 * Drain pending console output into the caller's buffer.
 *
 * Returns bytes copied (0 if nothing pending). The internal ring buffer
 * holds up to 1 MB; if it overflows, the oldest bytes are dropped.
 */
int lkl_drain_output(char *buf, int buf_size);

/* ─── File operations (direct lkl_sys_* calls) ─────────────────────── */

int lkl_write_file(const char *path, const unsigned char *data, int len, int append);
int lkl_read_file(const char *path, unsigned char *data, int len,
                  unsigned int off_lo, unsigned int off_hi);
int lkl_stat(const char *path, int *mode_out, long long *size_out);
int lkl_readdir(const char *path, char *entries_buf, int buf_size);
int lkl_mkdir(const char *path);
int lkl_rm(const char *path, int recursive);

/* ─── Filesystem mounting ──────────────────────────────────────────── */

int lkl_mount(const char *source, const char *target,
              const char *fstype, lkl_size_t flags,
              const char *options);

/* ─── Lifecycle ────────────────────────────────────────────────────── */

void lkl_shutdown(void);
const char *lkl_get_last_error(void);

#endif /* LKL_ADAPTER_H */
