import Fastify, { type FastifyInstance } from 'fastify';
import { Client, type Pool } from 'pg';
import type { ApiConfig } from '@capitaldesk/config';
import { createLogger } from '@capitaldesk/observability';
import { liveness, readiness, type DependencyReport } from './health.js';
import authPlugin from './auth/plugin.js';
import { registerAuthRoutes } from './auth/routes.js';
import { IdentityRepository } from './auth/repository.js';
import { resolveOwnerSessionSecret } from './auth/session-secret.js';
import {
  ApprovalRepository,
  EventRepository,
  IntentRepository,
  PolicyRepository,
  PublicReadRepository,
} from '@capitaldesk/db';
import { registerIntentRoutes } from './intents/routes.js';
import { registerPolicyRoutes } from './policies/routes.js';
import { registerApprovalRoutes } from './approvals/routes.js';
import { API_BODY_LIMIT_BYTES, applySecurityHeaders } from './security-headers.js';
import { registerOperationalRoutes } from './operations/routes.js';

/**
 * Probe PostgreSQL with every step bounded.
 *
 * Only the connection had a timeout, so a server that accepted the connection and then
 * stalled serving the query left `/health/ready` hanging instead of returning the 503 it
 * already has a state for. A readiness endpoint that can hang is worse than one that reports
 * down: a load balancer waits on it instead of failing over.
 *
 * The bounds come from the driver rather than a promise race. A race leaves the underlying
 * query in flight and does not cover the statements around it, so the connection teardown in
 * `finally` can hang on exactly the black-holed socket the race was meant to escape.
 *
 *  - `connectionTimeoutMillis` bounds the handshake.
 *  - `query_timeout` bounds each query client-side, which is what covers a socket that
 *    accepts bytes and never answers.
 *  - `statement_timeout` bounds it server-side too, so a query that did reach a live server
 *    is cancelled there rather than left running after we stop waiting.
 *  - teardown is bounded, and the socket is destroyed if a graceful end does not settle.
 */
const HEALTH_TIMEOUT_MS = 2000;

async function closeQuietly(client: Client): Promise<void> {
  // `end()` performs a graceful shutdown, which can itself hang on a black-holed socket.
  const destroy = (): void => {
    const stream = (client as unknown as { connection?: { stream?: { destroy(): void } } })
      .connection?.stream;
    stream?.destroy();
  };
  try {
    await Promise.race([
      client.end(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          destroy();
          resolve();
        }, HEALTH_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch {
    destroy();
  }
}

async function probeDatabase(databaseUrl: string): Promise<DependencyReport> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: HEALTH_TIMEOUT_MS,
    query_timeout: HEALTH_TIMEOUT_MS,
    statement_timeout: HEALTH_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { name: 'postgres', state: 'up', detail: 'connection and trivial query succeeded' };
  } catch (error) {
    return {
      name: 'postgres',
      state: 'down',
      detail: error instanceof Error ? error.name : 'unknown error',
    };
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Build the server, optionally with the identity surface.
 *
 * The auth routes need a connection pool, which the health-only server does not have. Passing
 * one in is what turns them on, so a deployment that has not configured a database gets a
 * server with no authentication surface rather than one that fails per request.
 */
export interface ServerDependencies {
  readonly identityPool?: Pool;
}

export function buildServer(config: ApiConfig, dependencies: ServerDependencies = {}) {
  /**
   * Normalised to the default `FastifyInstance` at this one boundary.
   *
   * Passing a Pino instance as `loggerInstance` makes Fastify infer a logger generic that is
   * structurally compatible with `FastifyBaseLogger` but not assignable to it under
   * `exactOptionalPropertyTypes`. Without this the instance type differs from every helper
   * that takes a `FastifyInstance`, and the difference propagates through the whole route
   * surface for no behavioural reason.
   */
  const app = Fastify({
    loggerInstance: createLogger({
      role: 'api',
      level: config.logLevel,
      buildId: config.buildId,
      deploymentEnvironment: config.deploymentEnvironment,
      accountAlias: config.accountAlias,
    }),
    // Fastify's default ajv strips unknown properties. Rejecting them instead makes a body
    // that carries an identity field a visible error rather than a silently ignored one, so
    // an attempt to smuggle a role or a workspace id fails loudly.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    bodyLimit: API_BODY_LIMIT_BYTES,
  }) as unknown as FastifyInstance;

  const secureTransport = config.deploymentEnvironment !== 'local';
  app.addHook('onRequest', (_request, reply, done) => {
    applySecurityHeaders(reply, secureTransport);
    done();
  });

  const startedAt = Date.now();

  app.get('/health/live', () => liveness(config.buildId, (Date.now() - startedAt) / 1000));

  app.get('/health/ready', async (_request, reply) => {
    const report = readiness({
      buildId: config.buildId,
      deploymentEnvironment: config.deploymentEnvironment,
      accountAlias: config.accountAlias,
      baselineEpoch: config.baselineEpoch,
      dependencies: [await probeDatabase(config.databaseUrl)],
    });
    reply.code(report.status === 'ready' ? 200 : 503);
    return report;
  });

  const identityPool = dependencies.identityPool;
  if (identityPool !== undefined) {
    const repository = new IdentityRepository(identityPool);
    const secureCookies = secureTransport;
    void app
      .register(authPlugin, {
        repository,
        environment: config.deploymentEnvironment,
        secureCookies,
        // Resolved from the reference, never the reference itself. Signing with the
        // reference would give every deployment that used the same conventional path an
        // identical, guessable key — and would never read the mounted secret at all.
        sessionSecret: resolveOwnerSessionSecret(config.ownerSessionSecretRef),
      })
      .after(() => {
        registerAuthRoutes(app, {
          repository,
          environment: config.deploymentEnvironment,
          secureCookies,
        });
        registerIntentRoutes(app, { repository: new IntentRepository(identityPool) });
        registerPolicyRoutes(app, { repository: new PolicyRepository(identityPool) });
        registerApprovalRoutes(app, { repository: new ApprovalRepository(identityPool) });
        registerOperationalRoutes(app, {
          reads: new PublicReadRepository(identityPool),
          events: new EventRepository(identityPool),
        });
      });
  }

  // Unknown routes fail with the stable transport envelope.
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      code: 'UNSUPPORTED_ACTION',
      message: 'route not implemented at this milestone',
      correlationId: request.id,
      retryable: false,
    });
  });

  return app;
}
