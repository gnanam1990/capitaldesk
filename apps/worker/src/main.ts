import { assertMayMount } from '@capitaldesk/contracts';
import { loadWorkerConfig } from '@capitaldesk/config';
import { createLogger } from '@capitaldesk/observability';
import { runUntilShutdown } from './lifetime.js';

/**
 * Worker process entry point.
 *
 * At this milestone the worker starts, proves its credential-class boundary and idles. It
 * runs no ingest loop and reconciles nothing, because the read adapter (prompt 05) and the
 * journal (prompt 04) do not exist yet. Starting a loop that does nothing would make the
 * process look operational when it is not.
 */
const config = loadWorkerConfig();

// The worker may hold a read credential reference and must never hold a trade credential.
// loadWorkerConfig already refuses a trade variable; this asserts the same rule against the
// contracts table so the boundary is stated in one place and checked in two.
assertMayMount('worker', 'VENUE_READ');

const log = createLogger({
  role: 'worker',
  level: config.logLevel,
  buildId: config.buildId,
  deploymentEnvironment: config.deploymentEnvironment,
  accountAlias: config.accountAlias,
});

log.info(
  {
    readCredentialConfigured: config.readCredentialRef !== null,
    baselineEpoch: config.baselineEpoch,
    ingest: 'not_implemented',
  },
  'worker started; no ingest or reconciliation loop exists at this milestone',
);

// Blocks on a real referenced handle until SIGINT or SIGTERM. A pending promise alone does
// not keep Node alive: the process would exit with status 13 the moment logging flushed.
await runUntilShutdown(log);

log.info('shutdown complete');
