# linux.js — kernel patch series

Patches that make upstream LKL (Linux Kernel Library) compile and boot under
WebAssembly with Emscripten on wasm32.

## Where these live (and why they persist)

These files live in **your project repo** at `patches/`. They are NOT inside
`build/`. When you delete `build/` to reclaim space, the next build:

1. Re-clones LKL fresh into `build/lkl/`
2. Runs `patches/apply-lkl-patches.sh` against the fresh tree
3. Applies all patches (0001–0029) in numbered order
4. Compiles the patched kernel

So `rm -rf build/` is safe. What you must back up is `patches/`, `src/`, and
`scripts/` — those define the entire wasm32 LKL port.

## Patch catalogue

| # | Target file(s) | What | Why |
|---|---|---|---|
| 0001 | `tools/lkl/Makefile.autoconf` | Default `OUTPUT=$(CURDIR)/` | Stops absolute `/include` paths |
| 0002 | `scripts/Makefile.clang` | Inject `--target=wasm32-unknown-emscripten` | Stock kernel clang path requires `--target=` |
| 0003 | `tools/lkl/Makefile` | Filter `-finline-limit=0` etc. | Clang doesn't accept GCC-only opt flags |
| 0004 | top-level `Makefile` | Same filter kernel-wide | Same reason |
| 0005 | `scripts/mod/Makefile` | Build `empty.o` with HOSTCC (ELF) | mk_elfconfig can't parse WASM objects |
| 0006 | top-level `Makefile` | Disable LKL fork's `vmlinux.{a,o}` overrides | Override misdispatches to `scripts/Makefile.build` |
| 0007 | top-level `Makefile` | Strip `-Werror=*` kernel-wide | emcc-clang is stricter than GCC |
| 0008 | top-level `Makefile` | Short-circuit `scripts/mod` build | CONFIG_MODULES=n means we don't need it |
| 0009 | `include/linux/jump_label.h` | Force no-jump-label path | wasm has no self-modifying code |
| 0010 | top-level `Makefile` | Filter more GCC-only flags | `-mpreferred-stack-boundary`, etc. |
| 0011 | `include/linux/build_bug.h` | Stub `static_assert` | Struct layout asserts assume 8-byte pointers |
| 0012 | `include/linux/smp.h` | (no-op — superseded by 0015) | |
| 0013 | `include/linux/export.h` | Stub `EXPORT_SYMBOL*` to no-op | Avoids inline-asm `.section` directives |
| 0014 | `include/linux/module.h` | Stub `MODULE_LICENSE`/etc. | Same — avoids GAS data directives |
| 0015 | `include/linux/compiler_attributes.h` | Round `__aligned(x)` up to nearest pow2 | wasm32 has non-pow2 struct sizes that clang rejects |
| 0016 | `arch/lkl/include/asm/unistd.h` | No-op `__SYSCALL_DEFINE_ARCH` | Eliminates `.syscall_defs` asm |
| 0017 | `include/linux/instruction_pointer.h` | Stub `_THIS_IP_` to `0` | Eliminates `&&label` computed gotos |
| 0018 | `include/linux/build_bug.h` | Stub `BUILD_BUG_ON` family | x86_64 struct-size invariants don't hold on wasm32 |
| 0019 | `kernel/printk/printk.c` | Short-circuit `vprintk_store` | wasm32 `unsigned long` breaks printk ringbuffer offset math |
| 0020 | `arch/lkl/kernel/threads.c` | Define `init_thread_union` and `init_stack` | Emscripten doesn't run `vmlinux.lds`; provides valid `current` task during early boot |
| 0021 | `kernel/sched/sched.h` | Explicit sched_class priority table | `vmlinux.lds` normally orders the classes by address; without it `sched_init()` BUG_ONs and panics |
| 0022 | `kernel/printk/printk.c` | Forward printk text to `lkl_ops->print` | 0019 swallowed every message, so panics were silent; honours `console_loglevel` |
| 0023 | `kernel/time/timer.c` | Alias `jiffies` to `jiffies_64` | `vmlinux.lds` normally does it; otherwise `jiffies` never ticks and every timeout hangs |
| 0024 | `include/linux/init.h`, `init/main.c` | Initcall / `__setup` / console-initcall tables in C-identifier sections walked via `__start_`/`__stop_` | wasm-ld synthesizes those bounds; the old 1-byte stub sentinels made `do_initcalls()` call garbage and ignored every boot parameter |
| 0025 | `include/linux/syscalls.h`, `kernel/sys_ni.c`, `arch/lkl/kernel/syscalls.c` | Uniform 6-arg `__wasm6_sys_*` entry points; weak `-ENOSYS` fallbacks; bounds check before table read | LKL called handlers through a variadic pointer — wasm `call_indirect` traps on any signature mismatch |
| 0026 | `include/asm-generic/sections.h` | rodata/data bounds from wasm-ld's `__global_base`/`__data_end` | `kfree_const()` was `kfree()`ing static strings |
| 0027 | `arch/lkl/kernel/stacktrace.c` | `show_stack()` → host `emscripten_get_callstack()` | Frame-pointer walking is meaningless on wasm; WARN/BUG now print named wasm frames |
| 0028 | `include/linux/rcupdate.h`, `rcutiny.h`, `kernel/rcu/{tiny,tree}.c` | Tag kvfree_rcu offsets with the top bit | wasm function pointers are small table indices, so `func < 4096` mistook callbacks for offsets → random frees |
| 0029 | `include/linux/compiler_types.h` | `#pragma weak` for empty linker-script bounds | Lets the final link be strict (no `--allow-undefined`) while empty sections resolve to an empty range |

Note: the kernel must be configured with `# CONFIG_64BIT is not set` (see
`LKL_DEFCONFIG` in `scripts/build-lkl.mjs`). wasm32 has a 32-bit `long`;
LKL's objdump probe picks 64BIT from the host gcc, which made
`BITS_PER_LONG` disagree with `sizeof(long)` and hung boot in the percpu
allocator. Several earlier stubs (0011, 0018, 0019) were likely masking
that mismatch and are candidates for removal once the 32-bit build boots.

## How patches are applied

`apply-lkl-patches.sh` is the canonical applier. Each patch is a bash function
that:
1. Checks if the target file exists
2. Checks if a unique marker (`linuxjs-<patch-id>`) is already in the file
3. If not, applies the change via `sed`/`python3` and verifies the marker

This makes re-runs idempotent and re-clones reproducible.

## Adding a new patch

When boot crashes inside a specific kernel function:

1. Identify which file and what's wrong
2. Add a `patch_<name>` function in `apply-lkl-patches.sh`
3. Add an `apply 00XX-<name> "..." patch_<name>` line at the end
4. Document it in this table

## Patch grade

Patches 0001-0018 are **build-system** patches — they make the kernel compile.
Patches 0019+ are **runtime/boot** patches — they make it boot. Both classes
are necessary; build-system patches are mostly mechanical, runtime patches
are real engineering.

## Long-term roadmap

Several current patches are pragmatic stubs (e.g., 0017 `_THIS_IP_=0`, 0018
`BUILD_BUG_ON()=no-op`, 0019 `vprintk_store` short-circuit). Each has a "real
fix" path noted in the comment, e.g.:

- 0019 → port `prb_data_blk_lpos` to `atomic64_t` so 32-bit `long` is OK
- 0017 → emit indirect-call dispatch instead of `&&label` (clang LLVM IR work)
- 0018 → only stub asserts that genuinely don't apply; keep ones that do

Those upgrades become individual follow-up patches once the kernel boots
end-to-end and we can validate behavior changes against runtime tests.
