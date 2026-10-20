/*
 * linux.js — WASI cwd bootstrap, linked into every userland program.
 *
 * WASI preview1 has no notion of a working directory: wasi-libc emulates
 * one, starting at "/". Programs that never call chdir() don't even link
 * that emulation, so relative and absolute paths resolve identically. This
 * constructor runs before main(), adopts $PWD (set by the linux.js shell
 * for every process) and — by referencing chdir() — links wasi-libc's
 * cwd-aware path resolver.
 *
 * License: MIT.
 */
char *getenv(const char *name);
int chdir(const char *path);

__attribute__((constructor))
static void linuxjs_init_cwd(void)
{
    const char *pwd = getenv("PWD");
    if (pwd && pwd[0] == '/')
        chdir(pwd);
}
