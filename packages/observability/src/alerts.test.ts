import { describe, expect, it } from 'vitest';
import { evaluateOperationalAlerts } from './alerts.js';
import { BoundedMetricRegistry, METRICS } from './metrics.js';

describe('operational alert policy', () => {
  it('fires at the documented boundary and stays quiet just below it', () => {
    const registry = new BoundedMetricRegistry();
    registry.set(METRICS.unknownAgeSeconds, { environment: 'testnet' }, 119n);
    expect(evaluateOperationalAlerts(registry.snapshot())).toEqual([]);

    registry.set(METRICS.unknownAgeSeconds, { environment: 'testnet' }, 120n);
    expect(evaluateOperationalAlerts(registry.snapshot())).toEqual([
      {
        code: 'UNKNOWN_AGED',
        severity: 'critical',
        runbook: '/docs/runbooks/unknown-order.md',
        labels: { environment: 'testnet' },
      },
    ]);
  });

  it('routes source failure and accounting discrepancies to critical diagnosis', () => {
    const registry = new BoundedMetricRegistry();
    registry.set(
      METRICS.sourceHealth,
      { environment: 'production-read-only', source: 'fills', state: 'down' },
      0n,
    );
    registry.set(METRICS.feeDiscrepancies, { environment: 'production-read-only' }, 1n);
    expect(
      evaluateOperationalAlerts(registry.snapshot())
        .map((alert) => alert.code)
        .sort(),
    ).toEqual(['FEE_DISCREPANCY', 'SOURCE_DOWN']);
  });
});
