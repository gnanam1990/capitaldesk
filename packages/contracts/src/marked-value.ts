import type { AssetKey } from './money.js';

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
  return Object.freeze({ kind: 'MarkedValue' as const, ...init });
}
