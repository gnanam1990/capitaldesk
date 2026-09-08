export interface PermittedMarketObservation {
  readonly symbol: string;
  readonly priceAtoms: string;
  readonly sourceObservedAt: string;
  readonly sourceDigest: string;
  /** Untrusted display text. Never enters arithmetic, routing or permissions. */
  readonly untrustedContext: string;
}

export interface ReproducibleRule {
  readonly strategyId: string;
  readonly direction: 'ACCUMULATE' | 'REDUCE';
  readonly stepBaseAtoms: string;
  readonly priceTriggerAtoms: string;
  readonly maxTargetBaseAtoms: string;
}

export const REFERENCE_RULES: readonly ReproducibleRule[] = Object.freeze([
  {
    strategyId: 'strategy-a',
    direction: 'ACCUMULATE',
    stepBaseAtoms: '100',
    priceTriggerAtoms: '6500000',
    maxTargetBaseAtoms: '1000',
  },
  {
    strategyId: 'strategy-b',
    direction: 'REDUCE',
    stepBaseAtoms: '50',
    priceTriggerAtoms: '7000000',
    maxTargetBaseAtoms: '1000',
  },
]);

function exact(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new TypeError(`${name} is not canonical atoms`);
  return BigInt(value);
}

export function targetFromRule(
  rule: ReproducibleRule,
  observation: PermittedMarketObservation,
  ownedBaseAtoms: string,
): { readonly targetBaseQtyAtoms: string; readonly rationale: string } {
  const price = exact(observation.priceAtoms, 'priceAtoms');
  const owned = exact(ownedBaseAtoms, 'ownedBaseAtoms');
  const step = exact(rule.stepBaseAtoms, 'stepBaseAtoms');
  const trigger = exact(rule.priceTriggerAtoms, 'priceTriggerAtoms');
  const maximum = exact(rule.maxTargetBaseAtoms, 'maxTargetBaseAtoms');
  let target = owned;
  if (rule.direction === 'ACCUMULATE' && price <= trigger) {
    target = owned + step > maximum ? maximum : owned + step;
  }
  if (rule.direction === 'REDUCE' && price >= trigger) target = owned > step ? owned - step : 0n;
  return {
    targetBaseQtyAtoms: target.toString(),
    rationale: `${rule.direction} rule ${rule.strategyId}: observed ${observation.symbol} price atoms ${observation.priceAtoms}; source ${observation.sourceDigest}. This deterministic demonstration does not claim market alpha.`,
  };
}

export const BROKER_KEY_DISCLOSURE =
  'Broker-key testnet funds belong to that configured API account and are separate from Agentic OAuth.';
export const APPROVED_HOST_STATUS =
  'BLOCKED: authenticated Agentic host schemas and native confirmation capability are not configured.';
