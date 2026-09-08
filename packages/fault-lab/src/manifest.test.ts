import { describe, expect, it } from 'vitest';
import { buildScenarioManifest, verifyScenarioManifest } from './manifest.js';
import { runDeterministicScenario } from './scenarios.js';

const input = () => ({
  commit: 'abcdef0123456789',
  schemaVersions: ['0001', '0008'],
  mode: 'local-fixture' as const,
  accountAlias: 'fault-proof',
  epoch: '12',
  seed: '20260908',
  faultBoundary: 'after-marker-before-response',
  actualIds: { planId: 'plan-fixture', attemptId: 'attempt-fixture' },
  results: [runDeterministicScenario('response-loss')],
});

describe('fault proof manifest', () => {
  it('binds reproducibility fields and verifies its canonical digest', () => {
    const manifest = buildScenarioManifest(input());
    expect(manifest.evidenceClass).toBe('DETERMINISTIC_FIXTURE');
    expect(manifest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyScenarioManifest(manifest)).toBe(true);
  });

  it('detects a changed commit, mode, epoch, id or outcome', () => {
    const original = buildScenarioManifest(input());
    for (const changed of [
      { ...original, commit: 'bbbbbbb' },
      { ...original, mode: 'real-testnet' as const },
      { ...original, epoch: '13' },
      { ...original, actualIds: { planId: 'different' } },
      { ...original, results: [runDeterministicScenario('testnet-reset')] },
    ]) {
      expect(verifyScenarioManifest(changed), JSON.stringify(changed)).toBe(false);
    }
  });

  it('labels real testnet evidence without pretending fixtures observed a venue', () => {
    expect(buildScenarioManifest({ ...input(), mode: 'real-testnet' }).evidenceClass).toBe(
      'VENUE_OBSERVED_TESTNET',
    );
  });
});
