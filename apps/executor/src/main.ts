import { assertMayMount } from '@capitaldesk/contracts';
import { loadExecutorConfig } from '@capitaldesk/config';
import { createLogger } from '@capitaldesk/observability';
import { runUntilShutdown } from './lifetime.js';

/**
 * Executor process entry point.
 *
 * The executor holds the only trade credential reference in the deployment. At this
 * Signing and one-shot transmission are available only through the approval-bound journal
 * path. This process does not autonomously scan pools: a scoped dispatch job must supply the
 * approved plan and verified venue metadata. With write capability disabled it remains an
 * inert deployment probe.
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
    dispatchPath: 'approval_bound_one_shot',
    autonomousPoolScanning: false,
    authorizationDurability: config.authorizationDurability,
    signedRequestValidityMs: config.signedRequestValidityMs,
    clockSkewBudgetMs: config.clockSkewBudgetMs,
  },
  'executor started; approval-bound dispatch boundary loaded',
);

// Blocks on a real referenced handle until SIGINT or SIGTERM. A pending promise alone does
// not keep Node alive: the process would exit with status 13 the moment logging flushed.
await runUntilShutdown(log);

log.info('shutdown complete');
