import { describe, expect, it } from 'vitest';
import {
  healthUrl,
  parseReadiness,
  resolveDeploymentFacts,
  type Readiness,
  type ReadinessReport,
} from './readiness.js';

const CONFIG = {
  accountAlias: 'capitaldesk-local',
  deploymentEnvironment: 'local',
  baselineEpoch: 1,
  buildId: 'web-build',
};

function report(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    status: 'ready',
    buildId: 'api-build',
    contractsVersion: '1.1.0-amended',
    deploymentEnvironment: 'testnet',
    accountAlias: 'capitaldesk-proof',
    baselineEpoch: 3,
    dependencies: [{ name: 'postgres', state: 'up', detail: 'ok' }],
    execution: { available: false, reason: 'no governed execution path exists' },
    ...overrides,
  };
}

// --- regression: PR 1 review, a trailing slash made a healthy API look unreachable -------
describe('health URL', () => {
  it('normalises a trailing slash', () => {
    expect(healthUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/health/ready');
  });

  it('normalises repeated trailing slashes', () => {
    expect(healthUrl('http://127.0.0.1:3000///')).toBe('http://127.0.0.1:3000/health/ready');
  });

  it('leaves a clean base URL alone', () => {
    expect(healthUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/health/ready');
  });

  it('preserves a path prefix', () => {
    expect(healthUrl('https://host/api/')).toBe('https://host/api/health/ready');
  });
});

// --- regression: PR 1 review, a type assertion validated nothing -------------------------
describe('readiness payload validation', () => {
  it('accepts a well-formed report', () => {
    expect(parseReadiness(report())).not.toBeNull();
  });

  it('rejects a payload that is not an object', () => {
    for (const value of [null, undefined, 'ready', 42, []]) {
      expect(parseReadiness(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('rejects a missing or malformed field', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['status', 'degraded'],
      ['buildId', 42],
      ['buildId', ''],
      ['contractsVersion', null],
      ['deploymentEnvironment', undefined],
      ['accountAlias', ''],
      ['baselineEpoch', '3'],
      ['baselineEpoch', 0],
      ['baselineEpoch', 1.5],
      ['dependencies', 'postgres'],
      ['execution', null],
    ];
    for (const [key, value] of cases) {
      expect(parseReadiness({ ...report(), [key]: value }), `${key}=${String(value)}`).toBeNull();
    }
  });

  it('rejects a dependency state outside the known set', () => {
    const bad = report({
      dependencies: [{ name: 'postgres', state: 'degraded' as never, detail: 'ok' }],
    });
    expect(parseReadiness(bad)).toBeNull();
  });

  it('accepts every documented dependency state, paired with a coherent status', () => {
    const cases = [
      ['up', 'ready'],
      ['down', 'not_ready'],
      ['not_configured', 'not_ready'],
    ] as const;
    for (const [state, status] of cases) {
      const value = report({ status, dependencies: [{ name: 'postgres', state, detail: 'd' }] });
      expect(parseReadiness(value), state).not.toBeNull();
    }
  });

  it('rejects an API claiming execution is available', () => {
    // A console that rendered this would be advertising a capability that does not exist.
    const claiming = { ...report(), execution: { available: true, reason: 'ready to trade' } };
    expect(parseReadiness(claiming)).toBeNull();
  });

  it('rejects an execution block with no reason', () => {
    expect(parseReadiness({ ...report(), execution: { available: false, reason: '' } })).toBeNull();
  });

  it('rejects an unrecognised deployment environment', () => {
    for (const environment of ['staging', 'prod', 'TESTNET', 'production']) {
      expect(
        parseReadiness(report({ deploymentEnvironment: environment })),
        environment,
      ).toBeNull();
    }
  });

  it('accepts every documented deployment environment', () => {
    for (const environment of ['local', 'testnet', 'production-read-only']) {
      const value = report({
        deploymentEnvironment: environment,
        dependencies: [{ name: 'postgres', state: 'up', detail: 'ok' }],
        status: 'ready',
      });
      expect(parseReadiness(value), environment).not.toBeNull();
    }
  });

  describe('the summary must agree with the detail', () => {
    it('rejects ready while a dependency is down', () => {
      const contradictory = report({
        status: 'ready',
        dependencies: [{ name: 'postgres', state: 'down', detail: 'connection refused' }],
      });
      expect(parseReadiness(contradictory)).toBeNull();
    });

    it('rejects ready while a dependency is not configured', () => {
      const contradictory = report({
        status: 'ready',
        dependencies: [{ name: 'postgres', state: 'not_configured', detail: 'absent' }],
      });
      expect(parseReadiness(contradictory)).toBeNull();
    });

    it('rejects not_ready while every dependency is up', () => {
      const contradictory = report({
        status: 'not_ready',
        dependencies: [{ name: 'postgres', state: 'up', detail: 'ok' }],
      });
      expect(parseReadiness(contradictory)).toBeNull();
    });

    it('accepts ready with an empty dependency list, which is vacuously all up', () => {
      expect(parseReadiness(report({ status: 'ready', dependencies: [] }))).not.toBeNull();
    });

    it('accepts a coherent mixed report', () => {
      const coherent = report({
        status: 'not_ready',
        dependencies: [
          { name: 'postgres', state: 'up', detail: 'ok' },
          { name: 'venue-reader', state: 'not_configured', detail: 'no credential' },
        ],
      });
      expect(parseReadiness(coherent)).not.toBeNull();
    });
  });

  it('accepts a not_ready report, which is a real state and not a transport failure', () => {
    const notReady = report({
      status: 'not_ready',
      dependencies: [{ name: 'postgres', state: 'down', detail: 'connection refused' }],
    });
    expect(parseReadiness(notReady)?.status).toBe('not_ready');
  });
});

// --- regression: PR 1 review, config was displayed as though it described the API ---------
describe('which deployment facts the console may present', () => {
  const reachable = (r: ReadinessReport): Readiness => ({ kind: 'reachable', report: r });
  const unreachable: Readiness = { kind: 'unreachable', detail: 'fetch failed' };

  it('renders the API report when reachable, not the console configuration', () => {
    const facts = resolveDeploymentFacts(CONFIG, reachable(report()));
    expect(facts.source).toBe('api');
    expect(facts.accountAlias).toBe('capitaldesk-proof');
    expect(facts.deploymentEnvironment).toBe('testnet');
    expect(facts.baselineEpoch).toBe('3');
    expect(facts.buildId).toBe('api-build');
  });

  it('reports every field where the console disagrees with the API', () => {
    const facts = resolveDeploymentFacts(CONFIG, reachable(report()));
    expect(facts.mismatches).toEqual(['account alias', 'environment', 'baseline epoch', 'build']);
  });

  it('reports no mismatch when they agree', () => {
    const agreeing = report({
      accountAlias: CONFIG.accountAlias,
      deploymentEnvironment: CONFIG.deploymentEnvironment,
      baselineEpoch: CONFIG.baselineEpoch,
      buildId: CONFIG.buildId,
    });
    expect(resolveDeploymentFacts(CONFIG, reachable(agreeing)).mismatches).toEqual([]);
  });

  it('names only the fields that actually differ', () => {
    const partly = report({
      accountAlias: CONFIG.accountAlias,
      deploymentEnvironment: CONFIG.deploymentEnvironment,
      buildId: CONFIG.buildId,
    });
    expect(resolveDeploymentFacts(CONFIG, reachable(partly)).mismatches).toEqual([
      'baseline epoch',
    ]);
  });

  it('still reports the API values even when a not_ready report disagrees', () => {
    const facts = resolveDeploymentFacts(CONFIG, reachable(report({ status: 'not_ready' })));
    expect(facts.source).toBe('api');
    expect(facts.accountAlias).toBe('capitaldesk-proof');
  });

  it('falls back to configuration only when unreachable, and labels it as such', () => {
    const facts = resolveDeploymentFacts(CONFIG, unreachable);
    expect(facts.source).toBe('console-configuration');
    expect(facts.accountAlias).toBe('capitaldesk-local');
    expect(facts.buildId).toBe('web-build');
  });

  it('never claims a mismatch when there is no API report to compare against', () => {
    // A mismatch is a statement about two observations. With one, there is nothing to say.
    expect(resolveDeploymentFacts(CONFIG, unreachable).mismatches).toEqual([]);
  });

  it('never presents configured values as an API observation', () => {
    expect(resolveDeploymentFacts(CONFIG, unreachable).source).not.toBe('api');
  });
});
