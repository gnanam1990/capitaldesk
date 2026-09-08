import { violate } from './errors.js';
import { formatAssetKey, sameAsset, type AssetKey } from './money.js';

/**
 * Risk arithmetic (ADR-0009).
 *
 * ## The defect this replaces
 *
 * The first version defined pool concentration as one strategy's holding of an asset over
 * the pool total. That measures an ownership share, not a pool's exposure, and the two come
 * apart exactly where it matters. A pool worth 1000 holding 600 of one asset is 60%
 * concentrated in it. Split that 600 across three strategies at 200 each and every
 * per-strategy figure is 20%, comfortably under a 50% limit — while the pool's exposure to
 * the asset has not changed at all.
 *
 * That made the control defeatable by an ownership reassignment, which moves no funds and
 * changes no market risk. Pool concentration is now summed across **all** owners, strategies
 * and HOUSE alike, so it is invariant under reassignment and splitting. A separate optional
 * per-strategy limit still exists, because "no single strategy may control most of the pool"
 * is a real and different question — it just is not the pool's exposure.
 *
 * ## Arithmetic
 *
 * Everything is exact integer atoms compared as rationals by cross-multiplication. No
 * floating point, no division, no tolerance.
 */

/** An exact rational limit, e.g. 1/2 for 50%. */
export interface RatioLimit {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function ratioLimit(numerator: bigint, denominator: bigint): RatioLimit {
  if (denominator <= 0n) {
    violate('POLICY_CONFIGURATION_MISSING', 'ratio limit denominator must be positive', {
      denominator: denominator.toString(),
    });
  }
  if (numerator < 0n || numerator > denominator) {
    violate('POLICY_CONFIGURATION_MISSING', 'ratio limit must lie between 0 and 1 inclusive', {
      numerator: numerator.toString(),
      denominator: denominator.toString(),
    });
  }
  return Object.freeze({ numerator, denominator });
}

/**
 * One owner's claim on one asset, already valued in the pool's reference quote asset.
 *
 * Valuation happens before this module: if any asset could not be valued inside its freshness
 * class, the caller passes `valued: false` and every result becomes UNCOMPUTABLE rather than
 * silently treating the asset as worthless.
 */
export interface ValuedClaim {
  readonly ownerId: string;
  /** `HOUSE` is an owner like any other for exposure purposes. */
  readonly ownerKind: 'STRATEGY' | 'HOUSE';
  readonly asset: AssetKey;
  /** Value in reference-quote atoms across AVAILABLE + RESERVED + QUARANTINED. */
  readonly referenceValueAtoms: bigint;
  /** False when no reference price inside the freshness class was available. */
  readonly valued: boolean;
}

/** The prospective effect of a plan, at its worst case for concentration. */
export interface ProspectiveExposure {
  /** Asset whose pool exposure the plan would increase. */
  readonly asset: AssetKey;
  /** Maximum reference value the pool could acquire in that asset. */
  readonly maxAcquiredReferenceValueAtoms: bigint;
  /** Maximum reference value the pool could spend from another asset. */
  readonly spentAsset: AssetKey;
  readonly maxSpentReferenceValueAtoms: bigint;
}

export type ConcentrationOutcome =
  | { readonly kind: 'WITHIN_LIMIT'; readonly exposureAtoms: bigint; readonly totalAtoms: bigint }
  | { readonly kind: 'EXCEEDED'; readonly exposureAtoms: bigint; readonly totalAtoms: bigint }
  /** An asset in the denominator could not be valued. Never treated as zero. */
  | { readonly kind: 'UNCOMPUTABLE'; readonly reason: string }
  /**
   * The pool holds nothing to be concentrated in. A current-state ratio is undefined here;
   * the limit is still enforced against the prospective post-plan state, where the
   * denominator is non-zero.
   */
  | { readonly kind: 'EMPTY_POOL' };

function totalValue(claims: readonly ValuedClaim[]): bigint {
  return claims.reduce((sum, claim) => sum + claim.referenceValueAtoms, 0n);
}

function assertNonNegative(claims: readonly ValuedClaim[]): void {
  for (const claim of claims) {
    if (claim.referenceValueAtoms < 0n) {
      violate('MONEY_NEGATIVE_RESULT', 'a valued claim cannot be negative', {
        ownerId: claim.ownerId,
        asset: formatAssetKey(claim.asset),
      });
    }
  }
}

function unvaluedAsset(claims: readonly ValuedClaim[]): AssetKey | null {
  const found = claims.find((claim) => !claim.valued);
  return found === undefined ? null : found.asset;
}

/**
 * Pool exposure to one asset: summed across **every** owner, strategies and HOUSE alike.
 *
 * This is the number a concentration limit is about. It cannot be changed by moving a claim
 * from one strategy to another, which is the property the first version lacked.
 */
export function poolAssetExposure(claims: readonly ValuedClaim[], asset: AssetKey): bigint {
  return claims
    .filter((claim) => sameAsset(claim.asset, asset))
    .reduce((sum, claim) => sum + claim.referenceValueAtoms, 0n);
}

/** Exact rational comparison: is `numerator / denominator` strictly greater than the limit? */
function exceeds(numerator: bigint, denominator: bigint, limit: RatioLimit): boolean {
  return numerator * limit.denominator > denominator * limit.numerator;
}

/**
 * Pool concentration in one asset, against a limit.
 *
 * Evaluated on the **current** state. Admission must also evaluate the prospective state; see
 * {@link prospectivePoolConcentration}.
 */
export function poolConcentration(
  claims: readonly ValuedClaim[],
  asset: AssetKey,
  limit: RatioLimit,
): ConcentrationOutcome {
  assertNonNegative(claims);
  const unvalued = unvaluedAsset(claims);
  if (unvalued !== null) {
    return {
      kind: 'UNCOMPUTABLE',
      reason: `no reference price inside its freshness class for ${formatAssetKey(unvalued)}`,
    };
  }

  const total = totalValue(claims);
  if (total === 0n) return { kind: 'EMPTY_POOL' };

  const exposure = poolAssetExposure(claims, asset);
  return exceeds(exposure, total, limit)
    ? { kind: 'EXCEEDED', exposureAtoms: exposure, totalAtoms: total }
    : { kind: 'WITHIN_LIMIT', exposureAtoms: exposure, totalAtoms: total };
}

/**
 * Pool concentration after a plan executes at its worst case for concentration.
 *
 * Admission uses this, not the current state: a plan that is within the limit today and over
 * it the moment it fills has not respected the limit. Worst case means maximum acquisition of
 * the target asset and maximum spend from the funding asset, since that maximises the ratio.
 */
export function prospectivePoolConcentration(
  claims: readonly ValuedClaim[],
  prospective: ProspectiveExposure,
  limit: RatioLimit,
): ConcentrationOutcome {
  assertNonNegative(claims);
  if (
    prospective.maxAcquiredReferenceValueAtoms < 0n ||
    prospective.maxSpentReferenceValueAtoms < 0n
  ) {
    violate('MONEY_NEGATIVE_RESULT', 'prospective exposure values must be nonnegative');
  }
  const unvalued = unvaluedAsset(claims);
  if (unvalued !== null) {
    return {
      kind: 'UNCOMPUTABLE',
      reason: `no reference price inside its freshness class for ${formatAssetKey(unvalued)}`,
    };
  }

  const currentTotal = totalValue(claims);
  const spent = poolAssetExposure(claims, prospective.spentAsset);
  if (prospective.maxSpentReferenceValueAtoms > spent) {
    violate(
      'PLAN_INSUFFICIENT_CLAIM',
      'a plan cannot spend more reference value than the pool holds in the funding asset',
      {
        asset: formatAssetKey(prospective.spentAsset),
        held: spent.toString(),
        maxSpend: prospective.maxSpentReferenceValueAtoms.toString(),
      },
    );
  }

  // A trade converts value between assets; the pool total moves only by the difference
  // between what is acquired and what is spent.
  const total =
    currentTotal -
    prospective.maxSpentReferenceValueAtoms +
    prospective.maxAcquiredReferenceValueAtoms;
  if (total <= 0n) return { kind: 'EMPTY_POOL' };

  const exposure =
    poolAssetExposure(claims, prospective.asset) + prospective.maxAcquiredReferenceValueAtoms;

  return exceeds(exposure, total, limit)
    ? { kind: 'EXCEEDED', exposureAtoms: exposure, totalAtoms: total }
    : { kind: 'WITHIN_LIMIT', exposureAtoms: exposure, totalAtoms: total };
}

/**
 * A separate, optional control: how much of the pool a single strategy controls.
 *
 * This answers a different question from pool exposure and is not a substitute for it. Unlike
 * pool concentration it *is* sensitive to reassignment, which is the point.
 */
export function strategyShareOfPool(
  claims: readonly ValuedClaim[],
  strategyId: string,
  limit: RatioLimit,
): ConcentrationOutcome {
  assertNonNegative(claims);
  const unvalued = unvaluedAsset(claims);
  if (unvalued !== null) {
    return {
      kind: 'UNCOMPUTABLE',
      reason: `no reference price inside its freshness class for ${formatAssetKey(unvalued)}`,
    };
  }
  const total = totalValue(claims);
  if (total === 0n) return { kind: 'EMPTY_POOL' };

  const held = claims
    .filter((claim) => claim.ownerKind === 'STRATEGY' && claim.ownerId === strategyId)
    .reduce((sum, claim) => sum + claim.referenceValueAtoms, 0n);

  return exceeds(held, total, limit)
    ? { kind: 'EXCEEDED', exposureAtoms: held, totalAtoms: total }
    : { kind: 'WITHIN_LIMIT', exposureAtoms: held, totalAtoms: total };
}

/** Risk-increasing actions are blocked unless concentration is provably within its limit. */
export function permitsRiskIncrease(outcome: ConcentrationOutcome): boolean {
  return outcome.kind === 'WITHIN_LIMIT';
}
