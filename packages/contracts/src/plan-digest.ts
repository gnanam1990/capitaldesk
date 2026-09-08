import { assertOnlyKnownKeys, canonicalJson, digestOf, type CanonicalValue } from './canonical.js';
import { violate } from './errors.js';
import { formatAssetKey, type AssetAmount } from './money.js';
import { formatPoolId, type PoolId } from './identity.js';
import { formatPrice, type Price } from './price.js';
import { parseStrictUtcInstant, strictUtcMs } from './time.js';

/**
 * The exact economic payload an owner approves.
 *
 * Every field below is bound into the digest. Changing any of them invalidates the
 * approval (INV-08, FR-013). The field list is frozen: `planDigestPayload` rejects unknown
 * keys so a later module cannot quietly add a decision-changing field that escapes the
 * digest, and cannot quietly drop one either.
 */

/** Per-strategy immutable caps. Exceeding a cap quarantines; it never raises the cap. */
export interface StrategyCaps {
  readonly strategyId: string;
  /** Maximum atoms of the debited asset this strategy may be charged, fees included. */
  readonly maxDebit: AssetAmount;
  /** Maximum commission atoms per fee asset this strategy may be charged. */
  readonly maxCommission: readonly AssetAmount[];
}

/** One entry of the immutable FIFO allocation schedule. Order is authority, not a hint. */
export interface AllocationEntry {
  readonly position: number;
  readonly strategyId: string;
  readonly intentId: string;
  readonly intentRevision: number;
  readonly requestedGrossBase: AssetAmount;
}

export interface SealedPlanPayload {
  readonly pool: PoolId;
  /** Client order id: unique in our database forever, never reused across epochs. */
  readonly childClientOrderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  /** v1 dispatches LIMIT IOC only. Any other pair is an unsupported action. */
  readonly orderType: 'LIMIT';
  readonly timeInForce: 'IOC';
  readonly grossBaseQuantity: AssetAmount;
  readonly limitPrice: Price;
  readonly allocation: readonly AllocationEntry[];
  readonly strategyCaps: readonly StrategyCaps[];

  /** Versions that change arithmetic or authority. All are bound into the digest. */
  readonly allocationAlgorithmVersion: string;
  readonly feePolicyVersion: string;
  readonly mandatePolicyVersion: string;
  readonly baselineLedgerRevision: number;
  /** ADR-0008: the accepted-sequence at which the candidate cohort closed. */
  readonly cohortClosedAtSequence: number;

  /**
   * ADR-0003 timing envelope. `approvalExpiresAt` bounds owner consent;
   * `submissionDeadlineAt` is the linearization boundary — the last instant at which the
   * executor may begin the network send — and `signedRequestValidityMs` is the venue
   * recvWindow that makes the boundary venue-enforced rather than advisory.
   */
  readonly approvalExpiresAt: string;
  readonly submissionDeadlineAt: string;
  readonly signedRequestValidityMs: number;
  readonly clockSkewBudgetMs: number;

  /** ADR-0005: the durability class that must hold before this plan may be marked. */
  readonly authorizationDurability: 'SYNCHRONOUS_REPLICA' | 'AT_RISK_SINGLE_NODE';
}

/**
 * The complete list of fields bound into the approval digest.
 *
 * This is both the digest field list and the strict allowlist enforced at runtime, so the
 * two can never drift apart: adding a field to `SealedPlanPayload` without adding it here
 * makes every payload carrying it fail loudly instead of hashing to a stale digest.
 */
export const PLAN_DIGEST_BOUND_FIELDS = [
  'pool',
  'childClientOrderId',
  'symbol',
  'side',
  'orderType',
  'timeInForce',
  'grossBaseQuantity',
  'limitPrice',
  'allocation',
  'strategyCaps',
  'allocationAlgorithmVersion',
  'feePolicyVersion',
  'mandatePolicyVersion',
  'baselineLedgerRevision',
  'cohortClosedAtSequence',
  'approvalExpiresAt',
  'submissionDeadlineAt',
  'signedRequestValidityMs',
  'clockSkewBudgetMs',
  'authorizationDurability',
] as const;

function isoUtc(name: string, value: string): string {
  // Strict, so an impossible calendar day such as 2026-02-30 is refused rather than
  // normalised into a different instant that the digest would then bind.
  parseStrictUtcInstant(name, value);
  return value;
}

function count(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    violate('MONEY_NOT_AN_INTEGER', `${name} must be a nonnegative safe integer`, {
      [name]: String(value),
    });
  }
  return String(value);
}

function encodeAmount(value: AssetAmount): CanonicalValue {
  return { asset: formatAssetKey(value.asset), atoms: value.atoms.toString() };
}

/** Frozen key sets. Every nested object an approval binds is checked against one of these. */
const ALLOCATION_ENTRY_KEYS = [
  'position',
  'strategyId',
  'intentId',
  'intentRevision',
  'requestedGrossBase',
] as const;
const STRATEGY_CAPS_KEYS = ['strategyId', 'maxDebit', 'maxCommission'] as const;
const ASSET_AMOUNT_KEYS = ['kind', 'asset', 'atoms'] as const;
const ASSET_KEY_KEYS = ['code', 'scaleVersion'] as const;
const PRICE_KEYS = ['kind', 'base', 'quote', 'mantissa', 'exponent'] as const;
const POOL_KEYS = ['workspaceId', 'account', 'baselineEpoch'] as const;
const ACCOUNT_KEYS = ['venue', 'environment', 'stableAccountId'] as const;

function checkAmount(value: AssetAmount, path: string): void {
  assertOnlyKnownKeys(value, ASSET_AMOUNT_KEYS, path);
  assertOnlyKnownKeys(value.asset, ASSET_KEY_KEYS, `${path}.asset`);
}

/**
 * Reject any key outside the frozen field list, at every level an approval binds.
 *
 * Without this, `planDigestPayload` would read its known fields and silently ignore an
 * extra one, so a payload carrying a new decision-changing field would produce the same
 * digest as the payload without it — the exact failure INV-08 exists to prevent. Nested
 * objects are checked too: an extra key on one allocation entry is as consequential as an
 * extra key at the top level.
 */
export function assertPlanPayloadFieldsFrozen(plan: SealedPlanPayload): void {
  assertOnlyKnownKeys(plan, PLAN_DIGEST_BOUND_FIELDS, '$');

  assertOnlyKnownKeys(plan.pool, POOL_KEYS, '$.pool');
  assertOnlyKnownKeys(plan.pool.account, ACCOUNT_KEYS, '$.pool.account');

  checkAmount(plan.grossBaseQuantity, '$.grossBaseQuantity');

  assertOnlyKnownKeys(plan.limitPrice, PRICE_KEYS, '$.limitPrice');
  assertOnlyKnownKeys(plan.limitPrice.base, ASSET_KEY_KEYS, '$.limitPrice.base');
  assertOnlyKnownKeys(plan.limitPrice.quote, ASSET_KEY_KEYS, '$.limitPrice.quote');

  plan.allocation.forEach((entry, index) => {
    const path = `$.allocation[${index}]`;
    assertOnlyKnownKeys(entry, ALLOCATION_ENTRY_KEYS, path);
    checkAmount(entry.requestedGrossBase, `${path}.requestedGrossBase`);
  });

  const seenStrategies = new Set<string>();
  plan.strategyCaps.forEach((cap, index) => {
    const path = `$.strategyCaps[${index}]`;
    assertOnlyKnownKeys(cap, STRATEGY_CAPS_KEYS, path);
    checkAmount(cap.maxDebit, `${path}.maxDebit`);

    if (seenStrategies.has(cap.strategyId)) {
      violate('IDENTITY_MALFORMED', 'a strategy may appear at most once in the cap table', {
        strategyId: cap.strategyId,
      });
    }
    seenStrategies.add(cap.strategyId);

    // Duplicate fee assets have no meaning — which of the two caps applies? — and they made
    // canonicalisation order-dependent, because the comparator returns the same answer for
    // equal keys. Two orderings of the same caps produced two digests for one plan.
    const seenAssets = new Set<string>();
    cap.maxCommission.forEach((commission, commissionIndex) => {
      checkAmount(commission, `${path}.maxCommission[${commissionIndex}]`);
      const asset = formatAssetKey(commission.asset);
      if (seenAssets.has(asset)) {
        violate('IDENTITY_MALFORMED', 'a fee asset may appear at most once per strategy cap', {
          strategyId: cap.strategyId,
          asset,
        });
      }
      seenAssets.add(asset);
    });
  });
}

/**
 * Build the canonical digest payload. Exported so the console, the API and evidence
 * exports all display byte-identical review material rather than three near-copies.
 */
export function planDigestPayload(plan: SealedPlanPayload): CanonicalValue {
  assertPlanPayloadFieldsFrozen(plan);
  if (plan.allocation.length === 0) {
    violate('IDENTITY_MALFORMED', 'a sealed plan has at least one allocation entry');
  }
  plan.allocation.forEach((entry, index) => {
    if (entry.position !== index) {
      violate('IDENTITY_MALFORMED', 'allocation positions must be dense and ordered from 0', {
        expected: String(index),
        actual: String(entry.position),
      });
    }
  });
  if (
    strictUtcMs('submissionDeadlineAt', plan.submissionDeadlineAt) >
    strictUtcMs('approvalExpiresAt', plan.approvalExpiresAt)
  ) {
    violate(
      'SUBMISSION_DEADLINE_PASSED',
      'submissionDeadlineAt must not be later than approvalExpiresAt',
      {
        submissionDeadlineAt: plan.submissionDeadlineAt,
        approvalExpiresAt: plan.approvalExpiresAt,
      },
    );
  }

  return {
    schema: 'capitaldesk.sealed-plan.v1',
    pool: formatPoolId(plan.pool),
    childClientOrderId: plan.childClientOrderId,
    symbol: plan.symbol,
    side: plan.side,
    orderType: plan.orderType,
    timeInForce: plan.timeInForce,
    grossBaseQuantity: encodeAmount(plan.grossBaseQuantity),
    limitPrice: {
      base: formatAssetKey(plan.limitPrice.base),
      quote: formatAssetKey(plan.limitPrice.quote),
      value: formatPrice(plan.limitPrice),
    },
    allocation: plan.allocation.map((entry) => ({
      position: count('position', entry.position),
      strategyId: entry.strategyId,
      intentId: entry.intentId,
      intentRevision: count('intentRevision', entry.intentRevision),
      requestedGrossBase: encodeAmount(entry.requestedGrossBase),
    })),
    strategyCaps: [...plan.strategyCaps]
      .sort((a, b) => (a.strategyId < b.strategyId ? -1 : a.strategyId > b.strategyId ? 1 : 0))
      .map((cap) => ({
        strategyId: cap.strategyId,
        maxDebit: encodeAmount(cap.maxDebit),
        maxCommission: [...cap.maxCommission]
          .sort((a, b) => {
            // A total comparator. Returning 1 for equal keys made the sort input-order
            // dependent, so identical caps could canonicalise two ways.
            const left = formatAssetKey(a.asset);
            const right = formatAssetKey(b.asset);
            return left < right ? -1 : left > right ? 1 : 0;
          })
          .map(encodeAmount),
      })),
    allocationAlgorithmVersion: plan.allocationAlgorithmVersion,
    feePolicyVersion: plan.feePolicyVersion,
    mandatePolicyVersion: plan.mandatePolicyVersion,
    baselineLedgerRevision: count('baselineLedgerRevision', plan.baselineLedgerRevision),
    cohortClosedAtSequence: count('cohortClosedAtSequence', plan.cohortClosedAtSequence),
    approvalExpiresAt: isoUtc('approvalExpiresAt', plan.approvalExpiresAt),
    submissionDeadlineAt: isoUtc('submissionDeadlineAt', plan.submissionDeadlineAt),
    signedRequestValidityMs: count('signedRequestValidityMs', plan.signedRequestValidityMs),
    clockSkewBudgetMs: count('clockSkewBudgetMs', plan.clockSkewBudgetMs),
    authorizationDurability: plan.authorizationDurability,
  };
}

export function planDigest(plan: SealedPlanPayload): string {
  return digestOf(planDigestPayload(plan));
}

/** The exact bytes an owner approved. Kept for evidence export and independent recomputation. */
export function planCanonicalBytes(plan: SealedPlanPayload): string {
  return canonicalJson(planDigestPayload(plan));
}
