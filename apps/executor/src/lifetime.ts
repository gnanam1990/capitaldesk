import type { Logger } from '@capitaldesk/observability';

/**
 * Keep a long-running process alive until it is asked to stop.
 *
 * A pending top-level `await` does **not** keep Node alive. With no other handle registered,
 * the event loop drains as soon as startup logging flushes and Node exits with status 13,
 * printing "Detected unsettled top-level await". Both long-running processes here did exactly
 * that: they logged that they had started and then exited immediately, which in a supervised
 * deployment is a crash loop rather than an idle service.
 *
 * The fix is an actual referenced handle. The interval does nothing except exist; clearing it
 * on shutdown lets the loop drain naturally, so the process exits on its own once its
 * shutdown work is done rather than being killed mid-flush.
 *
 * Duplicated in the worker and the executor deliberately: they must not import each other,
 * and a shared runtime package for twenty lines would be worse than two copies that are
 * verified by their own tests.
 */
export interface ShutdownContext {
  readonly signal: NodeJS.Signals;
}

export function runUntilShutdown(
  log: Logger,
  onShutdown?: (context: ShutdownContext) => Promise<void> | void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // A referenced handle. Without this the event loop has nothing to wait on.
    const keepAlive = setInterval(() => {}, 60_000);

    let stopping = false;

    const handlers = new Map<NodeJS.Signals, () => void>();
    const removeHandlers = (): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    };

    const stop = (signal: NodeJS.Signals): void => {
      // A repeat signal during shutdown is ignored rather than racing the first. The
      // handlers must stay installed for this to work: with `process.once` the listener is
      // removed as it fires, so a second SIGTERM reached Node's default handler and killed
      // the process mid-cleanup — exit 143 with the shutdown work half done. Handlers are
      // therefore removed only after cleanup settles.
      if (stopping) {
        log.warn({ signal }, 'shutdown already in progress; ignoring repeat signal');
        return;
      }
      stopping = true;
      log.info({ signal }, 'shutdown requested');

      void (async () => {
        try {
          await onShutdown?.({ signal });
          clearInterval(keepAlive);
          removeHandlers();
          resolve();
        } catch (error) {
          clearInterval(keepAlive);
          removeHandlers();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = (): void => {
        stop(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  });
}
