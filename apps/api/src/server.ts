import Fastify from 'fastify';
import { Client } from 'pg';
import type { ApiConfig } from '@capitaldesk/config';
import { createLogger } from '@capitaldesk/observability';
import { liveness, readiness, type DependencyReport } from './health.js';

async function probeDatabase(databaseUrl: string): Promise<DependencyReport> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
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
    await client.end().catch(() => undefined);
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
