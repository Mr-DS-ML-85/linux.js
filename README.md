# 🐧 linux.js

**Run the real Linux kernel anywhere WebAssembly runs.** Your users' CPUs run the sandbox. Your server bill stays at $0.

```bash
npm install linux.js
```

```javascript
import Linux from 'linux.js';

const linux = await Linux.create({ memory: 256 });   // boots in ~0.6 s

console.log(linux.getKernelVersion());               // Linux version 6.12.0 ...
await linux.writeFile('/work/notes.txt', 'hello');    // openat + write
console.log(await linux.readFile('/proc/meminfo'));   // real procfs

await linux.shutdown();
```

linux.js compiles the **real Linux kernel** — via [LKL](https://github.com/lkl/linux), the Linux Kernel Library — to WebAssembly. Real VFS, real scheduler, real procfs/sysfs/devtmpfs/tmpfs, real syscalls.

No x86 emulation. No fake VFS. No Docker on the server.

> **Status: library mode.** The kernel boots and every filesystem API goes
> through real kernel syscalls. There is **no guest userland** yet, so
> `exec()`, `agent.run()`, `stream()` and `session()` reject with
> `ExecNotSupportedError`. See [What works](#what-works-today).

---

## The economic shift

| Traditional (Docker / MicroVM) | linux.js |
|---|---|
| 10 000 agents = 10 000 cloud nodes | 10 000 agents = 10 000 browser tabs |
| You pay the AWS bill | Users pay their own electricity |
| Scale ceiling = your budget | Scales free — CDN serves one static `lkl.wasm` |
| Container-breakout exploits hit your host | A rogue script can only crash one tab |

This is built **for AI-agent workloads**. Every browser tab becomes a sandbox; you ship one `lkl.wasm` over a CDN.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Your JS app / LLM tool loop                 │
│  await agent.run("npm test")                 │
├──────────────────────────────────────────────┤
│  src/agent.ts        — sandbox + tool schema │
│  src/linux.ts        — public API            │
│  src/lkl-adapter.ts  — WASM bridge        MIT│
│  src/transport.ts    — network transports    │
│  src/runtime.ts      — runtime detection     │
├──────────────────────────────────────────────┤
│  src/host/lkl_adapter.c    — lkl_host_ops    │
│    + virtio-console pipe to init       GPL v2│
├──────────────────────────────────────────────┤
│  liblkl.a — real Linux kernel as a library   │
│    ext4, TCP/IP, scheduler, signals    GPL v2│
├──────────────────────────────────────────────┤
│  Emscripten runtime (pthreads, memory)       │
├──────────────────────────────────────────────┤
│  WASM host (browser / Node / Workers / Deno) │
└──────────────────────────────────────────────┘
```

**License split.** The TS wrapper (MIT) talks to the kernel binary (GPL v2) through a stable C ABI at the WASM module edge — arm's length, not a derivative work. `src/host/*` is GPL because it gets linked into the kernel artifact.

---

## AI-agent API

```ts
const agent = linux.agent({ workdir: '/workspace', maxOutputBytes: 256 * 1024 });

// File staging, confined to the workdir ('..' escapes are refused)
await agent.putFile('data.csv', csvBytes);
const text = await agent.getFile('data.csv');

// LLM tool calling: offer the file tools, route the model's calls back
const tools = agent.fileToolDefinitions();   // read_file, write_file, list_files
const reply = await agent.handleToolCall('write_file', { path: 'out.md', content: '# hi' });
```

The schemas are OpenAI / Anthropic function-calling shaped. `handleToolCall`
returns text for the model (errors as `error: …`, so the model can recover).

`agent.run()` / `stream()` / `session()` / `toolDefinition()` keep their
signatures but reject with `ExecNotSupportedError` until a guest userland
exists — advertising a shell tool a model can never use would only produce
failing calls. Allow/deny-list checks still run first.

---

## Networking (browser → server)

LKL inside a browser has no raw TCP. linux.js ships a transport abstraction; the browser tunnels through a WebSocket relay you control, while Node / Deno / Cloudflare Workers use their native socket primitives.

```ts
import { autoTransport, NodeNetTransport, WebSocketRelayTransport } from 'linux.js';

// Auto-picks based on runtime
const transport = autoTransport({ relayUrl: 'wss://relay.example.com/' });
const linux = await Linux.create({ memory: 256, networking: true, transport });
```

A reference relay is in `scripts/relay.mjs`:

```bash
node scripts/relay.mjs --port 8787
# (set RELAY_ALLOWED_HOSTS=api.openai.com,... to lock down egress)
```

The kernel-side virtio-net wiring lights up once the networking build of `lkl.wasm` is published; the JS interface is stable today.

---

## API surface

| Method | Description |
|---|---|
| `Linux.create(config?)` | Boot the kernel; resolves once initcalls ran and /proc, /sys, /dev, /tmp, /run are mounted. Rejects with `KernelPanicError` (with the console log) if the kernel panics. |
| `linux.writeFile / readFile / readBinary` | Kernel syscalls (`openat`/`write`/`pread64`), any size. |
| `linux.readdir / stat / exists / mkdir / rm / cp` | Filesystem ops (`cp`/`rm` support recursion). |
| `linux.getKernelVersion / getStats / kernelLog` | Introspection (`getStats().hostThreads` = live/peak host threads). |
| `linux.agent(config)` | Sandboxed agent surface (see above). |
| `linux.exec(cmd)` / `which(cmd)` | No userland: `exec` rejects with `ExecNotSupportedError`, `which` is `false`. |
| `linux.shutdown / kill` | Lifecycle (halts the kernel and joins its threads). |
| `linux.snapshot()` / `Linux.restore(snap)` | API stable; throws `SnapshotNotSupportedError` until LKL exposes a checkpoint hook. |

Config:

| Option | Default | |
|---|---|---|
| `memory` | `128` | Kernel RAM in MB, clamped to `[32, 4096]`. |
| `wasmBinary` | auto | Path/URL to the Emscripten loader. |
| `kernelCmdline` | `""` | Extra kernel cmdline. |
| `kernelCmdline` | `""` | Extra kernel cmdline, e.g. `loglevel=8` for a verbose `kernelLog()`. |
| `debug` | `false` | Mirror kernel console output to stderr live (diagnosing boot hangs). |
| `networking` | `false` | Reserved; kernel-side virtio-net is not wired yet. |
| `onOutput / onReady / onCrash` | — | Kernel console output / boot / failure hooks. |

---

## Getting `lkl.wasm`

### Build from source

```bash
npm run build:lkl        # node scripts/build-lkl.mjs — kernel → lkl.wasm + lkl.js
npm run build:userland   # WASI tools → userland/bin/ (see userland/README.md)
npm run build            # TypeScript → dist/
npm run smoke            # boots the kernel and checks every API against it
```

Needs Docker, git and ~4 GB of disk. The toolchain image is pinned to
`emscripten/emsdk:6.0.10` so the kernel objects, the adapter and the link
always come from the same compiler. The script clones LKL (Linux 6.12),
applies the wasm32 patch series in [`patches/`](patches/README.md), builds the
kernel with emcc, and links it with the C host adapter
([`src/host/lkl_adapter.c`](src/host/lkl_adapter.c)) via Emscripten with
pthreads. The link is **strict**: any unresolved kernel symbol fails the build.

`node scripts/build-lkl.mjs --download` fetches a prebuilt artifact once a
release has been published (none yet). The `--wasm64` variant is not
functional: it would need its own `CONFIG_64BIT=y` kernel build compiled for
wasm64, and currently reuses the wasm32 objects.

### Why the patch series exists

LKL assumes a native toolchain and GNU ld. Under emcc/wasm-ld the kernel's
`vmlinux.lds` never runs and wasm has its own ABI rules, so the build fixes,
among others: a 32-bit kernel config (wasm32 `long` is 32 bits); scheduler
classes, initcall and `__setup` tables, `jiffies` and static-data bounds that
normally come from the linker script; exact-signature syscall entry points
(wasm `call_indirect` traps on mismatches); RCU's kvfree-offset encoding
(wasm function pointers are small table indices); and wasm call-stack
backtraces for WARN/BUG. See [`patches/README.md`](patches/README.md).

### What works today

**Working:** the kernel boots (~0.4–0.6 s on a laptop), runs every initcall,
and mounts procfs, sysfs, devtmpfs and tmpfs. All file APIs (`writeFile`,
`readFile`, `readBinary`, `stat`, `readdir`, `mkdir`, `rm`, `cp`) are real
kernel syscalls with no size limits. Kernel panics surface as
`KernelPanicError` instead of hanging; WARN/BUG splats carry wasm stack traces
in `kernelLog()`. Shutdown halts the kernel and joins its threads.

**In progress — WASI userland:** `exec()` and the agent's shell surfaces still
reject with `ExecNotSupportedError`, but the pieces underneath are built and
tested (see below). The root filesystem is an in-memory ramfs — nothing
persists across instances, and there is no block device yet (ext4 is compiled
in, but needs a disk to mount).

**Threading note:** `Linux.create()` calls into the kernel synchronously, so
boot blocks the calling JS thread for the boot duration. In browsers, run it in
a Worker if that matters, and serve the page with COOP/COEP headers
(`SharedArrayBuffer` is required).

### WASI userland (in progress)

The kernel cannot load WebAssembly programs itself (LKL's binfmt only
intercepts `/init`), so programs run as **WASI preview1 modules on the host,
with every system call served by the guest kernel**:

- [`src/wasi/process.ts`](src/wasi/process.ts) implements WASI preview1
  (`path_open`, `fd_read`, `fd_readdir`, `path_rename`, `poll_oneoff`, …) on top
  of real kernel syscalls through a raw gate exported by the adapter
  (`linuxjs_syscall`, wrapped by [`src/wasi/kernel.ts`](src/wasi/kernel.ts)).
  Each process has its own fd table, captured or redirected stdio, and a
  deadline for timeouts.
- [`userland/`](userland/README.md) builds the tools from pinned sources:
  uutils coreutils (~90 tools), grep, sed, find, diff/cmp, GoAWK, plus the
  official CPython 3.15 and QuickJS WASI builds. A small linked-in shim gives
  WASI programs a working directory (`$PWD`), which preview1 lacks.

Verified against the real kernel: `ls -la`, `cp`, `mv`, `mkdir -p`, `ln -s`,
`rm -r`, `sort`, `wc`, `sha256sum`, `grep -rn`, `find -name`, `diff -u`, `cmp`,
`sed`, `awk` — each runs in a few milliseconds. **Not done yet:** the public
`linux.run([...])` API (package installation into `/usr/bin`, PATH lookup,
module caching), Python/QuickJS run checks, and a shell for `exec("…")`
strings.

---

## Multi-runtime support

| Runtime | Threading | Loader | Status |
|---|---|---|---|
| Node ≥ 18 | ✅ pthreads (worker_threads) | `lkl.js` | tested (smoke + unit tests) |
| Browser (cross-origin isolated) | ✅ (COOP/COEP) | `lkl.js` | expected to work; not in CI |
| Bun / Deno | ✅ | `lkl.js` | not tested |
| Browser without isolation / Cloudflare Workers | ❌ no `SharedArrayBuffer` | — | unsupported: the kernel needs threads, and a single-threaded build is not produced |

`detectRuntime()` and `capabilities()` report the environment; override the
loader with `wasmBinary`. The network transport classes are an API preview —
the kernel-side virtio-net is not wired up.

---

## Licensing

| Part | License |
|---|---|
| `src/*.ts`, examples, scripts, `userland/shim` | **MIT** |
| `src/host/*.{c,h}`, `patches/` | **GPL v2** |
| Compiled `lkl.wasm` | **GPL v2** |
| `userland/bin/*` (built tools) | their upstream licenses — MIT (uutils, GoAWK, QuickJS), Apache-2.0 (diffutils), PSF-2.0 (CPython); listed per file in `userland/bin/checksums.json` |

`LICENSE` carries MIT; `LICENSE.GPL` will ship the kernel's GPL v2 text alongside the artifact.

---

## Roadmap

Working today:
- Kernel boot in library mode (~0.5 s), clean halt
- File syscalls of any size: write/read/stat/readdir/mkdir/rm/cp
- `/proc`, `/sys`, `/dev` (devtmpfs), `/tmp`, `/run` mounts
- Kernel panics → `KernelPanicError`; WARN/BUG with wasm backtraces
- Agent sandbox: workdir-confined file staging, LLM file tools, allow/deny lists
- Strict link: unresolved kernel symbols fail the build
- WASI preview1 runtime on kernel syscalls; reproducible userland build
  (coreutils, grep, sed, find, diff, awk, Python, QuickJS)

Next:
- [ ] `linux.run([...])`: argv-based execution of userland programs
- [ ] Shell (on the mvdan/sh parser) → `exec("…")`, agent shell tools
- [ ] Block device + persistent ext4 images
- [ ] First prebuilt `lkl.wasm` published via the release workflow
- [ ] Boot off the calling thread (run the kernel entirely in Workers)
- [ ] Kernel-side virtio-net wired to the transport
- [ ] Snapshot/restore once LKL adds a checkpoint hook

---

## Inspiration

- [sql.js](https://github.com/sql-js/sql.js/) — the API model
- [LKL](https://github.com/lkl/linux) — the kernel as a library
- [Emscripten](https://emscripten.org/) — the toolchain
