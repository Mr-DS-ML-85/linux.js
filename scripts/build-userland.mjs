#!/usr/bin/env node

/**
 * linux.js — build the WASI userland.
 *
 * Fetches pinned upstream sources / releases, builds each tool for
 * wasm32-wasip1 and writes the results plus a checksum manifest to
 * userland/bin/:
 *
 *   coreutils, grep, sed, find, diff/cmp   uutils (Rust)    built from source
 *   awk                                    GoAWK (Go)       built from source
 *   python3                                CPython WASI     official prebuilt
 *   qjs                                    QuickJS-ng       official prebuilt
 *
 * Rust tools are linked with userland/shim/cwd_init.c so they honour $PWD
 * (WASI preview1 has no working directory; see that file). Go's wasip1
 * runtime reads $PWD itself. C dependencies (Oniguruma, used by grep and
 * find) are compiled with wasi-sdk.
 *
 * Needs: git, curl, tar, unzip, cargo + rustup target wasm32-wasip1, go.
 * Downloads go to build/userland/ (gitignored).
 *
 *   node scripts/build-userland.mjs            # everything
 *   node scripts/build-userland.mjs --no-python
 *
 * License: MIT.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, 'build', 'userland');
const SRC = join(WORK, 'src');
const DL = join(WORK, 'dl');
const OUT = join(ROOT, 'userland', 'bin');

const { values: opts } = parseArgs({ options: { 'no-python': { type: 'boolean', default: false } } });

/* Pinned inputs. Bump deliberately; sha256 values guard the downloads. */
const WASI_SDK = {
  version: 'wasi-sdk-34',
  url: 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz',
  sha256: 'b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4',
};
const RUST_TOOLS = [
  { name: 'coreutils', repo: 'uutils/coreutils', tag: '0.12.0', license: 'MIT',
    cargoArgs: ['--no-default-features', '--features', 'feat_wasm'], outputs: { 'coreutils.wasm': 'coreutils.wasm' } },
  { name: 'grep', repo: 'uutils/grep', tag: '0.2.0', license: 'MIT', needsCC: true,
    outputs: { 'grep.wasm': 'grep.wasm' } },
  { name: 'sed', repo: 'uutils/sed', tag: '0.3.0', license: 'MIT',
    outputs: { 'sed.wasm': 'sed.wasm' } },
  { name: 'findutils', repo: 'uutils/findutils', tag: '0.10.0', license: 'MIT', needsCC: true,
    outputs: { 'find.wasm': 'find.wasm' } },
  { name: 'diffutils', repo: 'uutils/diffutils', tag: 'v0.5.0', license: 'Apache-2.0',
    patch: 'diffutils-0.5.0-wasi.patch', outputs: { 'diffutils.wasm': 'diffutils.wasm' } },
];
const GOAWK = { repo: 'benhoyt/goawk', tag: 'v1.32.0', license: 'MIT' };
const PREBUILT = [
  { name: 'quickjs', file: 'qjs.wasm', license: 'MIT', version: 'v0.17.0',
    url: 'https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-wasi.wasm',
    sha256: '42a732a676ec2d93488c19411e0fad283bf72658fdad746f089914b523c783b1' },
];
const PYTHON = {
  version: '3.15.0', license: 'PSF-2.0',
  url: 'https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.15.0/python-3.15.0-wasi_sdk-33.zip',
  sha256: '00b791b3729230f97a625087f534d71978433fb1e068e13a9cac8cd3f2541742',
};

function log(msg) { console.log(`  → ${msg}`); }
function run(cmd, args, cwd, env, quiet = false) {
  execFileSync(cmd, args, { cwd, stdio: quiet ? 'ignore' : 'inherit', env: { ...process.env, ...env } });
}
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function download(url, dest, sha256) {
  if (!existsSync(dest) || sha256File(dest) !== sha256) {
    log(`download ${url}`);
    run('curl', ['-fsSL', '--retry', '3', '-o', dest, url]);
  }
  const got = sha256File(dest);
  if (got !== sha256) throw new Error(`sha256 mismatch for ${url}: ${got}`);
}

function clone(repo, tag, dir) {
  if (!existsSync(dir)) {
    log(`clone ${repo}@${tag}`);
    run('git', ['clone', '-q', '--depth', '1', '--branch', tag, `https://github.com/${repo}.git`, dir]);
  }
}

function main() {
  for (const d of [SRC, DL, OUT]) mkdirSync(d, { recursive: true });

  // wasi-sdk: C compiler + wasi-libc sysroot for C dependencies.
  const sdk = join(WORK, 'wasi-sdk');
  if (!existsSync(join(sdk, 'bin', 'clang'))) {
    const tgz = join(DL, 'wasi-sdk.tgz');
    download(WASI_SDK.url, tgz, WASI_SDK.sha256);
    mkdirSync(sdk, { recursive: true });
    run('tar', ['xzf', tgz, '-C', sdk, '--strip-components=1']);
  }
  const sysroot = join(sdk, 'share', 'wasi-sysroot');

  // cwd shim, linked into every Rust tool.
  const shimObj = join(WORK, 'cwd_init.o');
  log('compile cwd shim');
  run(join(sdk, 'bin', 'clang'), ['--target=wasm32-wasip1', `--sysroot=${sysroot}`, '-O2', '-c',
    join(ROOT, 'userland', 'shim', 'cwd_init.c'), '-o', shimObj]);

  const manifest = [];

  for (const t of RUST_TOOLS) {
    const dir = join(SRC, t.name);
    clone(t.repo, t.tag, dir);
    if (t.patch) {
      const patch = join(ROOT, 'userland', 'patches', t.patch);
      try {
        run('git', ['apply', '--check', patch], dir, undefined, true);
        run('git', ['apply', patch], dir);
        log(`applied ${t.patch}`);
      } catch {
        run('git', ['apply', '--reverse', '--check', patch], dir); // already applied
        log(`${t.patch} already applied`);
      }
    }
    log(`cargo build ${t.name}`);
    const env = { RUSTFLAGS: `-C link-arg=${shimObj}` };
    if (t.needsCC) {
      env.CC_wasm32_wasip1 = join(sdk, 'bin', 'clang');
      env.AR_wasm32_wasip1 = join(sdk, 'bin', 'llvm-ar');
      env.CFLAGS_wasm32_wasip1 = `--sysroot=${sysroot}`;
    }
    run('cargo', ['build', '--release', '--locked', '--target', 'wasm32-wasip1', ...(t.cargoArgs ?? [])], dir, env);
    for (const [from, to] of Object.entries(t.outputs)) {
      copyFileSync(join(dir, 'target', 'wasm32-wasip1', 'release', from), join(OUT, to));
      manifest.push({ file: to, package: t.name, version: t.tag, license: t.license, source: `https://github.com/${t.repo}` });
    }
  }

  // GoAWK: Go's wasip1 runtime handles $PWD natively.
  const awkDir = join(SRC, 'goawk');
  clone(GOAWK.repo, GOAWK.tag, awkDir);
  log('go build goawk');
  run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', join(OUT, 'awk.wasm'), '.'], awkDir,
    { GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0' });
  manifest.push({ file: 'awk.wasm', package: 'goawk', version: GOAWK.tag, license: GOAWK.license, source: `https://github.com/${GOAWK.repo}` });

  for (const p of PREBUILT) {
    const dest = join(DL, p.file);
    download(p.url, dest, p.sha256);
    copyFileSync(dest, join(OUT, p.file));
    manifest.push({ file: p.file, package: p.name, version: p.version, license: p.license, source: p.url });
  }

  if (!opts['no-python']) {
    const zip = join(DL, 'python.zip');
    download(PYTHON.url, zip, PYTHON.sha256);
    const unpacked = join(WORK, 'python');
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    run('unzip', ['-q', zip, '-d', unpacked]);
    copyFileSync(join(unpacked, 'python.wasm'), join(OUT, 'python.wasm'));
    // The stdlib ships as a plain tar rooted at lib/ (extracted under /usr).
    run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-cf', join(OUT, 'python-stdlib.tar'), 'lib'], unpacked);
    manifest.push({ file: 'python.wasm', package: 'python', version: PYTHON.version, license: PYTHON.license, source: PYTHON.url });
    manifest.push({ file: 'python-stdlib.tar', package: 'python', version: PYTHON.version, license: PYTHON.license, source: PYTHON.url });
  }

  for (const m of manifest) {
    const path = join(OUT, m.file);
    m.sha256 = sha256File(path);
    m.size = statSync(path).size;
  }
  writeFileSync(join(OUT, 'checksums.json'), JSON.stringify({ version: 1, files: manifest }, null, 2) + '\n');

  console.log('\nBuilt userland:');
  for (const f of readdirSync(OUT).sort()) {
    console.log(`  ${relative(ROOT, join(OUT, f)).padEnd(36)} ${(statSync(join(OUT, f)).size / 1048576).toFixed(1)} MB`);
  }
}

try {
  main();
} catch (err) {
  console.error(`\n✖ userland build failed: ${err.message}`);
  process.exit(1);
}
