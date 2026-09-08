import Fastify from 'fastify';
import { Client } from 'pg';
import type { ApiConfig } from '@capitaldesk/config';
import { createLogger } from '@capitaldesk/observability';
import { liveness, readiness, type DependencyReport } from './health.js';

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

export function buildServer(config: ApiConfig) {
  const app = Fastify({
    loggerInstance: createLogger({
      role: 'api',
      level: config.logLevel,
      buildId: config.buildId,
      deploymentEnvironment: config.deploymentEnvironment,
      accountAlias: config.accountAlias,
    }),
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

  // There is deliberately no /v1 surface yet. Routes arrive with the domain behaviour they
  // expose (prompts 03, 07, 17); an endpoint that returns a plausible shape without the
  // behaviour behind it would be a false claim of capability.
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
