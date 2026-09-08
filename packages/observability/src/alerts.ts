import { METRICS, type MetricName } from './metrics.js';

export interface MetricSample {
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: string;
}

export interface OperationalAlert {
  readonly code:
    | 'UNKNOWN_AGED'
    | 'ACCOUNT_CUT_STALE'
    | 'UNMATCHED_FILL'
    | 'FEE_DISCREPANCY'
    | 'DISPATCH_QUEUE_LAG'
    | 'SOURCE_DOWN';
  readonly severity: 'warning' | 'critical';
  readonly runbook: '/docs/runbooks/unknown-order.md';
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Deterministic alert policy over the bounded registry. Thresholds are integer seconds/counts,
 * so no financial quantity is converted to a floating-point number.
 */
export function evaluateOperationalAlerts(
  samples: readonly MetricSample[],
): readonly OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  for (const sample of samples) {
    const value = BigInt(sample.value);
    const common = {
      runbook: '/docs/runbooks/unknown-order.md' as const,
      labels: sample.labels,
    };
    if (sample.name === METRICS.unknownAgeSeconds && value >= 120n) {
      alerts.push({ ...common, code: 'UNKNOWN_AGED', severity: 'critical' });
    } else if (sample.name === METRICS.completeCutAgeSeconds && value >= 300n) {
      alerts.push({ ...common, code: 'ACCOUNT_CUT_STALE', severity: 'warning' });
    } else if (sample.name === METRICS.unmatchedFills && value > 0n) {
      alerts.push({ ...common, code: 'UNMATCHED_FILL', severity: 'critical' });
    } else if (sample.name === METRICS.feeDiscrepancies && value > 0n) {
      alerts.push({ ...common, code: 'FEE_DISCREPANCY', severity: 'critical' });
    } else if (sample.name === METRICS.queueLagSeconds && value >= 60n) {
      alerts.push({ ...common, code: 'DISPATCH_QUEUE_LAG', severity: 'warning' });
    } else if (
      sample.name === METRICS.sourceHealth &&
      (sample.labels['state'] === 'down' || sample.labels['state'] === 'unknown')
    ) {
      alerts.push({ ...common, code: 'SOURCE_DOWN', severity: 'critical' });
    }
  }
  return alerts;
}
