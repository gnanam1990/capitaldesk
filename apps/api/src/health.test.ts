import { describe, expect, it } from 'vitest';
import { liveness, readiness } from './health.js';

describe('health reporting', () => {
  it('separates liveness from readiness', () => {
    expect(liveness('build-1', 12.9).status).toBe('live');
    expect(liveness('build-1', 12.9).uptimeSeconds).toBe(12);
  });

  it('is not ready when a dependency is down', () => {
    const report = readiness({
      buildId: 'build-1',
      deploymentEnvironment: 'testnet',
      accountAlias: 'capitaldesk-proof',
      baselineEpoch: 1,
      dependencies: [{ name: 'postgres', state: 'down', detail: 'connection refused' }],
    });
    expect(report.status).toBe('not_ready');
  });

  it('is ready when every dependency is up', () => {
    const report = readiness({
      buildId: 'build-1',
      deploymentEnvironment: 'testnet',
      accountAlias: 'capitaldesk-proof',
      baselineEpoch: 1,
      dependencies: [{ name: 'postgres', state: 'up', detail: 'ok' }],
    });
    expect(report.status).toBe('ready');
  });

  /**
   * "Connected" is not "safe to execute" (UI-UX section 3). A ready process with a healthy
   * database must still report execution as unavailable, because no execution path exists.
   */
  it('reports execution as unavailable even when everything is ready', () => {
    const report = readiness({
      buildId: 'build-1',
      deploymentEnvironment: 'testnet',
      accountAlias: 'capitaldesk-proof',
      baselineEpoch: 1,
      dependencies: [{ name: 'postgres', state: 'up', detail: 'ok' }],
    });
    expect(report.status).toBe('ready');
    expect(report.execution.available).toBe(false);
    expect(report.execution.reason).toMatch(/No governed execution path is implemented/);
  });

  it('states the account, environment and epoch every report belongs to', () => {
    const report = readiness({
      buildId: 'build-1',
      deploymentEnvironment: 'testnet',
      accountAlias: 'capitaldesk-proof',
      baselineEpoch: 3,
      dependencies: [],
    });
    expect(report.deploymentEnvironment).toBe('testnet');
    expect(report.baselineEpoch).toBe(3);
    expect(report.contractsVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
