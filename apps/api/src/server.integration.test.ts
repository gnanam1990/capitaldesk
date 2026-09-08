import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadApiConfig } from '@capitaldesk/config';
import { buildServer } from './server.js';

/**
 * Integration evidence: the real Fastify server and a real PostgreSQL probe.
 * Skipped with a visible reason when no test database is configured.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const BASE_ENV = {
  CAPITALDESK_ENV: 'local',
  CAPITALDESK_VENUE: 'binance-spot',
  CAPITALDESK_VENUE_BASE_URL: 'http://127.0.0.1:9443',
  CAPITALDESK_ACCOUNT_ALIAS: 'capitaldesk-local',
  CAPITALDESK_BASELINE_EPOCH: '1',
  CAPITALDESK_LOG_LEVEL: 'fatal',
  CAPITALDESK_BUILD_ID: 'integration-test',
  CAPITALDESK_API_PORT: '3000',
  CAPITALDESK_OWNER_SESSION_SECRET_REF: 'file:///dev/null',
} satisfies NodeJS.ProcessEnv;

describeIfDatabase('API health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildServer(loadApiConfig({ ...BASE_ENV, DATABASE_URL }));
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
      loadApiConfig({ ...BASE_ENV, DATABASE_URL: 'postgres://127.0.0.1:1/nonexistent' }),
    );
    try {
      const response = await broken.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ status: string }>().status).toBe('not_ready');
    } finally {
      await broken.close();
    }
  });

  // --- regression: PR 1 review, a stalled query could hang readiness -------------------
  // Only the connection was bounded, so a server that completed the handshake and then went
  // silent left /health/ready hanging instead of returning its 503.
  describe('a stalled database does not hang readiness', () => {
    const proxies: net.Server[] = [];

    afterEach(async () => {
      await Promise.all(
        proxies
          .splice(0)
          .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    });

    interface StallingProxy {
      readonly url: string;
      /**
       * Whether the proxy actually saw the client send a Query message.
       *
       * Without this the test can pass for the wrong reason: if the connection failed —
       * wrong password, wrong database — readiness returns its 503 quickly and every other
       * assertion still holds, while `SELECT 1` was never reached and nothing was stalled.
       */
      didObserveQuery(): boolean;
    }

    /**
     * A fault proxy that forwards the startup handshake to the real server and then stops
     * forwarding once the client issues its first Query message ('Q'). The connection stays
     * open and writable; the query simply never receives an answer, which is exactly the case
     * a connection timeout alone does not cover.
     */
    async function stallingProxy(): Promise<StallingProxy> {
      // Clone the configured URL and change only where it points, so credentials, database
      // name and query parameters are preserved. Reconstructing it dropped the password, so
      // in an environment that uses one the connection failed auth instead of stalling.
      const target = new URL(DATABASE_URL!);
      const upstreamHost = target.hostname;
      const upstreamPort = Number(target.port || '5432');

      let observedQuery = false;
      const server = net.createServer((clientSocket) => {
        const upstream = net.connect({ host: upstreamHost, port: upstreamPort });
        let stalled = false;
        clientSocket.on('data', (chunk: Buffer) => {
          if (!stalled && chunk.length > 0 && chunk[0] === 0x51 /* 'Q' */) {
            stalled = true;
            observedQuery = true;
          }
          if (!stalled) upstream.write(chunk);
        });
        upstream.on('data', (chunk: Buffer) => {
          if (!stalled) clientSocket.write(chunk);
        });
        const close = (): void => {
          upstream.destroy();
          clientSocket.destroy();
        };
        clientSocket.on('error', close);
        upstream.on('error', close);
        clientSocket.on('close', close);
      });
      proxies.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

      const address = server.address() as net.AddressInfo;
      const proxied = new URL(target.toString());
      proxied.hostname = '127.0.0.1';
      proxied.port = String(address.port);

      return { url: proxied.toString(), didObserveQuery: () => observedQuery };
    }

    it('returns a bounded 503 after the query stalls, having actually reached the query', async () => {
      const proxy = await stallingProxy();
      const stalled = buildServer(loadApiConfig({ ...BASE_ENV, DATABASE_URL: proxy.url }));
      try {
        const started = Date.now();
        const response = await stalled.inject({ method: 'GET', url: '/health/ready' });
        const elapsed = Date.now() - started;
        const body = response.json<{
          status: string;
          dependencies: Array<{ name: string; state: string }>;
        }>();

        // All four together are the proof. Without the last one the test could pass on an
        // authentication failure, having never stalled anything.
        expect(
          proxy.didObserveQuery(),
          'proxy never saw a query; the stall was not exercised',
        ).toBe(true);
        expect(response.statusCode).toBe(503);
        expect(body.status).toBe('not_ready');
        expect(body.dependencies.find((d) => d.name === 'postgres')?.state).toBe('down');
        // Bounded by the driver's query timeout plus teardown. Before the fix this request
        // did not return at all.
        expect(elapsed, `readiness took ${elapsed}ms`).toBeLessThan(8000);
      } finally {
        await stalled.close();
      }
    }, 20_000);
  });

  it('refuses an unimplemented route with a stable reason code, not a plausible shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/pools' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('UNSUPPORTED_ACTION');
  });
});
