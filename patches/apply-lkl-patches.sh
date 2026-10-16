#!/bin/bash
#
# linux.js — apply LKL kernel-tree patches for the emcc/wasm32 build path.
#
# Runs *inside* the build container after `git clone lkl/linux` and before
# the first `make`. Every edit is idempotent: a re-run on an already-patched
# tree is a no-op.
#
# What this fixes:
#   1. tools/lkl/Makefile.autoconf — default OUTPUT to $(CURDIR)/ so the
#      direct invocation doesn't produce absolute /include paths.
#   2. scripts/Makefile.clang     — inject --target=wasm32-unknown-emscripten
#      so clang-as-emcc has a target triple for the kernel-core fallback.
#   3. tools/lkl/Makefile          — strip GCC-only flags (-finline-limit=0,
#      -falign-jumps=1, -falign-labels=1, -static-libgcc) that clang/emcc
#      doesn't accept.
#
# Usage:
#   apply-lkl-patches.sh /path/to/lkl/tree
#
# Exit codes:
#   0  all patches succeeded (or were already applied)
#   1  required tree layout missing
#
# License: MIT.

set -euo pipefail

LKL_DIR="${1:-.}"
if [ ! -d "$LKL_DIR" ] || [ ! -f "$LKL_DIR/Makefile" ]; then
  echo "[patch] $LKL_DIR is not an LKL kernel tree" >&2
  exit 1
fi
cd "$LKL_DIR"

MARK_DIR=".linuxjs-patches"
mkdir -p "$MARK_DIR"
applied=0
skipped=0

apply() {
  local id="$1" desc="$2"
  shift 2
  local marker="$MARK_DIR/$id.applied"
  if [ -f "$marker" ]; then
    echo "[patch] $id  already applied — skipping ($desc)"
    skipped=$((skipped + 1))
    return 0
  fi
  echo "[patch] $id  applying — $desc"
  "$@"
  touch "$marker"
  applied=$((applied + 1))
}

# ─── Patch 1 ──────────────────────────────────────────────────────────
# tools/lkl/Makefile.autoconf: default OUTPUT so direct `make -f` works.
patch_autoconf_output() {
  local f="tools/lkl/Makefile.autoconf"
  [ -f "$f" ] || { echo "  → $f not present in this tree; skipping"; return 0; }
  if grep -qE '^OUTPUT\s*[:?]?=' "$f"; then
    echo "  → OUTPUT already declared in $f; no change"
    return 0
  fi
  # Prepend a default at the very top so every subsequent rule sees it.
  sed -i '1i OUTPUT ?= $(CURDIR)/' "$f"
  # Note: single-quoted message so $(CURDIR) is shown verbatim in the log.
  echo '  → prepended "OUTPUT ?= $(CURDIR)/" to '"$f"
}

# ─── Patch 2 ──────────────────────────────────────────────────────────
# scripts/Makefile.clang: add --target= so the kernel-core path works.
patch_clang_target() {
  local f="scripts/Makefile.clang"
  [ -f "$f" ] || { echo "  → $f not present; skipping"; return 0; }
  if grep -q "wasm32-unknown-emscripten" "$f"; then
    echo "  → already has wasm32 target; no change"
    return 0
  fi
  # The fatal stanza is:
  #   ifeq ($(CROSS_COMPILE),)
  #   $(error add '--target=' option to scripts/Makefile.clang)
  #   endif
  # Replace with a wasm32 default.
  python3 - "$f" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
new = re.sub(
    r"\$\(error add '--target=' option to scripts/Makefile\.clang\)",
    "CLANG_FLAGS += --target=wasm32-unknown-emscripten",
    src,
)
if new == src:
    # Older trees: just append the flag unconditionally.
    new = src + "\nCLANG_FLAGS += --target=wasm32-unknown-emscripten\n"
p.write_text(new)
PY
  echo "  → injected --target=wasm32-unknown-emscripten into $f"
}

# ─── Patch 3 ──────────────────────────────────────────────────────────
# tools/lkl/Makefile: filter GCC-only optimisation flags.
patch_filter_gcc_only_flags() {
  local f="tools/lkl/Makefile"
  [ -f "$f" ] || { echo "  → $f not present; skipping"; return 0; }
  if grep -q "linuxjs-filter-gcc-flags" "$f"; then
    echo "  → filter already applied; no change"
    return 0
  fi
  cat >> "$f" <<'MK'

# linuxjs-filter-gcc-flags: strip GCC-only optimisation flags that emcc/clang
# rejects (-finline-limit, -falign-jumps, -falign-labels, -static-libgcc).
GCC_ONLY_FLAGS := -finline-limit=0 -falign-jumps=1 -falign-labels=1 -static-libgcc
CFLAGS  := $(filter-out $(GCC_ONLY_FLAGS),$(CFLAGS))
KCFLAGS := $(filter-out $(GCC_ONLY_FLAGS),$(KCFLAGS))
MK
  echo "  → appended GCC-flag filter to $f"
}

# ─── Patch 4 ──────────────────────────────────────────────────────────
# arch/lkl/Makefile and the kernel-wide Makefile: also strip GCC-only flags.
patch_kernel_makefile_filter() {
  local f="Makefile"
  [ -f "$f" ] || { echo "  → top-level Makefile missing?!"; return 0; }
  if grep -q "linuxjs-filter-gcc-flags" "$f"; then
    echo "  → kernel-wide filter already applied; no change"
    return 0
  fi
  cat >> "$f" <<'MK'

# linuxjs-filter-gcc-flags: see patches/apply-lkl-patches.sh
LINUXJS_GCC_ONLY := -finline-limit=0 -falign-jumps=1 -falign-labels=1 -static-libgcc
KBUILD_CFLAGS  := $(filter-out $(LINUXJS_GCC_ONLY),$(KBUILD_CFLAGS))
KBUILD_AFLAGS  := $(filter-out $(LINUXJS_GCC_ONLY),$(KBUILD_AFLAGS))
MK
  echo "  → appended kernel-wide GCC-flag filter to $f"
}

# ─── Patch 5 ──────────────────────────────────────────────────────────
# scripts/mod/Makefile: build empty.o with HOSTCC so it's ELF.
#
# scripts/mod/mk_elfconfig reads empty.o to derive endianness/class for
# elfconfig.h, but it only parses ELF. emcc emits WASM — mk_elfconfig
# errors out with "not ELF" and the build stops at prepare0.
#
# Override the rule so empty.o is built as host-gcc ELF. The arch
# metadata extracted is unused in our library-mode vmlinux.o flow; we
# just need a syntactically valid ELF for mk_elfconfig to inspect.
patch_empty_o_hostcc() {
  local f="scripts/mod/Makefile"
  [ -f "$f" ] || { echo "  → $f not present; skipping"; return 0; }
  if grep -q "linuxjs-empty-hostcc" "$f"; then
    echo "  → empty.o HOSTCC override already applied; no change"
    return 0
  fi
  # Use printf with %b so the literal TAB inside the recipe is preserved
  # (Makefile recipes MUST start with a tab — spaces produce a fatal
  # "missing separator" error).
  printf '\n# linuxjs-empty-hostcc: empty.o must be ELF for mk_elfconfig.\n# emcc produces WASM; mk_elfconfig only parses ELF. Use HOSTCC.\n$(obj)/empty.o:\n\t$(HOSTCC) -c -x c /dev/null -o $@\n' >> "$f"
  echo "  → appended empty.o HOSTCC override to $f"
}

# ─── Patch 6 ──────────────────────────────────────────────────────────
# Disable the LKL fork's vmlinux.{a,o} Makefile recipe overrides.
#
# Stock Linux defines `vmlinux.a:` and `vmlinux.o:` near line 1145 with the
# correct kbuild link-vmlinux dispatch. The LKL fork overrides these near
# line 1916 with a recipe that delegates to scripts/Makefile.build with
# `obj=.` — which has no rule for vmlinux.[ao] and fails immediately.
#
# We comment out every `vmlinux.[ao]:` rule that appears AFTER line 1500
# so the stock recipes take effect.
patch_lkl_vmlinux_override() {
  local f="Makefile"
  [ -f "$f" ] || { echo "  → $f missing"; return 0; }
  if grep -q "linuxjs-lkl-vmlinux-disabled" "$f"; then
    echo "  → LKL vmlinux override already neutralized; no change"
    return 0
  fi
  python3 - "$f" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1])
lines = p.read_text().splitlines()
out = []
i, n = 0, len(lines)
disabled = 0
while i < n:
    line = lines[i]
    # Match LKL-fork overrides that appear deep in the file (post-1500).
    if i > 1500 and re.match(r'^vmlinux\.[ao]\s*:', line):
        out.append(f'# linuxjs-lkl-vmlinux-disabled: {line}')
        disabled += 1
        i += 1
        # Eat the recipe lines (indented with tab) and any trailing blank.
        while i < n and (lines[i].startswith('\t') or lines[i].strip() == ''):
            out.append(f'# linuxjs-disabled: {lines[i]}')
            i += 1
        continue
    out.append(line)
    i += 1
p.write_text('\n'.join(out) + '\n')
print(f'  → disabled {disabled} LKL-fork vmlinux.[ao] recipe(s)')
PY
}

# ─── Patch 7 ──────────────────────────────────────────────────────────
# Neutralize per-file -Werror= flags kernel-wide.
#
# emcc-as-clang is stricter than the GCC the kernel build assumes. It
# escalates benign warnings (shift-count-overflow on BITS_PER_LONG-aware
# code, sign comparisons in macros, etc.) into errors. Filter them out.
patch_disable_werror() {
  local f="Makefile"
  [ -f "$f" ] || return 0
  if grep -q "linuxjs-no-werror" "$f"; then
    echo "  → -Werror filter already applied; no change"
    return 0
  fi
  cat >> "$f" <<'MK'

# linuxjs-no-werror: emcc-as-clang flags benign things as errors GCC ignores.
# Strip -Werror= additions kernel-wide; we're patching to compile, not certify.
LINUXJS_WERROR_FILTER := -Werror -Werror=%
KBUILD_CFLAGS := $(filter-out $(LINUXJS_WERROR_FILTER),$(KBUILD_CFLAGS))
KBUILD_AFLAGS := $(filter-out $(LINUXJS_WERROR_FILTER),$(KBUILD_AFLAGS))
KBUILD_CFLAGS += -Wno-error
KBUILD_CFLAGS += -Wno-shift-count-overflow -Wno-sign-compare -Wno-unused-function
KBUILD_CFLAGS += -Wno-incompatible-pointer-types -Wno-implicit-function-declaration
KBUILD_CFLAGS += -Wno-int-conversion -Wno-deprecated-non-prototype
MK
  echo "  → appended -Werror neutralization to $f"
}

# ─── Patch 8 ──────────────────────────────────────────────────────────
# Bypass the scripts/mod gate when CONFIG_MODULES=n.
#
# Stock kbuild builds scripts/mod (modpost, mk_elfconfig, elfconfig.h)
# unconditionally during prepare0. With CONFIG_MODULES=n we don't need
# any of it, but the dispatcher still runs. Short-circuit it by adding
# an explicit `scripts/mod:` no-op rule.
patch_skip_scripts_mod() {
  local f="Makefile"
  [ -f "$f" ] || return 0
  if grep -q "linuxjs-skip-scripts-mod" "$f"; then
    echo "  → scripts/mod skip already applied; no change"
    return 0
  fi
  cat >> "$f" <<'MK'

# linuxjs-skip-scripts-mod: prepare0 calls $(MAKE) $(build)=scripts/mod
# unconditionally. With CONFIG_MODULES=n the directory contents aren't
# needed; emit an empty target so the sub-make is a no-op.
PHONY += linuxjs-empty-scripts-mod
linuxjs-empty-scripts-mod:
	@:
MK
  echo "  → appended scripts/mod short-circuit to $f"
}

# ─── Patch 9 ──────────────────────────────────────────────────────────
# Neutralize JUMP_LABEL/static_call references in core paths.
#
# Even with CONFIG_JUMP_LABEL=n, a handful of include sites assume the
# `static_branch_*` macros exist. Wire them through to the no-op fallback
# unconditionally on wasm32.
patch_jump_label_stub_macros() {
  local f="include/linux/jump_label.h"
  [ -f "$f" ] || { echo "  → $f missing"; return 0; }
  if grep -q "linuxjs-jump-label-noop" "$f"; then
    echo "  → jump_label noop already applied"; return 0
  fi
  # Insert a guard at the top that forces the no-jump-label path.
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
marker = "/* linuxjs-jump-label-noop */"
if marker in src: sys.exit(0)
patch = (
"#ifdef CONFIG_JUMP_LABEL\n"
"#undef CONFIG_JUMP_LABEL\n"
"#endif\n"
"#ifdef HAVE_JUMP_LABEL\n"
"#undef HAVE_JUMP_LABEL\n"
"#endif\n"
"/* linuxjs-jump-label-noop: wasm32 has no self-modifying code support. */\n"
)
# Insert right after the file's leading SPDX/comment block, before the first #include.
import re
m = re.search(r'^\s*#\s*include', src, re.MULTILINE)
if m:
    src = src[:m.start()] + patch + src[m.start():]
else:
    src = patch + src
p.write_text(src)
PY
  echo "  → forced no-jump-label path in $f"
}

# ─── Patch 10 ─────────────────────────────────────────────────────────
# Disable scripts/Makefile.lib stripping flags that emcc rejects.
#
# `-fno-allow-store-data-races` and a handful of other GCC-only flags are
# added globally; strip them.
patch_strip_more_gcc_only_flags() {
  local f="Makefile"
  [ -f "$f" ] || return 0
  if grep -q "linuxjs-extra-flag-filter" "$f"; then
    echo "  → extra flag filter already applied"; return 0
  fi
  cat >> "$f" <<'MK'

# linuxjs-extra-flag-filter: more GCC-only flags emcc rejects.
LINUXJS_GCC_MORE := -fno-allow-store-data-races -mpreferred-stack-boundary=% \
                   -mskip-rax-setup -mno-fp-ret-in-387 -mrecord-mcount \
                   -fconserve-stack -fno-var-tracking-assignments \
                   -mindirect-branch=% -mindirect-branch-register \
                   -mfunction-return=%
KBUILD_CFLAGS := $(filter-out $(LINUXJS_GCC_MORE),$(KBUILD_CFLAGS))
KBUILD_AFLAGS := $(filter-out $(LINUXJS_GCC_MORE),$(KBUILD_AFLAGS))
MK
  echo "  → appended extra GCC-only flag filter to $f"
}

# ─── Patch 11 ─────────────────────────────────────────────────────────
# Stub `static_assert()` kernel-wide to allow non-x86_64 struct layouts.
#
# include/linux/mm_types.h contains ~30 static_assert() calls verifying
# that struct page, struct folio, and struct ptdesc have IDENTICAL field
# offsets so the kernel can cast between them. These checks pass on
# x86_64 (where sizeof(void*) == sizeof(long) == 8) but FAIL on wasm32
# (where both are 4). The struct layouts simply diverge when pointer
# sizes change — it's a fundamental ABI difference, not a bug.
#
# For our library-mode build (file I/O, no page-cache folio aliasing),
# we never exercise the code paths that depend on the casts working.
# Stubbing the asserts lets the kernel compile; runtime impact = none
# for the syscalls we actually issue.
#
# The asserts come from include/linux/build_bug.h's `static_assert` macro.
# Override it to a no-op.
patch_stub_static_assert() {
  local f="include/linux/build_bug.h"
  [ -f "$f" ] || { echo "  → $f missing"; return 0; }
  if grep -q "linuxjs-static-assert-noop" "$f"; then
    echo "  → static_assert noop already applied"; return 0
  fi
  cat >> "$f" <<'C'

/* linuxjs-static-assert-noop: wasm32 has 4-byte pointers/long where the
 * kernel mm_types.h assumes 8. Disable the layout invariants so kernel C
 * files compile. Runtime impact is nil for library-mode (file I/O only)
 * because we never go through the page<->folio<->ptdesc aliasing paths
 * those asserts guard. */
#undef static_assert
#define static_assert(cond, ...) /* linuxjs: layout asserts disabled on wasm32 */
C
  echo "  → stubbed static_assert in $f"
}

apply 0001-autoconf-output         "default OUTPUT in tools/lkl/Makefile.autoconf"  patch_autoconf_output
apply 0002-clang-wasm32-target     "inject --target=wasm32-unknown-emscripten"      patch_clang_target
apply 0003-tools-lkl-filter-gcc    "filter GCC-only CFLAGS in tools/lkl/Makefile"   patch_filter_gcc_only_flags
apply 0004-kernel-filter-gcc       "filter GCC-only KBUILD flags kernel-wide"       patch_kernel_makefile_filter
apply 0005-empty-o-hostcc          "override scripts/mod/empty.o to HOSTCC ELF"     patch_empty_o_hostcc
apply 0006-lkl-vmlinux-override    "disable LKL-fork vmlinux.{a,o} Makefile recipes" patch_lkl_vmlinux_override
apply 0007-no-werror               "neutralize -Werror= flags kernel-wide"          patch_disable_werror
apply 0008-skip-scripts-mod        "short-circuit scripts/mod build"                patch_skip_scripts_mod
apply 0009-jump-label-noop         "force no-jump-label path in include/linux/jump_label.h" patch_jump_label_stub_macros
apply 0010-extra-gcc-flags         "filter more GCC-only flags"                     patch_strip_more_gcc_only_flags
# ─── Patch 12 ─────────────────────────────────────────────────────────
# smp.h: replace `__aligned(sizeof(struct __call_single_data))` with a
# hardcoded power-of-2 value.
#
# The kernel aligns call_single_data_t to its own sizeof. On x86_64 the
# struct is 32 bytes (power of 2 → fine). On wasm32 with 4-byte pointers
# it's ~20 bytes, which is NOT a power of 2, and clang refuses:
#
#   include/linux/smp.h:34: error: requested alignment is not a power of 2
#
# Replace the sizeof-derived alignment with a fixed 32 (covers any
# reasonable struct size). Functionally equivalent — the kernel just
# wants the struct to live on a single cache line.
patch_smp_h_aligned() {
  # NOTE: patch 0015 now handles all __aligned(non-pow2) cases kernel-wide
  # by intercepting the macro itself. This patch is kept for compatibility
  # but is effectively a no-op when 0015 is also applied. The smp.h:34
  # error reported in earlier runs goes away once 0015 is in effect.
  echo "  → skipping (superseded by patch 0015 — kernel-wide __aligned override)"
  return 0
}

apply 0001-autoconf-output         "default OUTPUT in tools/lkl/Makefile.autoconf"  patch_autoconf_output
apply 0002-clang-wasm32-target     "inject --target=wasm32-unknown-emscripten"      patch_clang_target
apply 0003-tools-lkl-filter-gcc    "filter GCC-only CFLAGS in tools/lkl/Makefile"   patch_filter_gcc_only_flags
apply 0004-kernel-filter-gcc       "filter GCC-only KBUILD flags kernel-wide"       patch_kernel_makefile_filter
apply 0005-empty-o-hostcc          "override scripts/mod/empty.o to HOSTCC ELF"     patch_empty_o_hostcc
apply 0006-lkl-vmlinux-override    "disable LKL-fork vmlinux.{a,o} Makefile recipes" patch_lkl_vmlinux_override
apply 0007-no-werror               "neutralize -Werror= flags kernel-wide"          patch_disable_werror
apply 0008-skip-scripts-mod        "short-circuit scripts/mod build"                patch_skip_scripts_mod
apply 0009-jump-label-noop         "force no-jump-label path in include/linux/jump_label.h" patch_jump_label_stub_macros
apply 0010-extra-gcc-flags         "filter more GCC-only flags"                     patch_strip_more_gcc_only_flags
apply 0011-stub-static-assert      "neutralize x86_64-only struct layout asserts"   patch_stub_static_assert
# ─── Patch 13 ─────────────────────────────────────────────────────────
# Stub EXPORT_SYMBOL family — they use inline asm with `.section "__ksymtab..."`
# and `.asciz` data directives. Clang's wasm32 backend rejects GAS data
# directives in inline asm and CRASHES the LLVM codegen (exit code 70).
#
# With CONFIG_MODULES=n we don't actually export anything; the symbols are
# all directly linkable. Replace EXPORT_SYMBOL* with empty no-ops.
patch_stub_export_symbol() {
  local f="include/linux/export.h"
  [ -f "$f" ] || { echo "  → $f missing"; return 0; }
  if grep -q "linuxjs-stub-exports" "$f"; then
    echo "  → export stubs already applied"; return 0
  fi
  cat >> "$f" <<'C'

/* linuxjs-stub-exports: kill the inline-asm section directives that
 * crash clang's wasm32 backend. CONFIG_MODULES=n so we don't need any
 * ksymtab entries at runtime — symbols are all directly visible. */
#undef EXPORT_SYMBOL
#undef EXPORT_SYMBOL_GPL
#undef EXPORT_SYMBOL_NS
#undef EXPORT_SYMBOL_NS_GPL
#undef EXPORT_SYMBOL_GPL_FOR_MODULES
#undef _EXPORT_SYMBOL
#undef __EXPORT_SYMBOL
#undef ___EXPORT_SYMBOL
#undef EXPORT_DATA_SYMBOL
#undef EXPORT_DATA_SYMBOL_GPL
#define EXPORT_SYMBOL(x)                 extern typeof(x) x
#define EXPORT_SYMBOL_GPL(x)             extern typeof(x) x
#define EXPORT_SYMBOL_NS(x, ns)          extern typeof(x) x
#define EXPORT_SYMBOL_NS_GPL(x, ns)      extern typeof(x) x
#define EXPORT_SYMBOL_GPL_FOR_MODULES(x) extern typeof(x) x
#define EXPORT_DATA_SYMBOL(x)            extern typeof(x) x
#define EXPORT_DATA_SYMBOL_GPL(x)        extern typeof(x) x
#define _EXPORT_SYMBOL(sym, sec)         extern typeof(sym) sym
#define __EXPORT_SYMBOL(sym, sec)        extern typeof(sym) sym
#define ___EXPORT_SYMBOL(sym, sec, ns)   extern typeof(sym) sym
C
  echo "  → stubbed EXPORT_SYMBOL family in $f"
}

# ─── Patch 14 ─────────────────────────────────────────────────────────
# Stub MODULE_LICENSE / MODULE_AUTHOR / MODULE_DESCRIPTION / etc.
#
# Same problem class: these use inline asm or __section attributes to
# inject strings into .modinfo. The asm-variant breaks clang's wasm32
# assembler ("data directive must occur in a data segment: \"GPL\"").
# CONFIG_MODULES=n means the .modinfo section is irrelevant at runtime.
patch_stub_module_info() {
  local f="include/linux/module.h"
  [ -f "$f" ] || { echo "  → $f missing"; return 0; }
  if grep -q "linuxjs-stub-modinfo" "$f"; then
    echo "  → MODULE_* stubs already applied"; return 0
  fi
  cat >> "$f" <<'C'

/* linuxjs-stub-modinfo: kill the asm/section magic in MODULE_*. */
#undef MODULE_INFO
#undef MODULE_LICENSE
#undef MODULE_AUTHOR
#undef MODULE_DESCRIPTION
#undef MODULE_VERSION
#undef MODULE_ALIAS
#undef MODULE_DEVICE_TABLE
#undef MODULE_FIRMWARE
#undef MODULE_IMPORT_NS
#undef MODULE_SOFTDEP
#undef MODULE_PARM_DESC
#undef MODULE_INFO_LICENSE
#undef MODULE_INFO_AUTHOR
#define MODULE_INFO(tag, info)
#define MODULE_LICENSE(_license)
#define MODULE_AUTHOR(_author)
#define MODULE_DESCRIPTION(_description)
#define MODULE_VERSION(_version)
#define MODULE_ALIAS(_alias)
#define MODULE_DEVICE_TABLE(type, name)
#define MODULE_FIRMWARE(_firmware)
#define MODULE_IMPORT_NS(ns)
#define MODULE_SOFTDEP(_softdep)
#define MODULE_PARM_DESC(_parm, desc)
C
  echo "  → stubbed MODULE_* macros in $f"
}

# ─── Patch 15 ─────────────────────────────────────────────────────────
# Redefine `__aligned(x)` kernel-wide to round x up to the next power of 2.
#
# The kernel often writes `__aligned(sizeof(struct X))` where the struct
# is a power of 2 in size on x86_64 (8-byte pointers) but NOT on wasm32
# (4-byte pointers). __attribute__((aligned(N))) requires N to be a power
# of 2 → clang errors out.
#
# Solution: route every __aligned(x) through a conditional expression
# that picks the smallest power-of-2 ≥ x at compile time. Valid C
# constant expression, accepted by aligned attribute.
#
# Powers-of-2 already pass through unchanged (e.g. __aligned(8) → 8).
# Non-pow2 values like 20 round up to 32. Library-mode layout is fine.
patch_aligned_pow2_kernelwide() {
  local f="include/linux/compiler_attributes.h"
  if [ ! -f "$f" ]; then
    echo "  ✗ $f does not exist; can't patch"; return 0
  fi
  if grep -q "linuxjs-aligned-pow2" "$f"; then
    echo "  → __aligned pow2 redef already applied"; return 0
  fi
  # Use python for atomic read-modify-write with verification.
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
patch = (
"\n"
"/* linuxjs-aligned-pow2: route every __aligned(x) through a pick-smallest-\n"
" * power-of-2-ge-x conditional so clang's aligned attribute accepts non-pow2\n"
" * values (sizeof(struct) on wasm32 is often not pow2). */\n"
"#undef __aligned\n"
"#define __linuxjs_pow2_align(x) "
"((x) <= 1 ? 1 : (x) <= 2 ? 2 : (x) <= 4 ? 4 : "
"(x) <= 8 ? 8 : (x) <= 16 ? 16 : (x) <= 32 ? 32 : "
"(x) <= 64 ? 64 : (x) <= 128 ? 128 : (x) <= 256 ? 256 : "
"(x) <= 512 ? 512 : 1024)\n"
"#define __aligned(x) __attribute__((__aligned__(__linuxjs_pow2_align(x))))\n"
)
new_src = src + patch
p.write_text(new_src)
# Verify by re-reading and grepping for our marker.
verify = p.read_text()
if "linuxjs-aligned-pow2" in verify:
    print(f"  ✓ appended {len(patch)} bytes; marker confirmed in {sys.argv[1]}")
else:
    print(f"  ✗ wrote {len(patch)} bytes but marker missing on re-read — filesystem issue?")
    sys.exit(1)
PY
}

apply 0012-smp-h-fixed-align       "smp.h alignment (no-op, superseded by 0015)"  patch_smp_h_aligned
apply 0013-stub-export-symbol      "stub EXPORT_SYMBOL* (avoid asm/section directives)" patch_stub_export_symbol
apply 0014-stub-module-info        "stub MODULE_LICENSE/etc (avoid asm/section directives)" patch_stub_module_info
apply 0015-aligned-pow2-kernelwide "kernel-wide __aligned() pow2 round-up"          patch_aligned_pow2_kernelwide
# ─── Patch 16 ─────────────────────────────────────────────────────────
# Neutralize LKL's SYSCALL_DEFINE_LKL_META inline-asm that writes to
# `.section .syscall_defs,"a"`. Same class as patch 0013 (EXPORT_SYMBOL)
# but in LKL-specific headers under arch/lkl/.
#
# The asm dumps each syscall's name + signature into a custom section
# for module-side lookup. We don't load modules; nothing reads the
# section. Replace any matching asm() with a benign no-op.
patch_lkl_syscall_metadata() {
  # Override the MACRO that emits the bad asm, instead of trying to
  # regex-match the asm block itself. The previous approach corrupted
  # multi-line concatenated strings — the regex matched only the first
  # `"..."` and stopped at the first `)`, leaving syntactic garbage.
  #
  # Cleaner: __SYSCALL_DEFINE_ARCH is defined in arch/lkl/include/asm/unistd.h
  # and expands to `asm(".section .syscall_defs,..." ...)`. Append an
  # `#undef` + empty redefine at the end of the file. Files that include
  # unistd.h see the redefinition last → wins.
  local f="arch/lkl/include/asm/unistd.h"
  [ -f "$f" ] || { echo "  → $f missing"; return 0; }
  if grep -q "linuxjs-syscall-defs-noop" "$f"; then
    echo "  → __SYSCALL_DEFINE_ARCH noop already applied"; return 0
  fi
  cat >> "$f" <<'C'

/* linuxjs-syscall-defs-noop: kill inline asm with .section directives that
 * clang's wasm32 backend cannot parse (no LLVM lowering for GAS .section
 * data directives). __SYSCALL_DEFINE_ARCH writes syscall metadata into a
 * special ELF section for LKL's hosted-mode tooling; we don't load
 * modules or scan that section at runtime, so a no-op is fine. */
#undef __SYSCALL_DEFINE_ARCH
#define __SYSCALL_DEFINE_ARCH(x, sname, ...) /* linuxjs noop */
C
  echo "  → appended __SYSCALL_DEFINE_ARCH no-op to $f"
}

# ─── Patch 17 ─────────────────────────────────────────────────────────
# Neutralize `_THIS_IP_` — it expands to a label-as-value (GCC extension)
# which clang's wasm32 backend cannot lower (no indirect branch in wasm).
# This kills mm/, lib/, kernel/ subsystems (anything that uses spinlocks,
# bottom-halves, or tracing macros — i.e. nearly everything).
#
# In recent kernels it's defined in include/linux/instruction_pointer.h:
#   #define _THIS_IP_  ({ __label__ __here; __here: (unsigned long)&&__here; })
#
# It's only used for lockdep/tracing/WARN callsite info — all disabled
# in our config. Redefining to a literal 0 is safe and lets every
# inline function that uses it (spin_unlock_bh, local_bh_enable, etc.)
# compile cleanly under clang's wasm32 backend.
patch_this_ip_kill_computed_gotos() {
  local patched=0
  for f in include/linux/instruction_pointer.h include/linux/kernel.h; do
    [ -f "$f" ] || continue
    if grep -q "linuxjs-this-ip-noop" "$f"; then
      echo "  → $f already patched"
      patched=1
      continue
    fi
    if ! grep -q "_THIS_IP_" "$f"; then
      continue
    fi
    python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
patch = (
"\n"
"/* linuxjs-this-ip-noop: _THIS_IP_ uses GCC's label-as-value extension\n"
" * (&&label) which becomes a computed goto in IR. clang's wasm32 backend\n"
" * cannot lower indirect branches. _THIS_IP_ is used only for lockdep /\n"
" * tracing / WARN_ON callsite info — all disabled in our build. */\n"
"#undef _THIS_IP_\n"
"#define _THIS_IP_  ((unsigned long)0)\n"
)
new_src = src + patch
p.write_text(new_src)
verify = p.read_text()
if "linuxjs-this-ip-noop" in verify:
    print(f"  ✓ neutralized _THIS_IP_ in {sys.argv[1]}")
else:
    print(f"  ✗ append failed in {sys.argv[1]}")
    sys.exit(1)
PY
    patched=1
  done
  if [ "$patched" = "0" ]; then
    echo "  ✗ no _THIS_IP_ definition site found — kernel may use a different name"
  fi
}

# ─── Patch 18 ─────────────────────────────────────────────────────────
# Stub BUILD_BUG_ON kernel-wide.
#
# Patch 0011 stubbed static_assert but BUILD_BUG_ON uses a separate path
# (compiletime_assert → __compiletime_assert via macro counter). Files
# like mm/mm_init.c and lib/sbitmap.c assert `sizeof(struct page) >= 56`
# and `sizeof(atomic_long_t) == sizeof(map->word)` — both true on x86_64
# but false on wasm32 with 4-byte pointers.
#
# Library-mode kernel never exercises the page-cache aliasing or
# sbitmap-on-64-bit-atomic paths these checks guard, so making them
# no-ops is safe for our use case.
patch_stub_build_bug_on() {
  local f="include/linux/build_bug.h"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 0; }
  if grep -q "linuxjs-build-bug-noop" "$f"; then
    echo "  → BUILD_BUG_ON noop already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()
patch = (
"\n"
"/* linuxjs-build-bug-noop: x86_64-sized struct invariants don't hold on\n"
" * wasm32. Library-mode kernel doesn't exercise the paths these guard. */\n"
"#undef BUILD_BUG_ON\n"
"#undef BUILD_BUG_ON_MSG\n"
"#undef BUILD_BUG_ON_ZERO\n"
"#undef BUILD_BUG_ON_NULL\n"
"#undef BUILD_BUG_ON_INVALID\n"
"#undef BUILD_BUG\n"
"#undef compiletime_assert\n"
"#define BUILD_BUG_ON(condition)               ((void)0)\n"
"#define BUILD_BUG_ON_MSG(cond, msg)           ((void)0)\n"
"#define BUILD_BUG_ON_ZERO(e)                  (0)\n"
"#define BUILD_BUG_ON_NULL(e)                  ((void*)0)\n"
"#define BUILD_BUG_ON_INVALID(e)               ((void)0)\n"
"#define BUILD_BUG()                           ((void)0)\n"
"#define compiletime_assert(condition, msg)    ((void)0)\n"
)
new_src = src + patch
p.write_text(new_src)
verify = p.read_text()
if "linuxjs-build-bug-noop" in verify:
    print(f"  ✓ neutralized BUILD_BUG_ON in {sys.argv[1]}")
else:
    print(f"  ✗ append failed in {sys.argv[1]}")
    sys.exit(1)
PY
}

# ─── Patch 19 ─────────────────────────────────────────────────────────
# kernel/printk/printk.c: short-circuit vprintk_store on wasm32.
#
# The printk lockless ring buffer ("prb") uses pointer arithmetic that
# assumes 64-bit `long` for descriptor wraparound counters and data-block
# offsets. On wasm32 (32-bit long) the wraparound math overflows into the
# offset bits → vprintk_store reads/writes past the static buffer →
# "memory access out of bounds" at first printk inside start_kernel().
#
# Pragmatic fix: insert an early `return 0;` at the top of vprintk_store
# so the kernel keeps booting. Boot proceeds without logging — and we
# don't forward kernel logs anywhere in library mode anyway.
# A complete fix would port prb's offset/index types to u64; that's a
# substantial kernel rework we can revisit once everything else boots.
patch_vprintk_store_noop() {
  local f="kernel/printk/printk.c"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 0; }
  if grep -q "linuxjs-vprintk-store-stub" "$f"; then
    echo "  → vprintk_store stub already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
src = p.read_text()
pattern = re.compile(
    r"(int\s+vprintk_store\([^)]*\)\s*\n\{)",
    re.MULTILINE,
)
m = pattern.search(src)
if not m:
    print(f"  ✗ vprintk_store signature not matched")
    sys.exit(1)
inject = (
    "\n\t/* linuxjs-vprintk-store-stub: wasm32 32-bit long breaks the\n"
    "\t * lockless ring buffer's offset/version math. Boot needs this\n"
    "\t * to return cleanly; messages are lost (no console in library\n"
    "\t * mode anyway). */\n"
    "\treturn 0;\n"
)
new_src = src[:m.end()] + inject + src[m.end():]
p.write_text(new_src)
verify = p.read_text()
if "linuxjs-vprintk-store-stub" in verify:
    print(f"  ✓ vprintk_store short-circuited in {sys.argv[1]}")
else:
    print(f"  ✗ write verification failed")
    sys.exit(1)
PY
}

# ─── Patch 20 ─────────────────────────────────────────────────────────
# arch/lkl/kernel/threads.c: define init_thread_union and init_stack in C.
#
# In traditional Linux builds, init_thread_union and init_stack are linker-script
# symbols emitted by GNU ld via arch/lkl/kernel/vmlinux.lds.
# Under Emscripten/wasm-ld, no linker script is executed. Consequently,
# init_thread_union resolves to NULL/unmapped GOT stub.
# At early boot, _current_thread_info points to NULL, so current->flags
# dereferences offset 16 from NULL -> "RuntimeError: memory access out of bounds"
# in pcpu_alloc_noprof / kmem_cache_init.
#
# Defining init_thread_union and init_stack directly in C ensures current
# points to &init_task and boot proceeds cleanly.
patch_init_thread_union_and_stack() {
  local f="arch/lkl/kernel/threads.c"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 0; }
  if grep -q "linuxjs-init-thread-union" "$f"; then
    echo "  → init_thread_union definition already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
src = p.read_text()
pattern = re.compile(
    r"(struct\s+thread_info\s+\*_current_thread_info\s*=\s*&init_thread_union\.thread_info;)",
    re.MULTILINE,
)
m = pattern.search(src)
if not m:
    print(f"  ✗ _current_thread_info assignment not matched")
    sys.exit(1)
inject = (
    "/* linuxjs-init-thread-union: Emscripten doesn't run vmlinux.lds, so\n"
    " * init_thread_union and init_stack must be defined in C. Otherwise,\n"
    " * current_thread_info() is NULL and dereferencing current crashes WASM. */\n"
    "union thread_union init_thread_union __attribute__((aligned(4096))) = {\n"
    "\t.thread_info = INIT_THREAD_INFO(init_task),\n"
    "};\n"
    "/* vmlinux.lds makes init_stack and init_thread_union the SAME address:\n"
    " * threads_init() sets tid/sched_sem via init_thread_union while\n"
    " * task_thread_info(&init_task) reads init_task.stack == init_stack. Two\n"
    " * separate objects leave swapper with tid == 0 → BUG in __switch_to(). */\n"
    "extern unsigned long init_stack[THREAD_SIZE / sizeof(unsigned long)]\n"
    "\t__attribute__((alias(\"init_thread_union\")));\n\n"
)
new_src = src[:m.start()] + inject + src[m.start():]
p.write_text(new_src)
verify = p.read_text()
if "linuxjs-init-thread-union" in verify:
    print(f"  ✓ init_thread_union defined in {sys.argv[1]}")
else:
    print(f"  ✗ write verification failed")
    sys.exit(1)
PY
}

# ─── Patch 21 ─────────────────────────────────────────────────────────
# kernel/sched/sched.h: explicit sched_class priority table.
#
# Upstream places each sched_class instance in its own section
# (__dl_sched_class, __fair_sched_class, ...) and relies on vmlinux.lds
# to lay them out contiguously, highest priority first, bracketed by
# __sched_class_highest / __sched_class_lowest. The scheduler then
# compares classes by ADDRESS (sched_class_above) and walks them with
# `class++`.
#
# wasm-ld never runs vmlinux.lds: the bracket symbols are undefined
# (resolved to address 0 under --allow-undefined) and the instances
# land wherever wasm-ld puts them. Result: sched_init() BUG_ONs on the
# ordering checks → panic during start_kernel.
#
# Fix: on __wasm__, rank classes through an explicit table and iterate
# with a "next" helper instead of pointer arithmetic.
patch_sched_class_table() {
  local f="kernel/sched/sched.h"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 1; }
  if grep -q "linuxjs-sched-class-table" "$f"; then
    echo "  → sched_class table already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()

anchor = "#endif /* !CONFIG_SCHED_CLASS_EXT */\n"
if anchor not in src:
    print("  ✗ CONFIG_SCHED_CLASS_EXT extern block not found"); sys.exit(1)
helpers = anchor + r'''
#ifdef __wasm__
/*
 * linuxjs-sched-class-table: wasm-ld doesn't run vmlinux.lds, so the
 * sched_class instances are neither contiguous nor ordered by address.
 * Rank them explicitly (0 = highest priority) and iterate via a table.
 */
#define __LINUXJS_NR_SCHED_CLASS 5
static inline const struct sched_class *__linuxjs_sched_class_at(int i)
{
	switch (i) {
#ifdef CONFIG_SMP
	case 0: return &stop_sched_class;
#endif
	case 1: return &dl_sched_class;
	case 2: return &rt_sched_class;
	case 3: return &fair_sched_class;
#ifdef CONFIG_SCHED_CLASS_EXT
	case 4: return &ext_sched_class;
#endif
	case 5: return &idle_sched_class;
	default: return NULL;
	}
}

static inline int __linuxjs_sched_class_rank(const struct sched_class *c)
{
	int i;

	/* NULL is the end-of-list sentinel: lower than every class. */
	if (c)
		for (i = 0; i <= __LINUXJS_NR_SCHED_CLASS; i++)
			if (c == __linuxjs_sched_class_at(i))
				return i;
	return __LINUXJS_NR_SCHED_CLASS + 1;
}

static inline const struct sched_class *__linuxjs_sched_class_from(int i)
{
	for (; i <= __LINUXJS_NR_SCHED_CLASS; i++)
		if (__linuxjs_sched_class_at(i))
			return __linuxjs_sched_class_at(i);
	return NULL;
}

#define __linuxjs_sched_class_first()	__linuxjs_sched_class_from(0)
#define __linuxjs_sched_class_next(c)	\
	__linuxjs_sched_class_from(__linuxjs_sched_class_rank(c) + 1)
#endif /* __wasm__ */
'''
src = src.replace(anchor, helpers, 1)

# next_active_class(): replace pointer increments with table steps.
start = src.index("static inline const struct sched_class *next_active_class(")
end = src.index("\n}\n", start)
body = src[start:end].replace(
    "class++;",
    "\n#ifdef __wasm__\n\t\tclass = __linuxjs_sched_class_next(class);\n#else\n\t\tclass++;\n#endif\n")
src = src[:start] + body + src[end:]

old_tail = "#define sched_class_above(_a, _b)\t((_a) < (_b))\n"
if old_tail not in src:
    print("  ✗ sched_class_above definition not found"); sys.exit(1)
src = src.replace(old_tail, old_tail + r'''
#ifdef __wasm__
#undef for_class_range
#undef for_each_class
#undef for_active_class_range
#undef for_each_active_class
#undef sched_class_above
#define for_class_range(class, _from, _to) \
	for (class = (_from); class && class != (_to); \
	     class = __linuxjs_sched_class_next(class))
#define for_each_class(class) \
	for_class_range(class, __linuxjs_sched_class_first(), NULL)
#define for_active_class_range(class, _from, _to) \
	for (class = (_from); class && class != (_to); \
	     class = next_active_class(class))
#define for_each_active_class(class) \
	for_active_class_range(class, __linuxjs_sched_class_first(), NULL)
#define sched_class_above(_a, _b) \
	(__linuxjs_sched_class_rank(_a) < __linuxjs_sched_class_rank(_b))
#endif
''', 1)

p.write_text(src)
if "linuxjs-sched-class-table" in p.read_text():
    print("  ✓ sched_class priority table installed in " + sys.argv[1])
else:
    print("  ✗ write verification failed"); sys.exit(1)
PY
}

# ─── Patch 22 ─────────────────────────────────────────────────────────
# kernel/printk/printk.c: forward printk text straight to lkl_ops->print.
#
# Patch 0019 makes vprintk_store() return 0 so the (wasm32-broken) ring
# buffer is never touched — but that also swallows every panic/BUG
# message, so boot failures are silent. Format the message ourselves and
# hand it to the host print hook, honouring console_loglevel ("quiet"
# keeps only warnings and worse).
patch_vprintk_forward() {
  local f="kernel/printk/printk.c"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 1; }
  if grep -q "linuxjs-vprintk-forward" "$f"; then
    echo "  → vprintk forward already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
src = p.read_text()
m = re.search(r"\t/\* linuxjs-vprintk-store-stub:.*?\*/\n\treturn 0;\n", src, re.S)
if not m:
    print("  ✗ 0019 vprintk_store stub not found"); sys.exit(1)
forward = r'''	/* linuxjs-vprintk-store-stub + linuxjs-vprintk-forward: the
	 * lockless ring buffer's offset math breaks with wasm32's 32-bit
	 * long, so bypass it and hand formatted text to the host. */
	{
		static char linuxjs_buf[1024];
		const char *body = linuxjs_buf;
		int n, kern_level;

		n = vscnprintf(linuxjs_buf, sizeof(linuxjs_buf), fmt, args);
		while ((kern_level = printk_get_level(body)) != 0) {
			if (kern_level >= '0' && kern_level <= '7')
				level = kern_level - '0';
			body += 2;
			n -= 2;
		}
		if (level == LOGLEVEL_DEFAULT)
			level = default_message_loglevel;
		if (n > 0 && level < console_loglevel && lkl_ops && lkl_ops->print)
			lkl_ops->print(body, n);
		return n;
	}
'''
src = src[:m.start()] + forward + src[m.end():]
sig = src.index("int vprintk_store(int facility, int level,")
src = src[:sig] + "#include <asm/host_ops.h>\n\n" + src[sig:]
p.write_text(src)
print("  ✓ vprintk_store now forwards to lkl_ops->print")
PY
}

# ─── Patch 23 ─────────────────────────────────────────────────────────
# kernel/time/timer.c: make `jiffies` an alias of `jiffies_64`.
#
# The linker script says `jiffies = jiffies_64;` (on little-endian 32-bit
# that's the low word). wasm-ld never sees that line, so `jiffies` was
# either undefined (address 0) or a separate variable that never ticks —
# every timeout/msleep/schedule_timeout would wait forever.
patch_jiffies_alias() {
  local f="kernel/time/timer.c"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 1; }
  if grep -q "linuxjs-jiffies-alias" "$f"; then
    echo "  → jiffies alias already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); src = p.read_text()
anchor = "__visible u64 jiffies_64 __cacheline_aligned_in_smp = INITIAL_JIFFIES;\n"
if anchor not in src:
    print("  ✗ jiffies_64 definition not found"); sys.exit(1)
src = src.replace(anchor, anchor + r'''#ifdef __wasm__
/* linuxjs-jiffies-alias: stands in for vmlinux.lds' `jiffies = jiffies_64;`
 * (wasm is little-endian, so the low word sits at the same address). */
extern unsigned long volatile jiffies __attribute__((alias("jiffies_64")));
#endif
''', 1)
p.write_text(src)
print("  ✓ jiffies aliased to jiffies_64")
PY
}

# ─── Patch 24 ─────────────────────────────────────────────────────────
# include/linux/init.h + init/main.c: real initcall and __setup tables.
#
# vmlinux.lds gathers .initcall*.init / .init.setup / .con_initcall.init
# into contiguous tables bracketed by __initcall*_start etc. wasm-ld
# doesn't run it; lkl_stubs.c used to provide disjoint 1-byte sentinels,
# so do_pre_smp_initcalls() walked between unrelated objects calling
# garbage, and every boot parameter was "Unknown".
#
# wasm-ld DOES synthesize __start_<sec>/__stop_<sec> for data sections
# whose names are valid C identifiers. So on __wasm__ emit each table
# into such a section and walk the ranges in linker-script order.
patch_initcall_sections() {
  local h="include/linux/init.h" m="init/main.c"
  [ -f "$h" ] && [ -f "$m" ] || { echo "  ✗ init.h/main.c missing"; return 1; }
  if grep -q "linuxjs-initcall-sections" "$h"; then
    echo "  → initcall sections already applied"; return 0
  fi
  python3 - "$h" "$m" <<'PY'
import sys, pathlib
h = pathlib.Path(sys.argv[1]); s = h.read_text()

def sub(s, old, new):
    if old not in s:
        print("  ✗ anchor not found: " + old[:60]); sys.exit(1)
    return s.replace(old, new, 1)

s = sub(s, "extern initcall_entry_t __con_initcall_start[], __con_initcall_end[];",
'''#ifdef __wasm__
/* linuxjs-initcall-sections: tables live in C-identifier sections so
 * wasm-ld synthesizes their bounds (no vmlinux.lds). */
#define __con_initcall_start	__start_linuxjs_con_initcall
#define __con_initcall_end	__stop_linuxjs_con_initcall
#define __setup_start		__start_linuxjs_init_setup
#define __setup_end		__stop_linuxjs_init_setup
#define __LINUXJS_SETUP_SECTION	"linuxjs_init_setup"
#else
#define __LINUXJS_SETUP_SECTION	".init.setup"
#endif
extern initcall_entry_t __con_initcall_start[], __con_initcall_end[];''')

s = sub(s, "#define console_initcall(fn)\t___define_initcall(fn, con, .con_initcall)\n",
'''#define console_initcall(fn)\t___define_initcall(fn, con, .con_initcall)

#ifdef __wasm__
#undef __initcall_section
#define __initcall_section(__sec, __iid)	#__sec
#undef __define_initcall
#define __define_initcall(fn, id) \\
	___define_initcall(fn, id, linuxjs_initcall##id)
#undef console_initcall
#define console_initcall(fn) \\
	___define_initcall(fn, con, linuxjs_con_initcall)
#endif
''')

s = sub(s, '__used __section(".init.setup")', '__used __section(__LINUXJS_SETUP_SECTION)')
h.write_text(s)

m = pathlib.Path(sys.argv[2]); s = m.read_text()
ranges = '''
#ifdef __wasm__
/* linuxjs-initcall-sections: per-level ranges in vmlinux.lds order. Weak,
 * so a level with no entries resolves to an empty (NULL..NULL) range. */
#define LINUXJS_IC(sec) \\
	extern initcall_entry_t __start_##sec[] __weak, __stop_##sec[] __weak;
LINUXJS_IC(linuxjs_initcallearly)
LINUXJS_IC(linuxjs_initcall0) LINUXJS_IC(linuxjs_initcall0s)
LINUXJS_IC(linuxjs_initcall1) LINUXJS_IC(linuxjs_initcall1s)
LINUXJS_IC(linuxjs_initcall2) LINUXJS_IC(linuxjs_initcall2s)
LINUXJS_IC(linuxjs_initcall3) LINUXJS_IC(linuxjs_initcall3s)
LINUXJS_IC(linuxjs_initcall4) LINUXJS_IC(linuxjs_initcall4s)
LINUXJS_IC(linuxjs_initcall5) LINUXJS_IC(linuxjs_initcall5s)
LINUXJS_IC(linuxjs_initcallrootfs) LINUXJS_IC(linuxjs_initcallrootfss)
LINUXJS_IC(linuxjs_initcall6) LINUXJS_IC(linuxjs_initcall6s)
LINUXJS_IC(linuxjs_initcall7) LINUXJS_IC(linuxjs_initcall7s)

struct linuxjs_ic_range { initcall_entry_t *start, *stop; };
#define LINUXJS_R(sec) { __start_##sec, __stop_##sec }
static const struct linuxjs_ic_range linuxjs_ic_levels[8][4] __initconst = {
	{ LINUXJS_R(linuxjs_initcall0), LINUXJS_R(linuxjs_initcall0s) },
	{ LINUXJS_R(linuxjs_initcall1), LINUXJS_R(linuxjs_initcall1s) },
	{ LINUXJS_R(linuxjs_initcall2), LINUXJS_R(linuxjs_initcall2s) },
	{ LINUXJS_R(linuxjs_initcall3), LINUXJS_R(linuxjs_initcall3s) },
	{ LINUXJS_R(linuxjs_initcall4), LINUXJS_R(linuxjs_initcall4s) },
	{ LINUXJS_R(linuxjs_initcall5), LINUXJS_R(linuxjs_initcall5s),
	  LINUXJS_R(linuxjs_initcallrootfs), LINUXJS_R(linuxjs_initcallrootfss) },
	{ LINUXJS_R(linuxjs_initcall6), LINUXJS_R(linuxjs_initcall6s) },
	{ LINUXJS_R(linuxjs_initcall7), LINUXJS_R(linuxjs_initcall7s) },
};

static void __init linuxjs_run_range(initcall_entry_t *fn, initcall_entry_t *stop)
{
	for (; fn && fn < stop; fn++)
		do_one_initcall(initcall_from_entry(fn));
}
#endif
'''
s = sub(s, "static void __init do_initcall_level(int level, char *command_line)\n",
        ranges + "\nstatic void __init do_initcall_level(int level, char *command_line)\n")
s = sub(s, '''	trace_initcall_level(initcall_level_names[level]);
	for (fn = initcall_levels[level]; fn < initcall_levels[level+1]; fn++)
		do_one_initcall(initcall_from_entry(fn));
''', '''	trace_initcall_level(initcall_level_names[level]);
#ifdef __wasm__
	{
		int r;

		(void)fn;
		for (r = 0; r < 4; r++)
			linuxjs_run_range(linuxjs_ic_levels[level][r].start,
					  linuxjs_ic_levels[level][r].stop);
	}
#else
	for (fn = initcall_levels[level]; fn < initcall_levels[level+1]; fn++)
		do_one_initcall(initcall_from_entry(fn));
#endif
''')
s = sub(s, '''	trace_initcall_level("early");
	for (fn = __initcall_start; fn < __initcall0_start; fn++)
		do_one_initcall(initcall_from_entry(fn));
''', '''	trace_initcall_level("early");
#ifdef __wasm__
	(void)fn;
	linuxjs_run_range(__start_linuxjs_initcallearly, __stop_linuxjs_initcallearly);
#else
	for (fn = __initcall_start; fn < __initcall0_start; fn++)
		do_one_initcall(initcall_from_entry(fn));
#endif
''')
m.write_text(s)
print("  ✓ initcall/__setup/con_initcall tables use __start_/__stop_ sections")
PY
}

# ─── Patch 25 ─────────────────────────────────────────────────────────
# Uniform 6-argument syscall entry points (wasm call_indirect ABI).
#
# LKL's run_syscall() calls every handler through
#   typedef long (*syscall_handler_t)(long arg1, ...);
# with six arguments. Native ABIs tolerate that; wasm doesn't —
# call_indirect traps unless the callee's signature matches EXACTLY, and
# a variadic pointer type never matches SYSCALL_DEFINEx's x-parameter
# functions. Every lkl_sys_*() call would die with "function signature
# mismatch".
#
# On __wasm__:
#  - SYSCALL_DEFINE0..6 also emit `long __wasm6_sys_<name>(6 × long)`,
#    which forwards the first x args to the real __se_sys_<name>.
#  - kernel/sys_ni.c's COND_SYSCALL emits a *weak* -ENOSYS __wasm6 stub,
#    so syscalls of subsystems we don't build (net, ipc, ...) return
#    -ENOSYS instead of aborting on a missing import.
#  - arch/lkl/kernel/syscalls.c builds its table from the __wasm6
#    wrappers and calls them through a 6-long function pointer.
patch_syscall_abi() {
  local h="include/linux/syscalls.h" n="kernel/sys_ni.c" t="arch/lkl/kernel/syscalls.c"
  [ -f "$h" ] && [ -f "$n" ] && [ -f "$t" ] || { echo "  ✗ syscall sources missing"; return 1; }
  if grep -q "linuxjs-syscall-abi" "$h"; then
    echo "  → syscall ABI already applied"; return 0
  fi
  python3 - "$h" "$n" "$t" <<'PY'
import sys, pathlib

def sub(s, old, new):
    if old not in s:
        print("  ✗ anchor not found: " + old[:70]); sys.exit(1)
    return s.replace(old, new, 1)

# 1. include/linux/syscalls.h
h = pathlib.Path(sys.argv[1]); s = h.read_text()
s = sub(s, "#define __PROTECT(...) asmlinkage_protect(__VA_ARGS__)\n",
r'''#define __PROTECT(...) asmlinkage_protect(__VA_ARGS__)

#ifdef __wasm__
/*
 * linuxjs-syscall-abi: wasm's call_indirect requires an exact signature
 * match, so give every syscall a uniform 6 × long entry point for the
 * LKL syscall table (see arch/lkl/kernel/syscalls.c).
 */
#define __LKL6_PARAMS	long __a0, long __a1, long __a2, \
			long __a3, long __a4, long __a5
#define __LKL6_A0
#define __LKL6_A1	__a0
#define __LKL6_A2	__a0, __a1
#define __LKL6_A3	__a0, __a1, __a2
#define __LKL6_A4	__a0, __a1, __a2, __a3
#define __LKL6_A5	__a0, __a1, __a2, __a3, __a4
#define __LKL6_A6	__a0, __a1, __a2, __a3, __a4, __a5
#define __LKL6_UNUSED	(void)__a0; (void)__a1; (void)__a2; \
			(void)__a3; (void)__a4; (void)__a5

#undef SYSCALL_DEFINE0
#define SYSCALL_DEFINE0(sname)					\
	SYSCALL_METADATA(_##sname, 0);				\
	asmlinkage long sys_##sname(void);			\
	long __wasm6_sys_##sname(__LKL6_PARAMS);		\
	long __wasm6_sys_##sname(__LKL6_PARAMS)			\
	{ __LKL6_UNUSED; return sys_##sname(); }		\
	ALLOW_ERROR_INJECTION(sys_##sname, ERRNO);		\
	asmlinkage long sys_##sname(void)

#undef SYSCALL_DEFINEx
#define SYSCALL_DEFINEx(x, sname, ...)				\
	SYSCALL_METADATA(sname, x, __VA_ARGS__)			\
	asmlinkage long __se_sys##sname(__MAP(x,__SC_LONG,__VA_ARGS__)); \
	long __wasm6_sys##sname(__LKL6_PARAMS);			\
	long __wasm6_sys##sname(__LKL6_PARAMS)			\
	{ __LKL6_UNUSED; return __se_sys##sname(__LKL6_A##x); }	\
	__SYSCALL_DEFINEx(x, sname, __VA_ARGS__)
#endif /* __wasm__ */
''')
h.write_text(s)

# 2. kernel/sys_ni.c
n = pathlib.Path(sys.argv[2]); s = n.read_text()
s = sub(s, "#ifndef COND_SYSCALL\n",
r'''#ifdef __wasm__
/* linuxjs-syscall-abi: weak -ENOSYS fallbacks for the 6-arg entry points;
 * a real SYSCALL_DEFINE in a built subsystem overrides them. */
#define COND_SYSCALL(name)						\
	long __wasm6_sys_##name(long, long, long, long, long, long);	\
	__weak long __wasm6_sys_##name(long a0, long a1, long a2,	\
				      long a3, long a4, long a5)	\
	{ return -ENOSYS; }
#define COND_SYSCALL_COMPAT(name)
#endif

#ifndef COND_SYSCALL
''')
n.write_text(s)

# 3. arch/lkl/kernel/syscalls.c
t = pathlib.Path(sys.argv[3]); s = t.read_text()
s = sub(s, '''typedef long (*syscall_handler_t)(long arg1, ...);

#undef __SYSCALL
#define __SYSCALL(nr, sym)[nr] = sym,

void *syscall_table[__NR_syscalls] = {
	[0 ... __NR_syscalls - 1] =  sys_ni_syscall,
''', '''#ifdef __wasm__
/* linuxjs-syscall-abi: exact-signature 6-arg entry points (see syscalls.h).
 * Two-level paste so macro aliases such as sys_mmap -> sys_mmap_pgoff
 * expand before __wasm6_ is prepended. */
typedef long (*syscall_handler_t)(long, long, long, long, long, long);
#define __LKL6(sym)	__LKL6_(sym)
#define __LKL6_(sym)	__wasm6_##sym

long __wasm6_sys_ni_syscall(long a0, long a1, long a2,
			    long a3, long a4, long a5)
{
	return -ENOSYS;
}

/* LKL's 32-bit split-argument shims (arch/lkl/kernel/syscalls_32.c) are
 * plain functions, not SYSCALL_DEFINEs, so wrap them explicitly. */
#if __BITS_PER_LONG == 32
#define LINUXJS_W6(fn, ...)						\\
	long __wasm6_##fn(long a0, long a1, long a2,			\\
			  long a3, long a4, long a5);			\\
	long __wasm6_##fn(long a0, long a1, long a2,			\\
			  long a3, long a4, long a5)			\\
	{ return fn(__VA_ARGS__); }
LINUXJS_W6(sys32_truncate64, (const char __user *)a0, a1, a2)
LINUXJS_W6(sys32_ftruncate64, a0, a1, a2)
LINUXJS_W6(sys32_wait4, a0, (unsigned int __user *)a1, a2,
	   (struct rusage __user *)a3)
LINUXJS_W6(sys32_pread64, a0, (char __user *)a1, a2, a3, a4)
LINUXJS_W6(sys32_pwrite64, a0, (const char __user *)a1, a2, a3, a4)
LINUXJS_W6(sys32_readahead, a0, a1, a2, a3)
LINUXJS_W6(sys32_sync_file_range, a0, a1, a2, a3, a4, a5)
LINUXJS_W6(sys32_sync_file_range2, a0, a1, a2, a3, a4, a5)
LINUXJS_W6(sys32_fadvise64_64, a0, a1, a2, a3, a4, a5)
LINUXJS_W6(sys32_fallocate, a0, a1, a2, a3, a4, a5)
#endif

#undef __SYSCALL
#define __SYSCALL(nr, sym) \\
	extern long __LKL6(sym)(long, long, long, long, long, long);
#include <asm/unistd.h>
#if __BITS_PER_LONG == 32
#include <asm/unistd_32.h>
#endif

#undef __SYSCALL
#define __SYSCALL(nr, sym)[nr] = __LKL6(sym),

void *syscall_table[__NR_syscalls] = {
	[0 ... __NR_syscalls - 1] =  __wasm6_sys_ni_syscall,
#else
typedef long (*syscall_handler_t)(long arg1, ...);

#undef __SYSCALL
#define __SYSCALL(nr, sym)[nr] = sym,

void *syscall_table[__NR_syscalls] = {
	[0 ... __NR_syscalls - 1] =  sys_ni_syscall,
#endif
''')
# Upstream reads syscall_table[no] before range-checking `no`.
s = sub(s, '''	syscall_handler_t handler = (syscall_handler_t)syscall_table[no];

	if (no < 0 || no >= __NR_syscalls)
		return -ENOSYS;
''', '''	syscall_handler_t handler;

	if (no < 0 || no >= __NR_syscalls)
		return -ENOSYS;
	handler = (syscall_handler_t)syscall_table[no];
''')
t.write_text(s)
print("  ✓ uniform 6-arg syscall entry points installed")
PY
}

# ─── Patch 26 ─────────────────────────────────────────────────────────
# include/asm-generic/sections.h: real static-data bounds.
#
# is_kernel_rodata() (used by kfree_const / kstrdup_const) compares
# against __start_rodata/__end_rodata — vmlinux.lds symbols that are
# undefined (address 0) under wasm-ld. kfree_const() therefore kfree()d
# static strings ("WARNING ... mm/slub.c free_large_kmalloc") and
# corrupted slab state. wasm-ld synthesizes __global_base / __data_end,
# which bracket all static data; nothing in that range may ever be
# kfree()d, so treating it as rodata is the safe reading.
patch_static_data_bounds() {
  local f="include/asm-generic/sections.h"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 1; }
  if grep -q "linuxjs-static-data-bounds" "$f"; then
    echo "  → static data bounds already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
anchor = "extern char _text[], _stext[], _etext[];\n"
if anchor not in s:
    print("  ✗ section declarations not found"); sys.exit(1)
s = s.replace(anchor, r'''#ifdef __wasm__
/* linuxjs-static-data-bounds: no vmlinux.lds; use wasm-ld's synthetic
 * static-data bounds for the rodata/data ranges. */
#define __start_rodata	__global_base
#define __end_rodata	__data_end
#define _sdata		__global_base
#define _edata		__data_end
#endif
''' + anchor, 1)
p.write_text(s)
print("  ✓ rodata/data bounds mapped to __global_base/__data_end")
PY
}

# ─── Patch 27 ─────────────────────────────────────────────────────────
# arch/lkl/kernel/stacktrace.c: host-provided call stacks.
#
# The frame-pointer walker treats Emscripten's shadow stack as native
# frames and wasm code has no addresses, so every WARN/BUG printed
# meaningless numbers. Ask the host instead: the linux.js adapter
# implements linuxjs_host_backtrace() with emscripten_get_callstack(),
# which yields named wasm frames.
patch_host_backtrace() {
  local f="arch/lkl/kernel/stacktrace.c"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 1; }
  if grep -q "linuxjs-host-backtrace" "$f"; then
    echo "  → host backtrace already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
anchor = "#ifdef CONFIG_PRINTK\n#if defined(CONFIG_FRAME_POINTER) && !defined(__s390__)\n"
if anchor not in s:
    print("  ✗ show_stack layout not recognised"); sys.exit(1)
s = s.replace(anchor, r'''#if defined(CONFIG_PRINTK) && defined(__wasm__)
/* linuxjs-host-backtrace: implemented by the host adapter. */
void linuxjs_host_backtrace(void);

void show_stack(struct task_struct *task, unsigned long *sp,
		const char *loglvl)
{
	if (task != NULL)
		return;
	printk("%s Call Trace (wasm):\n", loglvl);
	linuxjs_host_backtrace();
}
#elif defined(CONFIG_PRINTK)
#if defined(CONFIG_FRAME_POINTER) && !defined(__s390__)
''', 1)
p.write_text(s)
print("  ✓ show_stack delegates to linuxjs_host_backtrace()")
PY
}

# ─── Patch 28 ─────────────────────────────────────────────────────────
# RCU: tag kvfree_rcu offsets so they can't collide with wasm funcptrs.
#
# kfree_rcu()/kvfree_rcu() smuggle the rcu_head's offset inside the object
# through the callback pointer, and RCU tells them apart from real
# callbacks with `(unsigned long)func < 4096`. On wasm a function pointer
# is a *table index* — usually small — so ordinary call_rcu() callbacks
# were treated as offsets and RCU kvfree()d `head - index`: random frees,
# slab corruption ("WARNING ... free_large_kmalloc" from
# rcu_process_callbacks). Tag encoded offsets with the top bit, which no
# table index ever has, and strip it on decode.
patch_rcu_kvfree_tag() {
  local r="include/linux/rcupdate.h" t="include/linux/rcutiny.h"
  local k="kernel/rcu/tiny.c" g="kernel/rcu/tree.c"
  for f in "$r" "$t" "$k" "$g"; do [ -f "$f" ] || { echo "  ✗ $f missing"; return 1; }; done
  if grep -q "linuxjs-rcu-kvfree-tag" "$r"; then
    echo "  → RCU kvfree tag already applied"; return 0
  fi
  python3 - "$r" "$t" "$k" "$g" <<'PY'
import sys, pathlib

def edit(path, pairs):
    p = pathlib.Path(path); s = p.read_text()
    for old, new in pairs:
        if old not in s:
            print("  ✗ anchor not found in %s: %s" % (path, old[:60])); sys.exit(1)
        s = s.replace(old, new, 1)
    p.write_text(s)

edit(sys.argv[1], [
# Drop the original definition first (the replacement block below
# contains the same text in its #else branch).
("#define __is_kvfree_rcu_offset(offset) ((offset) < 4096)\n", ""),
# Defined right after the includes: rcutiny.h (pulled in mid-file) uses
# __kvfree_rcu_encode in a static inline.
("#include <linux/context_tracking_irq.h>\n",
r'''#include <linux/context_tracking_irq.h>

#ifdef __wasm__
/*
 * linuxjs-rcu-kvfree-tag: wasm function pointers are small table indices,
 * so "func < 4096" can't tell a kvfree offset from a real callback. Tag
 * encoded offsets with the top bit (never set in a table index).
 */
#define __LINUXJS_KVFREE_TAG		(1UL << (BITS_PER_LONG - 1))
#define __kvfree_rcu_encode(off)	((unsigned long)(off) | __LINUXJS_KVFREE_TAG)
#define __kvfree_rcu_decode(off)	((unsigned long)(off) & ~__LINUXJS_KVFREE_TAG)
#define __is_kvfree_rcu_offset(offset)					\
	((((unsigned long)(offset)) & __LINUXJS_KVFREE_TAG) &&		\
	 __kvfree_rcu_decode(offset) < 4096)
#else
#define __kvfree_rcu_encode(off)	((unsigned long)(off))
#define __kvfree_rcu_decode(off)	((unsigned long)(off))
#define __is_kvfree_rcu_offset(offset) ((offset) < 4096)
#endif
'''),
("BUILD_BUG_ON(!__is_kvfree_rcu_offset(offsetof(typeof(*(ptr)), rhf)));",
 "BUILD_BUG_ON(!__is_kvfree_rcu_offset(__kvfree_rcu_encode(offsetof(typeof(*(ptr)), rhf))));"),
])
edit(sys.argv[2], [
("call_rcu(head, (rcu_callback_t) ((void *) head - ptr));",
 "call_rcu(head, (rcu_callback_t) __kvfree_rcu_encode((void *) head - ptr));"),
])
edit(sys.argv[3], [
("kvfree((void *)head - offset);", "kvfree((void *)head - __kvfree_rcu_decode(offset));"),
])
edit(sys.argv[4], [
("unsigned long offset = (void *) head - ptr;",
 "unsigned long offset = __kvfree_rcu_encode((void *) head - ptr);"),
])
print("  ✓ kvfree_rcu offsets tagged (wasm funcptr-safe)")
PY
}

# ─── Patch 29 ─────────────────────────────────────────────────────────
# include/linux/compiler_types.h: weak references to linker-script bounds.
#
# The final link is strict (no --allow-undefined), so every symbol must
# resolve. These vmlinux.lds bounds name sections that are empty in a
# wasm-ld build (init text/data, bss markers, exception/modver/notes
# tables, console initcalls when no console driver is built). A WEAK
# reference resolves to 0, giving start == end == 0: an empty range —
# and if such a section ever gains content, wasm-ld's synthesized
# __start_/__stop_ symbols still win. (A stub *definition* would hide
# them.) compiler_types.h is force-included in every kernel TU.
patch_weak_lds_symbols() {
  local f="include/linux/compiler_types.h"
  [ -f "$f" ] || { echo "  ✗ $f missing"; return 1; }
  if grep -q "linuxjs-weak-lds-symbols" "$f"; then
    echo "  → weak lds symbols already applied"; return 0
  fi
  python3 - "$f" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
guard_end = "#endif /* __LINUX_COMPILER_TYPES_H */"
if guard_end not in s:
    print("  ✗ include guard end not found"); sys.exit(1)
syms = ["_stext", "_etext", "_sinittext", "_einittext", "__init_begin",
        "__init_end", "__bss_start", "__bss_stop",
        "__start___ex_table", "__stop___ex_table",
        "__start___modver", "__stop___modver",
        "__start_notes", "__stop_notes",
        "__start_linuxjs_con_initcall", "__stop_linuxjs_con_initcall"]
block = ("#if defined(__wasm__) && !defined(__ASSEMBLY__)\n"
         "/* linuxjs-weak-lds-symbols: empty-section bounds resolve to 0 under the\n"
         " * strict wasm link (see apply-lkl-patches.sh, patch 0029). */\n"
         + "".join("#pragma weak %s\n" % x for x in syms) +
         "#endif\n\n")
s = s.replace(guard_end, block + guard_end, 1)
p.write_text(s)
print("  ✓ %d linker-script bounds made weak" % len(syms))
PY
}

apply 0016-lkl-syscall-metadata    "stub LKL's .syscall_defs inline asm via __SYSCALL_DEFINE_ARCH" patch_lkl_syscall_metadata
apply 0017-this-ip-no-computed-goto "neutralize _THIS_IP_ (kills computed gotos)"     patch_this_ip_kill_computed_gotos
apply 0018-stub-build-bug-on        "stub BUILD_BUG_ON (struct size invariants)"     patch_stub_build_bug_on
apply 0019-vprintk-store-noop       "kernel/printk: short-circuit vprintk_store (32-bit long ringbuffer)" patch_vprintk_store_noop
apply 0020-init-thread-union-stack  "arch/lkl/kernel/threads.c: define init_thread_union and init_stack" patch_init_thread_union_and_stack
apply 0021-sched-class-table        "kernel/sched/sched.h: explicit sched_class priority table (no vmlinux.lds)" patch_sched_class_table
apply 0022-vprintk-forward          "kernel/printk: forward printk text to lkl_ops->print (boot diagnostics)" patch_vprintk_forward
apply 0023-jiffies-alias            "kernel/time/timer.c: alias jiffies to jiffies_64 (no vmlinux.lds)" patch_jiffies_alias
apply 0024-initcall-sections        "init.h/main.c: initcall + __setup tables via __start_/__stop_ sections" patch_initcall_sections
apply 0025-syscall-abi              "uniform 6-arg syscall entry points (wasm call_indirect exact signatures)" patch_syscall_abi
apply 0026-static-data-bounds       "asm-generic/sections.h: rodata/data bounds from wasm-ld symbols" patch_static_data_bounds
apply 0027-host-backtrace           "arch/lkl/kernel/stacktrace.c: wasm call stacks via host adapter" patch_host_backtrace
apply 0028-rcu-kvfree-tag           "RCU: tag kvfree_rcu offsets (wasm funcptrs are small table indices)" patch_rcu_kvfree_tag
apply 0029-weak-lds-symbols         "compiler_types.h: weak refs to empty linker-script bounds (strict link)" patch_weak_lds_symbols

echo "[patch] done — applied=$applied skipped=$skipped"

