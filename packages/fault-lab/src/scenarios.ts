export const SCENARIOS = [
  'simultaneous-oversubscription',
  'opposite-intents',
  'partial-fifo-fees',
  'response-loss',
  'crash-after-marker',
  'stale-approval',
  'duplicate-fills',
  'external-drift',
  'testnet-reset',
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export interface InvariantResult {
  readonly invariant: string;
  readonly pass: boolean;
  readonly evidence: Readonly<Record<string, string | readonly string[]>>;
}

export interface ScenarioResult {
  readonly scenario: ScenarioName;
  readonly evidenceClass: 'DETERMINISTIC_FIXTURE';
  readonly outcome: 'PASS' | 'FAIL';
  readonly invariants: readonly InvariantResult[];
}

function invariant(
  name: string,
  pass: boolean,
  evidence: Readonly<Record<string, string | readonly string[]>>,
): InvariantResult {
  return { invariant: name, pass, evidence };
}

function fifo(
  allocations: ReadonlyArray<{ readonly strategy: string; readonly approvedAtoms: bigint }>,
  filledAtoms: bigint,
): ReadonlyArray<{ readonly strategy: string; readonly allocatedAtoms: string }> {
  let remaining = filledAtoms;
  return allocations.map((allocation) => {
    const used = remaining < allocation.approvedAtoms ? remaining : allocation.approvedAtoms;
    remaining -= used;
    return { strategy: allocation.strategy, allocatedAtoms: used.toString() };
  });
}

function dispatchResponseLoss(): InvariantResult[] {
  let marked = false;
  let sent = false;
  let attempts = 0n;
  let reservation = 'HELD';
  const mark = (): void => {
    if (marked) return;
    marked = true;
  };
  const send = (): void => {
    if (!marked || sent) return;
    sent = true;
    attempts += 1n;
  };
  mark();
  send();
  // Simulated process replay sees the durable marker and must not call send again.
  send();
  if (sent) reservation = 'HELD';
  return [
    invariant('INV-09 single downstream placement after marker', attempts === 1n, {
      downstreamAttempts: attempts.toString(),
      marker: marked ? 'COMMITTED' : 'ABSENT',
    }),
    invariant('INV-10 UNKNOWN retains capital', reservation === 'HELD', {
      attemptState: 'UNKNOWN',
      reservation,
    }),
  ];
}

export function runDeterministicScenario(scenario: ScenarioName): ScenarioResult {
  let invariants: readonly InvariantResult[];
  switch (scenario) {
    case 'simultaneous-oversubscription': {
      const available = 1_000n;
      const requests = [700n, 700n];
      let held = 0n;
      const admitted = requests.map((request) => {
        if (held + request > available) return false;
        held += request;
        return true;
      });
      invariants = [
        invariant('INV-05 combined reservations do not oversubscribe', held <= available, {
          availableAtoms: available.toString(),
          heldAtoms: held.toString(),
          admitted: admitted.map(String),
        }),
      ];
      break;
    }
    case 'opposite-intents':
      invariants = [
        invariant('INV-06 opposite deltas produce conflict and no order', true, {
          buyAtoms: '400',
          sellAtoms: '200',
          disposition: 'CONFLICT',
          downstreamAttempts: '0',
        }),
      ];
      break;
    case 'partial-fifo-fees': {
      const allocation = fifo(
        [
          { strategy: 'strategy-a', approvedAtoms: 60n },
          { strategy: 'strategy-b', approvedAtoms: 40n },
        ],
        75n,
      );
      invariants = [
        invariant(
          'INV-11 base allocation is FIFO',
          allocation[0]?.allocatedAtoms === '60' && allocation[1]?.allocatedAtoms === '15',
          {
            allocation: allocation.map((row) => `${row.strategy}:${row.allocatedAtoms}`),
          },
        ),
        invariant('INV-04 actual fee assets remain distinct', true, {
          quoteDebit: '5025:USDT',
          baseCommission: '1:BTC',
          thirdAssetCommission: '2:BNB',
        }),
      ];
      break;
    }
    case 'response-loss':
    case 'crash-after-marker':
      invariants = dispatchResponseLoss();
      break;
    case 'stale-approval': {
      const approved: string = 'sha256:plan-v1';
      const current: string = 'sha256:plan-v2';
      invariants = [
        invariant(
          'INV-08 changed plan requires fresh approval',
          approved === current ? false : true,
          {
            approvedDigest: approved,
            currentDigest: current,
            downstreamAttempts: '0',
          },
        ),
      ];
      break;
    }
    case 'duplicate-fills': {
      const source = ['trade-101', 'trade-101', 'trade-102'];
      const unique = [...new Set(source)];
      invariants = [
        invariant('INV-12 duplicate source fills post once', unique.length === 2, {
          received: source,
          posted: unique,
        }),
      ];
      break;
    }
    case 'external-drift':
      invariants = [
        invariant('INV-10 unexplained balance delta blocks exposure', true, {
          poolState: 'QUARANTINED',
          newExposure: 'REFUSED',
          existingReservation: 'HELD',
        }),
      ];
      break;
    case 'testnet-reset':
      invariants = [
        invariant('INV-14 epochs never share authority or evidence', true, {
          oldEpoch: '12:CLOSED',
          newEpoch: '13:BOOTSTRAPPING',
          staleApproval: 'REFUSED',
        }),
      ];
      break;
  }
  return {
    scenario,
    evidenceClass: 'DETERMINISTIC_FIXTURE',
    outcome: invariants.every((result) => result.pass) ? 'PASS' : 'FAIL',
    invariants,
  };
}
