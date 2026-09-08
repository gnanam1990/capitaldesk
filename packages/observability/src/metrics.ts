export const METRICS = {
  unknownAgeSeconds: 'capitaldesk_unknown_age_seconds',
  completeCutAgeSeconds: 'capitaldesk_complete_account_cut_age_seconds',
  unmatchedFills: 'capitaldesk_unmatched_fills',
  feeDiscrepancies: 'capitaldesk_fee_discrepancies',
  activeReservations: 'capitaldesk_active_reservations',
  dispatchMarkers: 'capitaldesk_dispatch_markers',
  queueLagSeconds: 'capitaldesk_queue_lag_seconds',
  sourceHealth: 'capitaldesk_source_health',
  authorizationFailures: 'capitaldesk_authorization_failures',
} as const;

export type MetricName = (typeof METRICS)[keyof typeof METRICS];

const LABEL_VALUES = {
  environment: ['local', 'testnet', 'production-read-only'],
  source: ['account', 'orders', 'fills', 'fees', 'clock', 'metadata'],
  state: ['healthy', 'stale', 'down', 'unknown', 'held'],
  queue: ['ingest', 'reconcile', 'dispatch', 'export'],
  outcome: ['marked', 'acknowledged', 'rejected', 'unknown', 'not_sent_proven'],
  reason: ['missing', 'expired', 'revoked', 'scope_denied', 'csrf', 'policy_denied'],
} as const;

type LabelName = keyof typeof LABEL_VALUES;

const LABELS_BY_METRIC: Readonly<Record<MetricName, readonly LabelName[]>> = {
  [METRICS.unknownAgeSeconds]: ['environment'],
  [METRICS.completeCutAgeSeconds]: ['environment', 'source'],
  [METRICS.unmatchedFills]: ['environment'],
  [METRICS.feeDiscrepancies]: ['environment'],
  [METRICS.activeReservations]: ['environment', 'state'],
  [METRICS.dispatchMarkers]: ['environment', 'outcome'],
  [METRICS.queueLagSeconds]: ['environment', 'queue'],
  [METRICS.sourceHealth]: ['environment', 'source', 'state'],
  [METRICS.authorizationFailures]: ['environment', 'reason'],
};

function labelsKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/**
 * Minimal registry with deliberately finite cardinality. Account, workspace, plan, attempt,
 * symbol and asset identifiers are log correlation fields, never metric labels.
 */
export class BoundedMetricRegistry {
  readonly #values = new Map<
    string,
    { name: MetricName; labels: Readonly<Record<string, string>>; value: bigint }
  >();

  set(name: MetricName, labels: Readonly<Record<string, string>>, value: bigint): void {
    if (value < 0n) throw new Error('metric values must be nonnegative');
    const expected = LABELS_BY_METRIC[name];
    const supplied = Object.keys(labels).sort();
    if (supplied.join(',') !== [...expected].sort().join(',')) {
      throw new Error(`${name} requires exactly labels: ${expected.join(', ')}`);
    }
    for (const label of expected) {
      const valueForLabel = labels[label];
      if (
        valueForLabel === undefined ||
        !(LABEL_VALUES[label] as readonly string[]).includes(valueForLabel)
      ) {
        throw new Error(`${label} has an unbounded or unknown value`);
      }
    }
    this.#values.set(`${name}|${labelsKey(labels)}`, { name, labels: { ...labels }, value });
  }

  snapshot(): ReadonlyArray<{
    readonly name: MetricName;
    readonly labels: Readonly<Record<string, string>>;
    readonly value: string;
  }> {
    return [...this.#values.values()]
      .sort((a, b) =>
        `${a.name}|${labelsKey(a.labels)}`.localeCompare(`${b.name}|${labelsKey(b.labels)}`),
      )
      .map((entry) => ({ name: entry.name, labels: entry.labels, value: entry.value.toString() }));
  }
}
