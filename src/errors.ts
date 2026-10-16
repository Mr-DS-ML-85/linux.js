/**
 * linux.js — error types. License: MIT.
 */

/**
 * Thrown by APIs that need a guest userland (a shell, `exec`, agent
 * `run`/`stream`/`session`).
 *
 * linux.js runs the kernel as a library (LKL): there is no process image
 * to exec — LKL's binfmt only intercepts `/init` to finish boot, and the
 * kernel cannot load WebAssembly user programs. Filesystem APIs work
 * through real kernel syscalls; shell execution does not exist yet.
 */
export class ExecNotSupportedError extends Error {
  constructor(what = 'shell execution') {
    super(
      `linux.js: ${what} needs a guest userland, which this build does not have. ` +
      'The kernel runs in library mode: use the filesystem APIs (writeFile, readFile, ' +
      'readdir, stat, mkdir, rm, cp), which go through real kernel syscalls.',
    );
    this.name = 'ExecNotSupportedError';
  }
}

/** Thrown when the guest kernel panics. The instance cannot be used afterwards. */
export class KernelPanicError extends Error {
  /** Kernel console output captured up to the panic. */
  readonly log: string;

  constructor(log: string, cause?: unknown) {
    super(`linux.js: kernel panic.\n${log.slice(-4096)}`);
    this.name = 'KernelPanicError';
    this.log = log;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
