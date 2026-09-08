/**
 * Make this process a transparent parent of `child`.
 *
 * Termination signals are forwarded, and the child's outcome decides ours. Without this a
 * supervisor's SIGTERM stopped the wrapper and left the child - Next, in production - running,
 * so `pnpm start` appeared stopped while the web server was still up.
 *
 * A child killed by a signal is reported the way a shell reports it, as 128 plus the signal
 * number, because a parent that swallowed that would hide how the child actually died.
 */
/** @type {Record<string, number>} */
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/**
 * @param {import('node:child_process').ChildProcess} child
 */
export function forwardSignalsTo(child) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
    process.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }
  child.on('exit', (code, signal) => {
    if (signal !== null) process.exit(128 + (SIGNAL_NUMBERS[signal] ?? 0));
    process.exit(code ?? 1);
  });
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
