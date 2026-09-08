import { violate } from './errors.js';
import { MAX_ATOMS, MAX_ATOM_DIGITS, type AssetKey } from './money.js';
import { isStrictUtcInstant } from './time.js';

/**
 * A marked (estimated) portfolio value.
 *
 * This type exists to be structurally incompatible with {@link AssetAmount}: it has no
 * `kind: 'AssetAmount'` and no arithmetic. There is deliberately no function anywhere in
 * this package that converts a MarkedValue into spendable money, because marked value can
 * never create spending capacity (TDD sections 5 and 6, INV-02).
 */
export interface MarkedValue {
  readonly kind: 'MarkedValue';
  readonly quote: AssetKey;
  /** Estimated value in quote atoms. An estimate, never a claim and never reservable. */
  readonly estimatedAtoms: bigint;
  /** Identifier of the price source that produced the estimate. */
  readonly priceSource: string;
  /** Source observation time, ISO-8601 UTC. */
  readonly observedAt: string;
  /** Freshness classification at the time the estimate was produced. */
  readonly freshness: 'FRESH' | 'STALE' | 'UNKNOWN';
}

export function markedValue(init: Omit<MarkedValue, 'kind'>): MarkedValue {
  // A negative "estimate" is not an estimate, and an unparseable instant makes the freshness
  // classification meaningless. Both were accepted before, so a MarkedValue could contradict
  // its own documented contract.
  if (init.estimatedAtoms < 0n) {
    violate('MONEY_NEGATIVE_RESULT', 'a marked value estimate is nonnegative', {
      estimatedAtoms: init.estimatedAtoms.toString(),
    });
  }
  if (init.estimatedAtoms > MAX_ATOMS) {
    violate('MONEY_PRECISION_EXCEEDED', `marked value exceeds ${MAX_ATOM_DIGITS} digits`, {
      estimatedAtoms: init.estimatedAtoms.toString(),
    });
  }
  if (!isStrictUtcInstant(init.observedAt)) {
    violate('EVIDENCE_STALE', 'observedAt must be a real ISO-8601 UTC instant ending in Z', {
      observedAt: init.observedAt,
    });
  }
  if (init.priceSource.length === 0) {
    violate('POLICY_CONFIGURATION_MISSING', 'a marked value must name its price source');
  }
  // `kind` is assigned last so a caller cannot override the discriminator through `init` and
  // hand back an object that lies about its own runtime variant.
  return Object.freeze({ ...init, kind: 'MarkedValue' as const });
}
