import { describe, expect, it } from 'vitest';
import { BoundedMetricRegistry, METRICS } from './metrics.js';

describe('bounded operational metrics', () => {
  it('records central silent-failure signals as exact nonnegative values', () => {
    const metrics = new BoundedMetricRegistry();
    metrics.set(METRICS.unknownAgeSeconds, { environment: 'testnet' }, 91n);
    metrics.set(
      METRICS.sourceHealth,
      { environment: 'testnet', source: 'fills', state: 'stale' },
      1n,
    );
    expect(metrics.snapshot()).toEqual([
      {
        name: 'capitaldesk_source_health',
        labels: { environment: 'testnet', source: 'fills', state: 'stale' },
        value: '1',
      },
      {
        name: 'capitaldesk_unknown_age_seconds',
        labels: { environment: 'testnet' },
        value: '91',
      },
    ]);
  });

  it('rejects identifiers that would create unbounded cardinality or leak context', () => {
    const metrics = new BoundedMetricRegistry();
    for (const labels of [
      { environment: 'testnet', planId: 'plan-1' },
      { environment: 'testnet', account: 'owner-account' },
      { environment: 'testnet', asset: 'BTC' },
    ]) {
      expect(() => metrics.set(METRICS.unknownAgeSeconds, labels, 1n)).toThrow(/exactly labels/);
    }
  });

  it('rejects arbitrary label values and negative metrics', () => {
    const metrics = new BoundedMetricRegistry();
    expect(() => metrics.set(METRICS.unknownAgeSeconds, { environment: 'prod' }, 1n)).toThrow(
      /unbounded or unknown/,
    );
    expect(() => metrics.set(METRICS.unknownAgeSeconds, { environment: 'testnet' }, -1n)).toThrow(
      /nonnegative/,
    );
  });
});
