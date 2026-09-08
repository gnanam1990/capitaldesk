import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadApiConfig } from '@capitaldesk/config';
import { buildServer } from './server.js';

/**
 * Integration evidence: the real Fastify server and a real PostgreSQL probe.
 * Skipped with a visible reason when no test database is configured.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describeIfDatabase('API health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildServer(
      loadApiConfig({
        CAPITALDESK_ENV: 'local',
        CAPITALDESK_VENUE: 'binance-spot',
        CAPITALDESK_VENUE_BASE_URL: 'http://127.0.0.1:9443',
        CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
        CAPITALDESK_BASELINE_EPOCH: '1',
        CAPITALDESK_LOG_LEVEL: 'fatal',
        CAPITALDESK_BUILD_ID: 'integration-test',
        CAPITALDESK_API_PORT: '3000',
        CAPITALDESK_OWNER_SESSION_SECRET_REF: 'file:///dev/null',
        DATABASE_URL,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness without touching a dependency', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('live');
  });

  it('reports readiness with a real database probe', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      dependencies: Array<{ name: string; state: string }>;
      execution: { available: boolean };
    }>();
    expect(body.status).toBe('ready');
    expect(body.dependencies.find((d) => d.name === 'postgres')?.state).toBe('up');
    // Ready, with a live database, and still explicitly unable to execute.
    expect(body.execution.available).toBe(false);
  });

  it('returns 503 and a down dependency when the database is unreachable', async () => {
    const broken = buildServer(
      loadApiConfig({
        CAPITALDESK_ENV: 'local',
        CAPITALDESK_VENUE: 'binance-spot',
        CAPITALDESK_VENUE_BASE_URL: 'http://127.0.0.1:9443',
        CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
        CAPITALDESK_BASELINE_EPOCH: '1',
        CAPITALDESK_LOG_LEVEL: 'fatal',
        CAPITALDESK_BUILD_ID: 'integration-test',
        CAPITALDESK_API_PORT: '3000',
        CAPITALDESK_OWNER_SESSION_SECRET_REF: 'file:///dev/null',
        DATABASE_URL: 'postgres://127.0.0.1:1/nonexistent',
      }),
    );
    try {
      const response = await broken.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ status: string }>().status).toBe('not_ready');
    } finally {
      await broken.close();
    }
  });

  it('refuses an unimplemented route with a stable reason code, not a plausible shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/pools' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('UNSUPPORTED_ACTION');
  });
});
