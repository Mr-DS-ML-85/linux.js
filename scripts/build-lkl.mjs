#!/usr/bin/env node

/**
 * linux.js — LKL kernel → WebAssembly build.
 *
 * Modes:
 *   --download            Fetch a published lkl.wasm from the GitHub release.
 *   --wasm64              Build a 64-bit linear-memory variant (lkl.wasm64.{wasm,js}).
 *                         Default is wasm32. Pass both if you want both.
 *   --skip-kernel         Skip the kernel build (use a previously built liblkl.a).
 *   --skip-emcc-link      Skip the final emcc link step (build artifacts only).
 *   --keep-build          Keep intermediate build artifacts on success (default: keep).
 *
 * Stage map (with concrete failure recovery):
 *   1. Docker emsdk image                       (download or build emsdk-lkl tag)
 *   2. Sources                                  (clone lkl/linux)
 *   3. Initramfs scaffolding                    (placeholder /init — see note below)
 *   4. LKL autoconf                             (autogen.sh + configure with emcc env)
 *   5. liblkl.a                                 (make CC=emcc HOSTCC=gcc -j)
 *   6. Final emcc link of adapter + liblkl.a    (produces lkl.wasm / lkl.wasm64.wasm)
 *   7. Copy artifacts to repo root
 *
 * On userland (BusyBox):
 *   Stock BusyBox cannot be linked by emcc — emcc emits WebAssembly modules,
 *   but LKL's binfmt_elf can only load ELF binaries. A real shell userland
 *   therefore needs a wasm32-musl-elf cross toolchain (separate from emcc).
 *   This script no longer attempts the impossible emcc-link of busybox; it
 *   stages an empty initramfs so the kernel can boot in "library mode"
 *   (LKL's intended use: kernel runs, the host issues lkl_sys_*).
 *   The shell-userland step is tracked as a follow-up.
 *
 * License: MIT for this script. Output artifacts are GPL v2.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BUILD_DIR = join(ROOT, 'build');
const LKL_SRC = join(BUILD_DIR, 'lkl');
const INITRAMFS_DIR = join(BUILD_DIR, 'initramfs');
const HOST_SRC = join(ROOT, 'src', 'host');

const CONFIG = {
  // Overridable so you can swap in a wasm-patched fork without editing the script.
  //   LKL_REPO=https://github.com/your/wasm-lkl.git \
  //   LKL_BRANCH=wasm32 \
  //   node scripts/build-lkl.mjs
  lklRepo:   process.env.LKL_REPO   ?? 'https://github.com/lkl/linux.git',
  lklBranch: process.env.LKL_BRANCH ?? 'master',
  prebuiltBaseUrl:
    process.env.LINUXJS_PREBUILT_BASE ??
    'https://github.com/linux-js/linux.js/releases/download/v0.4.0',
};

const { values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    download:        { type: 'boolean', short: 'd', default: false },
    wasm64:          { type: 'boolean', default: false },
    'skip-kernel':   { type: 'boolean', default: false },
    'skip-emcc-link':{ type: 'boolean', default: false },
    'keep-build':    { type: 'boolean', default: true },
  },
});

function log(msg)  { console.log(`  → ${msg}`); }
function ok(msg)   { console.log(`  ✔ ${msg}`); }
function warn(msg) { console.warn(`  ⚠ ${msg}`); }
function fail(msg) { console.error(`  ✖ ${msg}`); }

function run(cmd, runOpts = {}) {
  console.log(`  $ ${cmd}`);
  const res = spawnSync(cmd, {
    shell: true,
    cwd: runOpts.cwd ?? ROOT,
    stdio: 'inherit',
    env: process.env,
    ...runOpts,
  });
  if (res.status !== 0 && !runOpts.ignoreError) {
    fail(`command failed (exit ${res.status}): ${cmd}`);
    process.exit(res.status ?? 1);
  }
  return res;
}

/**
 * Docker `--user` flag so files created in the container belong to the
 * invoking host user, not root. Avoids the EACCES we hit when subsequent
 * host-side writes try to touch root-owned tree.
 */
function dockerUserFlag() {
  if (process.platform !== 'linux') return '';
  try {
    const uid = execSync('id -u').toString().trim();
    const gid = execSync('id -g').toString().trim();
    return `--user ${uid}:${gid}`;
  } catch {
    return '';
  }
}

function checkTool(name, hint) {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    fail(`required tool missing: ${name}`);
    console.error(`    ${hint}`);
    return false;
  }
}

async function downloadFile(url, destAbs) {
  return new Promise((resolve, reject) => {
    const dir = dirname(destAbs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    console.log(`  ↓ ${url}`);
    const out = createWriteStream(destAbs);
    const proto = url.startsWith('https') ? 'https' : 'http';

    import(`node:${proto}`).then(({ default: mod }) => {
      mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          out.close();
          downloadFile(res.headers.location, destAbs).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          out.close();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const total = Number.parseInt(res.headers['content-length'] ?? '0', 10);
        let got = 0;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total > 0) process.stdout.write(`\r    ${Math.round((got / total) * 100)}%`);
        });
        res.pipe(out);
        out.on('finish', () => { out.close(); process.stdout.write('\n'); resolve(); });
      }).on('error', (err) => { out.close(); reject(err); });
    }, reject);
  });
}

async function downloadPrebuilt() {
  log('Downloading prebuilt LKL WASM artifacts...');
  const files = opts.wasm64
    ? ['lkl.wasm64.wasm', 'lkl.wasm64.js']
    : ['lkl.wasm', 'lkl.js', 'lkl.worker.js'];
  for (const name of files) {
    const dest = join(ROOT, name);
    if (existsSync(dest)) { ok(`${name} (already present)`); continue; }
    try {
      await downloadFile(`${CONFIG.prebuiltBaseUrl}/${name}`, dest);
      ok(name);
    } catch (err) {
      if (name === 'lkl.worker.js') {
        warn(`${name} not available (single-file pthread build — that's fine)`);
      } else {
        fail(`failed to download ${name}: ${err.message}`);
        process.exit(1);
      }
    }
  }
  console.log('\n✅ Prebuilt artifacts ready.\n');
}

/* ── LKL kernel config ────────────────────────────────────────────────
 *
 * Library mode: no init, no userspace. Kernel boots and the host issues
 * lkl_sys_* calls. This gives us a working real-Linux VFS today; the shell
 * userland needs a wasm32-musl-elf binary, which is a separate toolchain
 * problem (not solvable with emcc).
 */
/*
 * Aggressive minimum kernel config.
 *
 * Strategy: every subsystem with inline asm, self-modifying code, or
 * hardware-specific assumptions is disabled. The kernel boots into
 * library mode with just enough to expose lkl_sys_* against ext4 and
 * the basic VFS. Networking + extras get re-enabled in a later config
 * variant once the base build is green.
 *
 * Every `# CONFIG_X is not set` line is the canonical Kconfig form for
 * "off" — `olddefconfig` honors it. The unset comments matter for
 * choice groups (Kconfig's `if-then-else`) where leaving the variable
 * undefined would trigger an interactive prompt.
 */
const LKL_DEFCONFIG = `
# ─── core LKL switches ────────────────────────────────────────────
CONFIG_AUTO_LKL_POSIX_HOST=y
CONFIG_LKL_LINE_DISCIPLINE=y
CONFIG_EMBEDDED=y
CONFIG_EXPERT=y
CONFIG_PRINTK=y
# wasm32 is an ILP32 target: long and pointers are 32 bits. LKL derives
# 64BIT from objdump's view of a $CC-compiled object, and olddefconfig
# runs with the host gcc (elf64) → CONFIG_64BIT=y → BITS_PER_LONG=64
# while sizeof(long)=4. That corrupts every bitmap/find_bit/hash/atomic
# computation (boot hangs in pcpu_alloc_area). Force 32-bit.
# CONFIG_64BIT is not set
# wasm32 has no native 64-bit atomic ops; pull in the generic C fallbacks
# (provides generic_atomic64_or, generic_atomic64_add, etc.).
CONFIG_GENERIC_ATOMIC64=y
CONFIG_TMPFS=y
CONFIG_PROC_FS=y
CONFIG_SYSFS=y
CONFIG_SHMEM=y
CONFIG_RAMFS=y
CONFIG_DEVTMPFS=y
CONFIG_DEVTMPFS_MOUNT=y
CONFIG_EXT4_FS=y
CONFIG_BLOCK=y
CONFIG_BLK_DEV_INITRD=y
CONFIG_SERIAL_LKL_CONSOLE=y

# ─── not built / not usable under wasm-ld ────────────────────────
# VT needs a console driver (dummycon/fbcon) and the input layer, none of
# which we build: con_init() calls a NULL conswitchp at boot.
# CONFIG_VT is not set
# CONFIG_INPUT is not set
# io_uring/ isn't in the subsystem walk; leaving it on dangles io_uring_*.
# CONFIG_IO_URING is not set
# kallsyms tables are produced by a multi-pass vmlinux link that
# wasm-ld never runs; with it on, symbolization reads address-0 data.
# CONFIG_KALLSYMS is not set

# ─── modules: off (avoids scripts/mod elfconfig.h gate) ───────────
# CONFIG_MODULES is not set
# CONFIG_MODULE_SIG is not set
# CONFIG_MODULE_COMPRESS is not set

# ─── tracing / instrumentation (all use inline asm / self-mod code) ─
# CONFIG_FTRACE is not set
# CONFIG_FUNCTION_TRACER is not set
# CONFIG_KPROBES is not set
# CONFIG_BPF is not set
# CONFIG_BPF_SYSCALL is not set
# CONFIG_BPF_JIT is not set
# CONFIG_PERF_EVENTS is not set
# CONFIG_TRACING is not set
# CONFIG_GENERIC_TRACER is not set
# CONFIG_HAVE_JUMP_LABEL is not set
# CONFIG_JUMP_LABEL is not set
# CONFIG_HAVE_STATIC_CALL is not set
# CONFIG_STATIC_KEYS_SELFTEST is not set

# ─── memory debugging (KASAN etc. need shadow memory we don't have) ─
# CONFIG_KASAN is not set
# CONFIG_KFENCE is not set
# CONFIG_KMSAN is not set
# CONFIG_UBSAN is not set
# CONFIG_KCSAN is not set
# CONFIG_DEBUG_KMEMLEAK is not set
# CONFIG_DEBUG_PAGEALLOC is not set
# CONFIG_PAGE_POISONING is not set
# CONFIG_SLUB_DEBUG is not set
# CONFIG_SLAB_FREELIST_HARDENED is not set
# CONFIG_SLAB_FREELIST_RANDOM is not set

# ─── kernel hardening (stack protector wants libgcc symbols emcc lacks) ─
# CONFIG_STACKPROTECTOR is not set
# CONFIG_STACKPROTECTOR_STRONG is not set
# CONFIG_RANDOMIZE_KSTACK_OFFSET is not set
# CONFIG_RANDOMIZE_KSTACK_OFFSET_DEFAULT is not set
CONFIG_INIT_STACK_NONE=y
# CONFIG_INIT_ON_ALLOC_DEFAULT_ON is not set
# CONFIG_INIT_ON_FREE_DEFAULT_ON is not set
CONFIG_RANDSTRUCT_NONE=y
# CONFIG_RANDSTRUCT_FULL is not set
# CONFIG_RANDSTRUCT_PERFORMANCE is not set
# CONFIG_GCC_PLUGINS is not set

# ─── Rust support (separate toolchain, not relevant) ──────────────
# CONFIG_RUST is not set

# ─── networking: off in v1 (we re-enable virtio-net later) ────────
# CONFIG_NET is not set
# CONFIG_INET is not set

# ─── compression: kernel image isn't being compressed by us ───────
CONFIG_KERNEL_NONE=y
# CONFIG_KERNEL_GZIP is not set
# CONFIG_KERNEL_BZIP2 is not set
# CONFIG_KERNEL_LZMA is not set
# CONFIG_KERNEL_XZ is not set
# CONFIG_KERNEL_LZO is not set
# CONFIG_KERNEL_LZ4 is not set
# CONFIG_KERNEL_ZSTD is not set

# ─── debug info: off (large + needs DWARF emit emcc handles oddly) ─
# CONFIG_DEBUG_INFO is not set
# CONFIG_DEBUG_INFO_DWARF4 is not set
# CONFIG_GDB_SCRIPTS is not set

# ─── unused FS: trim everything except ext4 + the in-mem ones ─────
# CONFIG_BTRFS_FS is not set
# CONFIG_XFS_FS is not set
# CONFIG_F2FS_FS is not set
# CONFIG_NTFS3_FS is not set
# CONFIG_NFS_FS is not set
# CONFIG_CIFS is not set
`.trim();

/* ── Placeholder /init ───────────────────────────────────────────────
 *
 * The kernel mounts an initramfs even in library mode (build config
 * requirement). The /init "binary" is just a marker — kernel never runs
 * it because lkl_start_kernel returns to the host before user-space PID 1.
 */
const INIT_PLACEHOLDER = '#!/usr/bin/false\n# linux.js placeholder — kernel boots in library mode.\n';

/* ── Dockerfile for the emcc + kernel build environment ─────────────── */
const DOCKERFILE = `
FROM emscripten/emsdk:latest
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \\
    bc bison flex cpio file gcc libelf-dev kmod python3 rsync \\
    autoconf automake libtool pkg-config make \\
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
CMD ["/bin/bash"]
`.trim();

async function buildFromSource() {
  const variant = opts.wasm64 ? 'wasm64' : 'wasm32';
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  linux.js — LKL kernel → WebAssembly                     ║
║  Variant: ${variant.padEnd(48)}║
║  License: MIT (script) / GPL v2 (kernel artifacts)        ║
╚══════════════════════════════════════════════════════════╝
`);

  if (!checkTool('docker', 'install Docker: https://docs.docker.com/get-docker/') ||
      !checkTool('git',    'install git')) {
    console.error('\nMissing prerequisites. Or use: node scripts/build-lkl.mjs --download\n');
    process.exit(1);
  }

  for (const d of [BUILD_DIR, INITRAMFS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // ── 1. Docker image ─────────────────────────────────────────────────
  const dockerfile = join(BUILD_DIR, 'Dockerfile.cross');
  writeFileSync(dockerfile, DOCKERFILE);
  log('Building emsdk-lkl Docker image...');
  run(`docker build -t emsdk-lkl -f ${dockerfile} ${BUILD_DIR}`);

  // ── 2. Sources ──────────────────────────────────────────────────────
  if (!existsSync(join(LKL_SRC, 'Makefile'))) {
    log('Cloning LKL kernel tree (as host user)...');
    // Use the host git so the clone is owned by the invoking user, not root.
    run(`git clone --depth=1 --branch=${CONFIG.lklBranch} ${CONFIG.lklRepo} ${LKL_SRC}`);
  } else {
    ok('LKL source already present');
  }

  // ── 2b. Apply pre-build patches (idempotent) ────────────────────────
  log('Applying LKL pre-build patches...');
  const patchesInBuild = join(BUILD_DIR, 'patches');
  if (!existsSync(patchesInBuild)) mkdirSync(patchesInBuild, { recursive: true });
  writeFileSync(
    join(patchesInBuild, 'apply-lkl-patches.sh'),
    readFileSync(join(ROOT, 'patches', 'apply-lkl-patches.sh')),
  );
  run(`chmod +x ${join(patchesInBuild, 'apply-lkl-patches.sh')}`);
  run(
    `docker run --rm ${dockerUserFlag()} -v ${BUILD_DIR}:/build emsdk-lkl ` +
    `bash /build/patches/apply-lkl-patches.sh /build/lkl`,
  );

  // ── 3. Initramfs scaffolding (placeholder, library mode) ────────────
  log('Staging initramfs (library-mode placeholder)...');
  for (const d of ['bin', 'sbin', 'etc', 'dev', 'proc', 'sys', 'tmp', 'root']) {
    const p = join(INITRAMFS_DIR, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  writeFileSync(join(INITRAMFS_DIR, 'init'), INIT_PLACEHOLDER);
  run(`chmod +x ${join(INITRAMFS_DIR, 'init')}`, { ignoreError: true });

  // ── 4. LKL kernel config ────────────────────────────────────────────
  if (!opts['skip-kernel']) {
    log('Writing LKL kernel configuration...');
    const kernelConfig =
      LKL_DEFCONFIG +
      `\nCONFIG_INITRAMFS_SOURCE="${INITRAMFS_DIR}"\n` +
      `CONFIG_INITRAMFS_ROOT_UID=0\nCONFIG_INITRAMFS_ROOT_GID=0\n` +
      `CONFIG_INITRAMFS_COMPRESSION_NONE=y\n`;
    writeFileSync(join(LKL_SRC, '.config'), kernelConfig);

    log('Configuring LKL kernel (olddefconfig)...');
    run(
      `docker run --rm ${dockerUserFlag()} -v ${BUILD_DIR}:/build -w /build/lkl emsdk-lkl bash -c '
         make ARCH=lkl olddefconfig
       '`,
      { ignoreError: false },
    );

    // ── 5. liblkl.a via tools/lkl ─────────────────────────────────────
    /*
     * The autoconf failure last time was "no input files" because the
     * Makefile.autoconf probe runs `${CC}` with no args to detect the
     * compiler. With emcc that's an error. The fix:
     *   - run ./autogen.sh first
     *   - export CC, HOSTCC, AR, RANLIB, CFLAGS so the probes work
     *   - feed configure a hello.c stub if it asks for one
     */
    log('Building liblkl.a (autoconf-fixed path)...');
    /*
     * Write the build script to a file and have docker run it by path.
     * This avoids every shell-quoting trap that comes with multi-line
     * `bash -c "..."` invocations through Node's `spawn`.
     */
    /*
     * Canonical build: invoke `tools/lkl/Makefile` directly. That wrapper
     * sets `OUTPUT=$(CURDIR)/` and includes `Makefile.autoconf` as a
     * dependency, which is the only invocation pattern LKL upstream tests.
     *
     * The previous version called `make -f Makefile.autoconf` directly,
     * which leaves OUTPUT empty and produces absolute `/include` paths.
     */
    const lklBuildScript = [
      '#!/bin/bash',
      '#',
      '# linux.js — drive the LKL kernel build directly via kbuild.',
      '#',
      '# Rationale: tools/lkl/Makefile defines liblkl.a as $(OUTPUT)liblkl.a',
      '# (with $(OUTPUT) defaulting to $(CURDIR)/), so the bare target name',
      "# `liblkl.a` never matches. Rather than fight that, we drive kbuild",
      '# from the kernel root and harvest its native vmlinux.a archive,',
      '# which contains every active subsystem (ext4, scheduler, TCP/IP)',
      '# compiled to wasm32 objects. We then stage it as tools/lkl/liblkl.a',
      '# so the emcc link step downstream sees what it expects.',
      '#',
      'set -euo pipefail',
      'cd /build/lkl',
      '',
      '# ─── Bring the full emsdk toolchain onto PATH ────────────────────',
      '#',
      "# The emsdk image ships emcc on PATH by default but wasm-ld and the",
      '# llvm-* binutils live under /emsdk/upstream/bin/ and need',
      "# emsdk_env.sh to be sourced. Without this, kbuild's Kconfig.include",
      "# probe runs `which wasm-ld` → fails → 'linker not found'.",
      '[ -f /emsdk/emsdk_env.sh ] && . /emsdk/emsdk_env.sh > /dev/null 2>&1 || true',
      'export PATH="/emsdk/upstream/bin:/emsdk/upstream/emscripten:$PATH"',
      '',
      'echo "[linux.js] toolchain probe:"',
      'for tool in emcc emar wasm-ld llvm-nm llvm-strip llvm-objcopy llvm-objdump; do',
      '  if command -v "$tool" > /dev/null; then',
      '    echo "  ✓ $tool → $(command -v "$tool")"',
      '  else',
      '    echo "  ✗ $tool NOT FOUND on PATH"',
      '  fi',
      'done',
      'echo ""',
      '',
      '# ─── Cross-toolchain wiring (emcc + emar + llvm-* binutils) ──────',
      'export CC="emcc"',
      'export HOSTCC="gcc"',
      'export AR="emar"',
      'export RANLIB="emar -s"',
      'export NM="llvm-nm"',
      'export STRIP="llvm-strip"',
      'export OBJCOPY="llvm-objcopy"',
      'export OBJDUMP="llvm-objdump"',
      '#',
      '# LD must be a linker whose `-v` output starts with "GNU" or "LLD" —',
      "# that's what scripts/Kconfig.include:57 probes. emcc fails this",
      "# probe ('emcc: unknown linker'). wasm-ld is the actual LLVM linker",
      '# emcc wraps, and `wasm-ld -v` reports "LLD x.y.z" → kbuild accepts.',
      'export LD="wasm-ld"',
      '',
      '# ─── WASM-target flags pushed into kbuild via KCFLAGS ────────────',
      '#',
      '# KBUILD_CFLAGS is owned by kbuild; user-additive flags go via',
      "# KCFLAGS (kbuild appends, doesn't overwrite). Same for KAFLAGS.",
      'export KCFLAGS="--target=wasm32-unknown-emscripten -msimd128 -O3 -fPIC -pthread"',
      'export KAFLAGS="--target=wasm32-unknown-emscripten"',
      '',
      'echo "[linux.js] toolchain:"',
      'echo "  CC=$CC HOSTCC=$HOSTCC AR=$AR RANLIB=\\"$RANLIB\\""',
      'echo "  NM=$NM STRIP=$STRIP OBJCOPY=$OBJCOPY LD=$LD"',
      'echo "  KCFLAGS=$KCFLAGS"',
      'echo "  KAFLAGS=$KAFLAGS"',
      'echo ""',
      '',
      '# ─── Pre-stage scripts/mod/empty.o as ELF (mk_elfconfig fix) ─────',
      '#',
      '# scripts/mod/mk_elfconfig is a tiny host tool that reads a sample',
      "# kernel object to derive endianness/class/machine for elfconfig.h.",
      '# It only parses ELF; emcc produces WASM, so we hit:',
      '#   scripts/mod/mk_elfconfig < scripts/mod/empty.o > elfconfig.h',
      '#   Error: not ELF',
      '#',
      "# Workaround: pre-build empty.o as host-gcc ELF before kbuild runs.",
      '# kbuild sees the file exists and is current → skips the emcc rebuild.',
      '# mk_elfconfig reads it happily → elfconfig.h is generated.',
      '# The arch metadata it records is unused in library-mode vmlinux.a.',
      'mkdir -p scripts/mod',
      'gcc -c -x c /dev/null -o scripts/mod/empty.o',
      'touch scripts/mod/empty.o',
      'echo "[linux.js] pre-staged scripts/mod/empty.o: $(file -b scripts/mod/empty.o)"',
      '',
      '# ─── Drive kbuild from the kernel root ───────────────────────────',
      'mkdir -p /build/scripts',
      'LOG=/build/scripts/liblkl-build.log',
      ': > "$LOG"',
      '',
      '# ─── Strategy: manual subsystem walk ─────────────────────────────',
      '#',
      '# Both vmlinux.a and vmlinux.o targets in the LKL fork funnel through',
      '# a broken dispatcher rule at /build/lkl/Makefile:1940 — `obj=.` is',
      '# passed to scripts/Makefile.build which has no rule for vmlinux.[ao].',
      '#',
      '# Bypass it: run `prepare`, then explicitly descend into each subsystem',
      '# we want, producing a per-directory `built-in.a` archive. Finally,',
      '# `ar` them all into one liblkl.a. This is what vmlinux.a would do',
      '# anyway — we just express it directly instead of through the broken',
      '# top-level recipe.',
      '',
      "# Going through the top-level Makefile (not scripts/Makefile.build",
      "# directly) means kbuild sets srctree/objtree itself. We just supply",
      '# the cross-toolchain.',
      'COMMON_MAKE_ARGS=(\
        ARCH=lkl \
        CC="$CC" HOSTCC="$HOSTCC" AR="$AR" RANLIB="$RANLIB" \
        NM="$NM" STRIP="$STRIP" OBJCOPY="$OBJCOPY" OBJDUMP="$OBJDUMP" \
        LD="$LD" KCFLAGS="$KCFLAGS" KAFLAGS="$KAFLAGS")',
      '',
      'echo "[linux.js] phase 1/3: kernel prepare" | tee -a "$LOG"',
      'if ! make "${COMMON_MAKE_ARGS[@]}" -j"$(nproc)" V=1 prepare 2>&1 | tee -a "$LOG"; then',
      '  echo "[linux.js] prepare phase failed" | tee -a "$LOG"',
      '  EARLY_FAIL=1',
      'fi',
      '',
      '# The subsystems we need for an LKL library boot. Each one becomes a',
      '# `built-in.a` in its directory after the per-subsystem build.',
      'SUBSYSTEMS=(',
      '  init',
      '  kernel',
      '  mm',
      '  fs',
      '  block',
      '  ipc',
      '  security',
      '  crypto',
      '  lib',
      '  drivers/base',
      '  drivers/char',
      '  drivers/tty',
      '  arch/lkl/kernel',
      '  arch/lkl/mm',
      ')',
      '',
      'echo "[linux.js] phase 2/3: subsystem walk" | tee -a "$LOG"',
      '#',
      "# IMPORTANT: invoke each subsystem via the top-level Makefile with",
      "# `make <subdir>/`. The trailing slash is kbuild syntax meaning",
      '# "build this directory to a built-in.a". The top-level Makefile',
      '# includes include/config/auto.conf, which is where CONFIG_* values',
      "# come from — without it `obj-$(CONFIG_X) += y.o` evaluates to",
      "# nothing and the build is a no-op.",
      'BUILT_INS=()',
      'FAILED_SUBS=()',
      'for sub in "${SUBSYSTEMS[@]}"; do',
      '  if [ ! -d "$sub" ]; then',
      '    echo "  ↷ $sub (directory absent, skipping)" | tee -a "$LOG"',
      '    continue',
      '  fi',
      '  echo "  → building $sub/" | tee -a "$LOG"',
      '  # Trailing slash on the target = "build subdir/built-in.a"',
      '  if make "${COMMON_MAKE_ARGS[@]}" -j"$(nproc)" V=1 "$sub/" 2>&1 | tee -a "$LOG"; then',
      '    if [ -f "$sub/built-in.a" ]; then',
      '      sz=$(stat -c %s "$sub/built-in.a")',
      '      echo "    ✓ $sub/built-in.a (${sz} bytes)" | tee -a "$LOG"',
      '      BUILT_INS+=("$sub/built-in.a")',
      '    else',
      '      echo "    (no built-in.a produced — subsystem disabled in config)" | tee -a "$LOG"',
      '    fi',
      '  else',
      '    echo "    ✖ $sub build failed" | tee -a "$LOG"',
      '    FAILED_SUBS+=("$sub")',
      '  fi',
      'done',
      '',
      '# A failed subsystem leaves some objects unbuilt; phase 3 would then',
      '# silently archive the rest and the missing symbols only surface as',
      '# "missing function" aborts at runtime. Stop here instead.',
      'if [ ${#FAILED_SUBS[@]} -gt 0 ]; then',
      '  echo "[linux.js] subsystem build failed: ${FAILED_SUBS[*]}" | tee -a "$LOG"',
      '  grep -nE "^[^:]+\\.[ch]:[0-9]+:[0-9]+: (error|fatal error):" "$LOG" | head -20 || true',
      '  exit 1',
      'fi',
      '',
      'echo "" | tee -a "$LOG"',
      'echo "[linux.js] phase 3/3: combine $(echo ${#BUILT_INS[@]}) archives" | tee -a "$LOG"',
      '',
      'if [ ${#BUILT_INS[@]} -eq 0 ]; then',
      '  echo ""',
      '  echo "════════════════════════════════════════════════════════════"',
      '  echo "[linux.js] no built-in.a archives were produced at all."',
      '  echo "Last 250 lines of the build log:"',
      '  echo "════════════════════════════════════════════════════════════"',
      '  tail -250 "$LOG"',
      '  echo "════════════════════════════════════════════════════════════"',
      '  echo ""',
      '  echo "════════════════════════════════════════════════════════════"',
      '  echo "[linux.js] vmlinux.a build failed."',
      '  echo "Last 200 lines of the build log:"',
      '  echo "════════════════════════════════════════════════════════════"',
      '  tail -200 "$LOG"',
      '  echo "════════════════════════════════════════════════════════════"',
      '  echo "First 10 real C-compile errors (file:line:col: error: …):"',
      '  echo "════════════════════════════════════════════════════════════"',
      '  grep -nE "^[^:]+\\.[ch]:[0-9]+:[0-9]+: (error|fatal error):" "$LOG" | head -10 \\',
      '    || echo "  (no real source errors — failure is in make/orchestration)"',
      '  echo ""',
      '  echo "Make-level stop reasons:"',
      '  echo "────────────────────────────────────────────────────────────"',
      '  grep -nE "^make(\\[[0-9]+\\])?: \\*\\*\\*" "$LOG" | tail -10 || true',
      '  exit 1',
      'fi',
      '',
      'echo "[linux.js] subsystem archives to merge:"',
      'for a in "${BUILT_INS[@]}"; do echo "  $a ($(stat -c %s "$a") bytes)"; done',
      '',
      '# ─── Hand-write lkl_autoconf.h ───────────────────────────────────',
      '#',
      '# lkl_adapter.c includes <lkl.h>, which starts with',
      '#   #include "lkl_autoconf.h"',
      '# That header is normally generated by tools/lkl/Makefile.autoconf,',
      "# which we bypass. Synthesize it with the LKL_HOST_CONFIG_* values",
      '# matching our pre-populated Makefile.conf so symbol visibility is',
      '# coherent between archive and adapter.',
      '#',
      "# The adapter (src/host/lkl_adapter.c) was refactored to be",
      "# self-contained — it no longer includes <lkl.h> or <lkl_host.h>.",
      '# It declares the minimal LKL ABI inline: struct lkl_host_operations,',
      "# lkl_start_kernel, lkl_syscall, lkl_sys_halt, plus raw syscall",
      "# numbers and thin wrappers. So we don't need to stub LKL headers",
      '# any more; just need the kernel archive for the link step.',
      'echo "[linux.js] adapter is header-independent — no LKL header stubs needed"',
      '',
      '# ─── Merge built-in.a archives → tools/lkl/liblkl.a ──────────────',
      '#',
      '# CRITICAL: kbuild creates `built-in.a` as THIN archives (emar -T).',
      "# Those contain only file path references, not actual .o content.",
      '# Using `ar -M ADDLIB` on thin archives drops the references at',
      '# merge time, producing a "fat archive" with no actual code.',
      '#',
      '# Correct approach: enumerate the .o file paths from each thin',
      "# archive, then archive the real .o files directly into liblkl.a.",
      'mkdir -p tools/lkl',
      'rm -f tools/lkl/liblkl.a',
      '',
      '# Collect exactly the objects kbuild built for the CURRENT config:',
      '# the members of each (thin) built-in.a / lib.a. Walking with `find`',
      '# instead would also pick up stale objects from options that were',
      '# since disabled (e.g. drivers/tty/vt after CONFIG_VT=n) and link',
      '# them back in. Subsystem compile failures are already fatal above,',
      '# so the archives are complete.',
      'declare -A SEEN_OBJ',
      'ALL_OBJS=()',
      '',
      'add_obj() {',
      '  local o="$1"',
      '  [ -f "$o" ] || return',
      "  # Skip the placeholder ELF object we pre-staged for mk_elfconfig.",
      '  case "$o" in *scripts/mod/empty.o) return ;; esac',
      '  if [ -z "${SEEN_OBJ[$o]:-}" ]; then',
      '    SEEN_OBJ[$o]=1',
      '    ALL_OBJS+=("$o")',
      '  fi',
      '}',
      '',
      '# kbuild puts obj-y in <dir>/built-in.a and lib-y in <dir>/lib.a (the',
      '# kernel links lib.a as a library) — e.g. lib/ctype.o lives only in',
      '# lib/lib.a. Collect both.',
      'ARCHIVES=("${BUILT_INS[@]}")',
      'for sub in "${SUBSYSTEMS[@]}"; do',
      '  [ -f "$sub/lib.a" ] && ARCHIVES+=("$sub/lib.a")',
      'done',
      '',
      'for a in "${ARCHIVES[@]}"; do',
      '  [ -f "$a" ] || continue',
      '  while IFS= read -r obj; do',
      '    [ -z "$obj" ] && continue',
      '    obj="${obj#/build/lkl/}"   # thin archives may record absolute paths',
      '    if [ -f "$obj" ]; then add_obj "$obj"',
      '    elif [ -f "/build/lkl/$obj" ]; then add_obj "/build/lkl/$obj"',
      '    else echo "  ✗ $a references missing object $obj"; exit 1',
      '    fi',
      '  done < <("$AR" t "$a" 2>/dev/null)',
      'done',
      '',
      '# Sanity: the kernel entry point must be in the set.',
      '# (Map lookup, not `printf | grep -q`: under pipefail, grep -q exiting',
      '# early SIGPIPEs printf and the pipeline reports failure on a match.)',
      'if [ -z "${SEEN_OBJ[init/main.o]:-}" ]; then',
      '  echo "  ✗ init/main.o (start_kernel) missing from built-in.a members"; exit 1',
      'fi',
      '',
      'echo "[linux.js] collected ${#ALL_OBJS[@]} .o files from ${#SUBSYSTEMS[@]} subsystems"',
      '',
      'if [ ${#ALL_OBJS[@]} -eq 0 ]; then',
      '  echo "  ✗ no .o files resolved — something is wrong with built-in.a layout"',
      '  exit 1',
      'fi',
      '',
      '# Build the final liblkl.a as a regular (non-thin) archive.',
      '# CRITICAL: GNU ar stores members by BASENAME only. The kernel tree',
      '# has many .o files sharing a basename (init/main.o, drivers/.../main.o,',
      '# fs/.../inode.o, etc.). `ar r` REPLACES same-named members, so adding',
      '# drivers/base/firmware_loader/main.o would clobber init/main.o and',
      '# drop start_kernel entirely. Stage every object under a UNIQUE',
      '# path-flattened name first, then archive those.',
      'STAGE=tools/lkl/objstage',
      'rm -rf "$STAGE"; mkdir -p "$STAGE"',
      'STAGED_OBJS=()',
      'for o in "${ALL_OBJS[@]}"; do',
      '  # Flatten the path: init/main.o -> init__main.o, strip leading ./',
      '  flat="${o#./}"',
      '  flat="${flat//\\//__}"',
      '  cp "$o" "$STAGE/$flat"',
      '  STAGED_OBJS+=("$STAGE/$flat")',
      'done',
      'echo "[linux.js] staged ${#STAGED_OBJS[@]} uniquely-named objects"',
      'rm -f tools/lkl/liblkl.a',
      '"$AR" rcs tools/lkl/liblkl.a 2>/dev/null || true',
      'printf "%s\\0" "${STAGED_OBJS[@]}" | xargs -0 -n 100 "$AR" rcs tools/lkl/liblkl.a',
      '',
      'echo ""',
      'echo "[linux.js] staged kernel archive:"',
      'ls -lh tools/lkl/liblkl.a',
      'echo "Object count in liblkl.a:"',
      '"$AR" t tools/lkl/liblkl.a | wc -l',
      '',
    ].join('\n');

    const scriptsDir = join(BUILD_DIR, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    const lklScriptPath = join(scriptsDir, 'build-liblkl.sh');
    writeFileSync(lklScriptPath, lklBuildScript);
    run(`chmod +x ${lklScriptPath}`);

    run(
      `docker run --rm ${dockerUserFlag()} -v ${BUILD_DIR}:/build emsdk-lkl /build/scripts/build-liblkl.sh`,
    );

    const liblkl = join(LKL_SRC, 'tools', 'lkl', 'liblkl.a');
    if (!existsSync(liblkl)) {
      fail('liblkl.a still not produced after autoconf fix + vmlinux fallback.');
      console.error('  This means upstream LKL needs wasm32 kernel patches that are beyond');
      console.error('  what this build script can apply mechanically.');
      console.error('  Fall back: node scripts/build-lkl.mjs --download');
      process.exit(1);
    }
    ok('liblkl.a built');
  }

  // ── 6. Final emcc link ──────────────────────────────────────────────
  if (opts['skip-emcc-link']) {
    log('Skipping emcc link (--skip-emcc-link).');
    return;
  }

  log(`Linking adapter + LKL with Emscripten (${variant})...`);
  const hostInBuild = join(BUILD_DIR, 'host');
  if (!existsSync(hostInBuild)) mkdirSync(hostInBuild, { recursive: true });
  writeFileSync(join(hostInBuild, 'lkl_adapter.c'), readFileSync(join(HOST_SRC, 'lkl_adapter.c')));
  writeFileSync(join(hostInBuild, 'lkl_adapter.h'), readFileSync(join(HOST_SRC, 'lkl_adapter.h')));
  // Stubs for kernel symbols transitively referenced by built-in.a files
  // but not provided by our minimal subsystem set (io_uring, initramfs
  // decompression, lib helpers gated on disabled CONFIGs, etc.).
  writeFileSync(join(hostInBuild, 'lkl_stubs.c'), readFileSync(join(HOST_SRC, 'lkl_stubs.c')));

  const exports = [
    /* Boot is renamed to linuxjs_boot to avoid the kernel's own lkl_init symbol. */
    '_linuxjs_boot', '_lkl_send_input', '_lkl_drain_output',
    '_lkl_write_file', '_lkl_read_file', '_lkl_stat', '_lkl_readdir',
    '_lkl_mkdir', '_lkl_rm', '_lkl_mount', '_lkl_shutdown',
    '_lkl_get_last_error', '_linuxjs_kernel_panicked',
    '_linuxjs_host_threads', '_linuxjs_peak_host_threads', '_linuxjs_set_debug',
    '_malloc', '_free',
  ];
  // wasmMemory: the adapter reads/writes linear memory through it (HEAP* views
  // can go stale after growth under pthreads).
  const runtime = ['ccall', 'cwrap', 'stringToUTF8', 'UTF8ToString', 'lengthBytesUTF8', 'wasmMemory'];

  const outBase = opts.wasm64 ? 'lkl.wasm64' : 'lkl';
  const memory64Flags = opts.wasm64
    ? '-sMEMORY64=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=17179869184'
    : '-sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=2147483648';

  /*
   * Same trick as the kernel build: write a real script and execute it
   * by path. Spares us another round of JSON.stringify shell-quoting bugs.
   */
  const linkScript = [
    '#!/bin/bash',
    'set -euo pipefail',
    'cd /build',
    '',
    `EXPORTS='${JSON.stringify(exports)}'`,
    `RUNTIME='${JSON.stringify(runtime)}'`,
    '',
    /* -O2 for speed; --profiling-funcs keeps wasm function names so kernel
     * WARN/BUG backtraces (linuxjs_host_backtrace) stay readable. */
    'emcc -O2 --profiling-funcs -pthread \\',
    '  -I/build/lkl/tools/lkl/include \\',
    '  -I/build/lkl/include \\',
    /* Kernel's actual host_ops.h struct definition — guarantees ABI match. */
    '  -I/build/lkl/arch/lkl/include \\',
    '  -I/build/lkl/arch/lkl/include/uapi \\',
    '  -sWASM=1 \\',
    /*
     * Static data must not start inside the first page: the kernel treats
     * any pointer below PAGE_SIZE as invalid (printk prints "(efault)",
     * ZERO_OR_NULL / IS_ERR-style checks misfire). Emscripten's default
     * GLOBAL_BASE is 1024.
     */
    '  -sGLOBAL_BASE=65536 \\',
    /*
     * LKL runs each syscall on the CALLING thread's stack (host-task model),
     * so the main thread needs room for VFS/ext4 call chains; kernel threads
     * run on pthread stacks. Emscripten's 64 KiB defaults overflow.
     */
    '  -sSTACK_SIZE=1048576 \\',
    '  -sDEFAULT_PTHREAD_STACK_SIZE=262144 \\',
    '  -sALLOW_MEMORY_GROWTH=1 \\',
    `  ${memory64Flags} \\`,
    /*
     * Pre-spawned Workers for kernel threads. A pthread created when the
     * pool is empty needs the main JS thread to spawn a Worker — and the
     * main thread may be blocked in a syscall waiting on that thread
     * (deadlock). A booted kernel peaks at ~16 host threads (kthreadd,
     * kworkers, ksoftirqd, timers...; see getStats().hostThreads), so keep
     * headroom above that.
     */
    '  -sPTHREAD_POOL_SIZE=20 \\',
    '  -sMODULARIZE=1 \\',
    '  -sEXPORT_ES6=1 \\',
    '  -sENVIRONMENT=web,worker,node \\',
    '  -sSINGLE_FILE=0 \\',
    /*
     * Strict linking: every kernel symbol must resolve at build time. The
     * old --allow-undefined turned missing functions into runtime aborts
     * and missing DATA symbols into silent address-0 pointers (that is how
     * the sched-class, initcall and jiffies bugs hid). Fill genuine gaps in
     * src/host/lkl_stubs.c instead.
     */
    '  -sERROR_ON_UNDEFINED_SYMBOLS=1 \\',
    /* No runtime assertions in release, but keep real stack-overflow checks:
     * kernel code shares the caller's stack, and an overflow must abort
     * cleanly rather than corrupt the heap. */
    '  -sASSERTIONS=0 \\',
    '  -sSTACK_OVERFLOW_CHECK=2 \\',
    '  -sEXPORTED_FUNCTIONS="$EXPORTS" \\',
    '  -sEXPORTED_RUNTIME_METHODS="$RUNTIME" \\',
    `  -o /build/${outBase}.js \\`,
    '  /build/host/lkl_adapter.c \\',
    '  /build/host/lkl_stubs.c \\',
    /*
     * --whole-archive: lkl_stubs.c's weak fallbacks are plain objects on
     * the command line, so without it wasm-ld never extracts an archive
     * member whose only job is to provide one of those symbols (init_mm,
     * kmem_cache_free, vscnprintf, ...) — the stub silently wins. It also
     * keeps members only reachable through initcalls (filesystems, drivers).
     */
    '  -Wl,--whole-archive /build/lkl/tools/lkl/liblkl.a -Wl,--no-whole-archive',
    '',
  ].join('\n');

  const linkScriptPath = join(BUILD_DIR, 'scripts', `link-${outBase}.sh`);
  writeFileSync(linkScriptPath, linkScript);
  run(`chmod +x ${linkScriptPath}`);

  run(`docker run --rm ${dockerUserFlag()} -v ${BUILD_DIR}:/build emsdk-lkl /build/scripts/link-${outBase}.sh`);

  // ── 7. Copy artifacts ───────────────────────────────────────────────
  log('Copying artifacts to project root...');
  const wantedFiles = opts.wasm64
    ? [`${outBase}.wasm`, `${outBase}.js`]
    : [`${outBase}.wasm`, `${outBase}.js`, `${outBase}.worker.js`];

  for (const f of wantedFiles) {
    const src = join(BUILD_DIR, f);
    if (existsSync(src)) {
      writeFileSync(join(ROOT, f), readFileSync(src));
      const size = (readFileSync(src).length / 1024 / 1024).toFixed(2);
      ok(`${f} (${size} MB)`);
    } else if (f.endsWith('.worker.js')) {
      warn(`${f} not produced (single-file pthread build — that's OK)`);
    } else {
      fail(`${f} missing after link`);
      process.exit(1);
    }
  }

  console.log(`
═══════════════════════════════════════════════════════════
  LKL → WASM build complete (${variant}).
═══════════════════════════════════════════════════════════
  Kernel:    real Linux via LKL (GPL v2)
  Userspace: none yet (library mode — kernel only)
  Output:    ${wantedFiles.join(', ')}

  Next:      npm run build && npm run smoke
`);
}

async function main() {
  if (opts.download) { await downloadPrebuilt(); return; }
  await buildFromSource();
}

main().catch((err) => {
  fail(`build failed: ${err.message}`);
  process.exit(1);
});
