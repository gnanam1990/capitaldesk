import { afterEach, describe, expect, it } from 'vitest';
import type { ApiConfig } from '@capitaldesk/config';
import { buildServer } from './server.js';
import { API_BODY_LIMIT_BYTES } from './security-headers.js';

const apps: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function config(deploymentEnvironment: 'local' | 'testnet' | 'production-read-only'): ApiConfig {
  return {
    role: 'api',
    deploymentEnvironment,
    economicEnvironment:
      deploymentEnvironment === 'production-read-only' ? 'production' : deploymentEnvironment,
    venue: 'binance-spot',
    venueBaseUrl:
      deploymentEnvironment === 'production-read-only'
        ? 'https://api.binance.com'
        : deploymentEnvironment === 'testnet'
          ? 'https://testnet.binance.vision'
          : 'http://127.0.0.1:9443',
    accountAlias: 'security-test',
    baselineEpoch: 1,
    logLevel: 'fatal',
    buildId: 'security-test-build',
    databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
    httpPort: 3000,
    httpHost: '127.0.0.1',
    ownerSessionSecretRef: 'env://UNUSED_FOR_HEALTH_ONLY',
  };
}

describe('API server security boundary', () => {
  it('applies restrictive headers to real Fastify responses and bounds bodies', async () => {
    const app = buildServer(config('testnet'));
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(app.initialConfig.bodyLimit).toBe(API_BODY_LIMIT_BYTES);
  });

  it('does not advertise HSTS on the local HTTP fixture', async () => {
    const app = buildServer(config('local'));
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
