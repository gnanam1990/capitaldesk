import { assertMayMount } from '@capitaldesk/contracts';
import { loadExecutorConfig } from '@capitaldesk/config';
import { createLogger } from '@capitaldesk/observability';
import { runUntilShutdown } from './lifetime.js';

/**
 * Executor process entry point.
 *
 * The executor holds the only trade credential reference in the deployment. At this
 * milestone it has no dispatch path at all: there is no write adapter, no dispatch marker
 * table and no signing code. It starts, reports that write capability is unavailable and
 * idles. It will not acquire a dispatch path until prompts 12 and 13, and not a real one
 * until the integration gate passes.
 */
const config = loadExecutorConfig();

assertMayMount('executor', 'VENUE_TRADE');

const log = createLogger({
  role: 'executor',
  level: config.logLevel,
  buildId: config.buildId,
  deploymentEnvironment: config.deploymentEnvironment,
  accountAlias: config.accountAlias,
});

log.info(
  {
    writeCapability: config.writeCapability,
    tradeCredentialConfigured: config.tradeCredentialRef !== null,
    dispatchPath: 'not_implemented',
    authorizationDurability: config.authorizationDurability,
    signedRequestValidityMs: config.signedRequestValidityMs,
    clockSkewBudgetMs: config.clockSkewBudgetMs,
  },
  'executor started; no dispatch path is implemented at this milestone',
);

// Blocks on a real referenced handle until SIGINT or SIGTERM. A pending promise alone does
// not keep Node alive: the process would exit with status 13 the moment logging flushed.
await runUntilShutdown(log);

log.info('shutdown complete');
