import { Pool } from 'pg';
import { loadApiConfig } from '@capitaldesk/config';
import { buildServer } from './server.js';

/**
 * The shipped API process.
 *
 * The identity surface is switched on by passing a connection pool to `buildServer`, and this
 * entry point did not pass one — so every authentication route proven by the injected server
 * tests was absent from the process an operator actually starts, and answered 404. Tests that
 * construct the server themselves cannot catch that: the defect is in what production wires
 * together, not in what the routes do.
 */
const config = loadApiConfig();

/**
 * One pool for the process, sized for a single-owner console.
 *
 * `IdentityRepository.transaction` checks out a client for the length of a write, so the pool
 * must have room for concurrent requests plus the health probe's own connection.
 */
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
});

const app = buildServer(config, { identityPool: pool });

/**
 * Shut down once, in order, and within a bound.
 *
 * Fastify first so in-flight requests finish before their connections are taken away, then the
 * pool. The guard makes a second signal a no-op rather than a concurrent second teardown, and
 * the handlers stay registered until the work settles — removing them early meant a repeated
 * signal killed the process mid-cleanup.
 *
 * Both steps are bounded. `app.close()` waits for open connections and `pool.end()` waits for
 * checked-out clients, so either can wait indefinitely on a stuck request or a hung query, and
 * a supervisor would then escalate to SIGKILL. Timing out here instead means the process exits
 * on its own and says so with a non-zero code, rather than appearing to hang.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function within(work: Promise<unknown>, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not finish within ${SHUTDOWN_TIMEOUT_MS}ms`)),
          SHUTDOWN_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = code;
  try {
    await within(app.close(), 'closing the HTTP server');
  } catch (error) {
    app.log.error({ err: error }, 'the HTTP server did not close cleanly');
    exitCode = 1;
  }
  try {
    await within(pool.end(), 'closing the database pool');
  } catch (error) {
    app.log.error({ err: error }, 'the database pool did not close cleanly');
    exitCode = 1;
  }
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

try {
  await app.listen({ port: config.httpPort, host: '127.0.0.1' });
} catch (error) {
  // A failed listen must not leave the pool's connections open behind a process that is about
  // to report failure.
  app.log.error({ err: error }, 'the API failed to start');
  await shutdown(1);
}
