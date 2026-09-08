import {
  price,
  quoteAtomsForBase,
  violate,
  type AssetKey,
  type ReasonCode,
} from '@capitaldesk/contracts';

export interface PlannerMarket {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly accountKey: string;
  readonly epoch: number;
  readonly symbol: string;
  readonly baseAsset: AssetKey;
  readonly quoteAsset: AssetKey;
  readonly baseScale: number;
  readonly quoteScale: number;
  /** Integer price atoms with `priceScale` decimal places. */
  readonly priceScale: number;
  readonly tickAtoms: bigint;
  readonly minPriceAtoms: bigint;
  readonly maxPriceAtoms: bigint;
  readonly lotStepAtoms: bigint;
  readonly minQtyAtoms: bigint;
  readonly maxQtyAtoms: bigint;
  readonly minNotionalQuoteAtoms: bigint;
  readonly maxNotionalQuoteAtoms: bigint | null;
  readonly policyVersion: bigint;
  readonly feePolicyVersion: string;
  readonly nowMs: bigint;
}

export interface PlannerIntent {
  readonly intentId: string;
  readonly strategyId: string;
  readonly acceptedSequence: bigint;
  readonly strategyRevision: bigint;
  readonly accountKey: string;
  readonly epoch: number;
  readonly symbol: string;
  readonly policyVersion: bigint;
  readonly feePolicyVersion: string;
  readonly targetBaseAtoms: bigint;
  readonly ownedBaseAtoms: bigint;
  readonly availableBaseAtoms: bigint;
  readonly availableQuoteAtoms: bigint;
  readonly maxQuoteDebitAtoms: bigint;
  readonly maxBuyPriceAtoms: bigint | null;
  readonly minSellPriceAtoms: bigint | null;
  readonly worstBaseCommissionAtoms: bigint;
  readonly expiresAtMs: bigint;
  readonly authorized: boolean;
  readonly deferred: boolean;
  readonly current: boolean;
}

export interface PlannerExclusion {
  readonly intentId: string;
  readonly strategyId: string;
  readonly reason: ReasonCode;
  readonly explanation: string;
}

export interface PlannedAllocation {
  readonly position: number;
  readonly intentId: string;
  readonly strategyId: string;
  readonly strategyRevision: bigint;
  readonly acceptedSequence: bigint;
  readonly grossBaseAtoms: bigint;
  readonly residualBaseAtoms: bigint;
  readonly maxQuoteDebitAtoms: bigint;
  readonly worstBaseCommissionAtoms: bigint;
}

export type PlanPreview =
  | {
      readonly kind: 'NO_ORDER';
      readonly cohortClosedAtSequence: bigint;
      readonly exclusions: readonly PlannerExclusion[];
    }
  | {
      readonly kind: 'CONFLICT';
      readonly cohortClosedAtSequence: bigint;
      readonly buyIntentIds: readonly string[];
      readonly sellIntentIds: readonly string[];
      readonly exclusions: readonly PlannerExclusion[];
    }
  | {
      readonly kind: 'ORDER';
      readonly cohortClosedAtSequence: bigint;
      readonly symbol: string;
      readonly side: 'BUY' | 'SELL';
      readonly orderType: 'LIMIT';
      readonly timeInForce: 'IOC';
      readonly grossBaseAtoms: bigint;
      readonly limitPriceAtoms: bigint;
      readonly worstQuoteDebitAtoms: bigint;
      readonly allocations: readonly PlannedAllocation[];
      readonly exclusions: readonly PlannerExclusion[];
    };

function exclusion(
  intent: PlannerIntent,
  reason: ReasonCode,
  explanation: string,
): PlannerExclusion {
  return { intentId: intent.intentId, strategyId: intent.strategyId, reason, explanation };
}

function floorStep(value: bigint, step: bigint): bigint {
  return (value / step) * step;
}

function ceilStep(value: bigint, step: bigint): bigint {
  return ((value + step - 1n) / step) * step;
}

function compareIntent(a: PlannerIntent, b: PlannerIntent): number {
  if (a.acceptedSequence !== b.acceptedSequence)
    return a.acceptedSequence < b.acceptedSequence ? -1 : 1;
  const strategy = a.strategyId.localeCompare(b.strategyId);
  return strategy === 0 ? a.intentId.localeCompare(b.intentId) : strategy;
}

function requireMarket(market: PlannerMarket): void {
  const naturals = [market.tickAtoms, market.lotStepAtoms, market.minQtyAtoms, market.maxQtyAtoms];
  if (naturals.some((value) => value <= 0n) || market.maxPriceAtoms < market.minPriceAtoms) {
    violate('POLICY_CONFIGURATION_MISSING', 'planner market filters are incomplete or malformed');
  }
  if (!Number.isInteger(market.epoch) || market.epoch <= 0) {
    violate('IDENTITY_MALFORMED', 'planner epoch must be a positive integer');
  }
}

function capFor(intent: PlannerIntent, side: 'BUY' | 'SELL'): bigint {
  const delta =
    side === 'BUY'
      ? intent.targetBaseAtoms - intent.ownedBaseAtoms
      : intent.ownedBaseAtoms - intent.targetBaseAtoms;
  if (side === 'BUY') return delta;
  const ownedCap = intent.availableBaseAtoms - intent.worstBaseCommissionAtoms;
  const targetCap = delta - intent.worstBaseCommissionAtoms;
  return ownedCap < targetCap ? ownedCap : targetCap;
}

function priceLimitOf(intent: PlannerIntent, side: 'BUY' | 'SELL'): bigint {
  const value = side === 'BUY' ? intent.maxBuyPriceAtoms : intent.minSellPriceAtoms;
  if (value === null) {
    violate('PLAN_LIMIT_INCOMPATIBLE', `${side} price authorization is absent`);
  }
  return value;
}

/**
 * Pure deterministic preview. It cannot reserve, mutate a claim or authorize dispatch.
 * Eligibility is completed before direction evaluation, preventing stale intents from
 * manufacturing an opposite-side conflict.
 */
export function previewPlan(market: PlannerMarket, source: readonly PlannerIntent[]): PlanPreview {
  requireMarket(market);
  const sorted = [...source].sort(compareIntent);
  const cohortClosedAtSequence = sorted.reduce(
    (maximum, intent) => (intent.acceptedSequence > maximum ? intent.acceptedSequence : maximum),
    0n,
  );
  const exclusions: PlannerExclusion[] = [];
  const eligible: PlannerIntent[] = [];
  for (const intent of sorted) {
    if (!intent.current)
      exclusions.push(exclusion(intent, 'INTENT_SUPERSEDED', 'intent is not current'));
    else if (intent.deferred)
      exclusions.push(exclusion(intent, 'INTENT_DEFERRED_BY_OWNER', 'owner deferred this target'));
    else if (!intent.authorized)
      exclusions.push(exclusion(intent, 'AUTHZ_SCOPE_DENIED', 'strategy authority is inactive'));
    else if (intent.expiresAtMs <= market.nowMs)
      exclusions.push(exclusion(intent, 'INTENT_EXPIRED', 'intent expired before cohort close'));
    else if (
      intent.accountKey !== market.accountKey ||
      intent.epoch !== market.epoch ||
      intent.symbol !== market.symbol
    )
      exclusions.push(
        exclusion(intent, 'IDENTITY_SCOPE_MISMATCH', 'intent is outside the frozen pool cohort'),
      );
    else if (
      intent.policyVersion !== market.policyVersion ||
      intent.feePolicyVersion !== market.feePolicyVersion
    )
      exclusions.push(
        exclusion(intent, 'POLICY_MANDATE_VERSION_STALE', 'intent policy binding is stale'),
      );
    else if (intent.targetBaseAtoms === intent.ownedBaseAtoms)
      exclusions.push(exclusion(intent, 'INTENT_ZERO_DELTA', 'target is already satisfied'));
    else eligible.push(intent);
  }
  if (eligible.length === 0) return { kind: 'NO_ORDER', cohortClosedAtSequence, exclusions };
  const buys = eligible.filter((intent) => intent.targetBaseAtoms > intent.ownedBaseAtoms);
  const sells = eligible.filter((intent) => intent.targetBaseAtoms < intent.ownedBaseAtoms);
  if (buys.length > 0 && sells.length > 0) {
    return {
      kind: 'CONFLICT',
      cohortClosedAtSequence,
      buyIntentIds: buys.map((intent) => intent.intentId),
      sellIntentIds: sells.map((intent) => intent.intentId),
      exclusions,
    };
  }
  const side = buys.length > 0 ? 'BUY' : 'SELL';
  const participants = side === 'BUY' ? buys : sells;
  const first = participants[0];
  if (first === undefined) return { kind: 'NO_ORDER', cohortClosedAtSequence, exclusions };
  const missingLimit = participants.find((intent) =>
    side === 'BUY' ? intent.maxBuyPriceAtoms === null : intent.minSellPriceAtoms === null,
  );
  if (missingLimit !== undefined) {
    exclusions.push(
      exclusion(missingLimit, 'PLAN_LIMIT_INCOMPATIBLE', `${side} price authorization is absent`),
    );
    return { kind: 'NO_ORDER', cohortClosedAtSequence, exclusions };
  }
  const rawLimit = participants.reduce(
    (limit, intent) => {
      const candidate = priceLimitOf(intent, side);
      return side === 'BUY'
        ? candidate < limit
          ? candidate
          : limit
        : candidate > limit
          ? candidate
          : limit;
    },
    priceLimitOf(first, side),
  );
  const limitPriceAtoms =
    side === 'BUY' ? floorStep(rawLimit, market.tickAtoms) : ceilStep(rawLimit, market.tickAtoms);
  if (
    limitPriceAtoms < market.minPriceAtoms ||
    limitPriceAtoms > market.maxPriceAtoms ||
    limitPriceAtoms === 0n
  ) {
    exclusions.push(
      exclusion(
        first,
        'PLAN_EXCHANGE_FILTER_UNSATISFIED',
        'strict price cannot fit venue tick and range',
      ),
    );
    return { kind: 'NO_ORDER', cohortClosedAtSequence, exclusions };
  }
  const capacities = participants.map((intent) => ({ intent, atoms: capFor(intent, side) }));
  const desired = capacities.reduce(
    (total, item) => total + (item.atoms > 0n ? item.atoms : 0n),
    0n,
  );
  const grossBaseAtoms = floorStep(desired, market.lotStepAtoms);
  if (grossBaseAtoms < market.minQtyAtoms || grossBaseAtoms > market.maxQtyAtoms) {
    exclusions.push(
      exclusion(
        first,
        'PLAN_EXCHANGE_FILTER_UNSATISFIED',
        'aggregate quantity cannot fit venue lot range',
      ),
    );
    return { kind: 'NO_ORDER', cohortClosedAtSequence, exclusions };
  }
  const limitPrice = price(
    market.baseAsset,
    market.quoteAsset,
    limitPriceAtoms,
    -market.priceScale,
  );
  const worstQuoteDebitAtoms = quoteAtomsForBase(
    limitPrice,
    grossBaseAtoms,
    market.baseScale,
    market.quoteScale,
    side === 'BUY' ? 'CEIL' : 'FLOOR',
  );
  if (
    worstQuoteDebitAtoms < market.minNotionalQuoteAtoms ||
    (market.maxNotionalQuoteAtoms !== null && worstQuoteDebitAtoms > market.maxNotionalQuoteAtoms)
  ) {
    exclusions.push(
      exclusion(
        first,
        'PLAN_EXCHANGE_FILTER_UNSATISFIED',
        'aggregate notional cannot fit venue bounds',
      ),
    );
    return { kind: 'NO_ORDER', cohortClosedAtSequence, exclusions };
  }
  let remaining = grossBaseAtoms;
  const allocations: PlannedAllocation[] = [];
  for (const { intent, atoms } of capacities) {
    if (remaining === 0n) break;
    const admitted = atoms < remaining ? atoms : remaining;
    if (admitted <= 0n) continue;
    const quoteDebit = quoteAtomsForBase(
      limitPrice,
      admitted,
      market.baseScale,
      market.quoteScale,
      'CEIL',
    );
    if (
      side === 'BUY' &&
      (quoteDebit > intent.maxQuoteDebitAtoms || quoteDebit > intent.availableQuoteAtoms)
    ) {
      exclusions.push(
        exclusion(
          intent,
          'PLAN_INSUFFICIENT_CLAIM',
          'strategy quote claim cannot fund its FIFO allocation',
        ),
      );
      continue;
    }
    allocations.push({
      position: allocations.length,
      intentId: intent.intentId,
      strategyId: intent.strategyId,
      strategyRevision: intent.strategyRevision,
      acceptedSequence: intent.acceptedSequence,
      grossBaseAtoms: admitted,
      residualBaseAtoms: atoms - admitted,
      maxQuoteDebitAtoms: quoteDebit,
      worstBaseCommissionAtoms: intent.worstBaseCommissionAtoms,
    });
    remaining -= admitted;
  }
  if (remaining !== 0n || allocations.length === 0) {
    return {
      kind: 'NO_ORDER',
      cohortClosedAtSequence,
      exclusions: [
        ...exclusions,
        exclusion(first, 'PLAN_INSUFFICIENT_CLAIM', 'fixed FIFO cannot fund the complete child'),
      ],
    };
  }
  return {
    kind: 'ORDER',
    cohortClosedAtSequence,
    symbol: market.symbol,
    side,
    orderType: 'LIMIT',
    timeInForce: 'IOC',
    grossBaseAtoms,
    limitPriceAtoms,
    worstQuoteDebitAtoms,
    allocations,
    exclusions,
  };
}
