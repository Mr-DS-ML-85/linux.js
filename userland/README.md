# linux.js — WASI userland

Command-line tools that run as WASI preview1 programs, with every system call
served by the guest Linux kernel (see [`src/wasi/`](../src/wasi)).

## Build

```bash
npm run build:userland            # everything
node scripts/build-userland.mjs --no-python
```

Needs git, curl, tar, unzip, `cargo` with `rustup target add wasm32-wasip1`,
and Go ≥ 1.21. Sources and downloads go to `build/userland/` (gitignored); the
results land in `userland/bin/` (gitignored, shipped in the npm package) with
`checksums.json` listing each file's package, version, license, source and
sha256. Every download is checked against a pinned sha256 in
[`scripts/build-userland.mjs`](../scripts/build-userland.mjs).

| Output | Upstream | Version | License | How |
|---|---|---|---|---|
| `coreutils.wasm` | uutils/coreutils | 0.12.0 | MIT | cargo, `feat_wasm` (~90 tools, multicall by argv[0]) |
| `grep.wasm` | uutils/grep | 0.2.0 | MIT | cargo; Oniguruma compiled with wasi-sdk |
| `sed.wasm` | uutils/sed | 0.3.0 | MIT | cargo |
| `find.wasm` | uutils/findutils | 0.10.0 | MIT | cargo; Oniguruma compiled with wasi-sdk |
| `diffutils.wasm` | uutils/diffutils | v0.5.0 | Apache-2.0 | cargo + [patch](patches/diffutils-0.5.0-wasi.patch); `diff` / `cmp` by argv[0] |
| `awk.wasm` | benhoyt/goawk | v1.32.0 | MIT | `GOOS=wasip1 GOARCH=wasm go build` |
| `qjs.wasm` | quickjs-ng/quickjs | v0.17.0 | MIT | official WASI release |
| `python.wasm`, `python-stdlib.tar` | CPython (brettcannon/cpython-wasi-build) | 3.15.0 | PSF-2.0 | official WASI release; stdlib repacked as a plain tar rooted at `lib/` |

`xargs` (findutils) is deliberately not shipped: it spawns other programs,
which WASI preview1 cannot do.

## The working-directory shim

WASI preview1 has no working directory. wasi-libc emulates one starting at
`/`, and programs that never call `chdir()` don't even link that emulation —
in them, `foo` and `/foo` resolve to the same file. [`shim/cwd_init.c`](shim/cwd_init.c)
is linked into every Rust tool: a constructor that adopts `$PWD` (the host sets
it per process) and, by referencing `chdir()`, links wasi-libc's cwd-aware path
resolver. Go's wasip1 runtime reads `$PWD` on its own; CPython and QuickJS
link `chdir` already but start at `/`, so their runner will set the directory
at startup.

## Patches

- [`patches/diffutils-0.5.0-wasi.patch`](patches/diffutils-0.5.0-wasi.patch) —
  `cmp` used Unix-only metadata APIs (`std::os::unix::fs::MetadataExt`); the
  WASI equivalent is still unstable in Rust. On WASI it now skips the
  "stdout is /dev/null" print optimization (as on Windows) and takes file
  sizes from the stable `Metadata::len()`.
