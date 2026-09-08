import { describe, expect, it } from 'vitest';
import { assetKey } from './money.js';
import {
  permitsRiskIncrease,
  poolAssetExposure,
  poolConcentration,
  prospectivePoolConcentration,
  ratioLimit,
  strategyShareOfPool,
  type ValuedClaim,
} from './risk.js';

const BTC = assetKey('BTC', 'binance-spot-2026-09-08');
const USDT = assetKey('USDT', 'binance-spot-2026-09-08');
const BNB = assetKey('BNB', 'binance-spot-2026-09-08');

const FIFTY_PERCENT = ratioLimit(1n, 2n);

function claim(
  ownerId: string,
  ownerKind: 'STRATEGY' | 'HOUSE',
  asset: ReturnType<typeof assetKey>,
  value: bigint,
  valued = true,
): ValuedClaim {
  return { ownerId, ownerKind, asset, referenceValueAtoms: value, valued };
}

describe('pool concentration', () => {
  // --- regression: maintainer review, splitting defeated the limit --------------------
  // A pool worth 1000 holding 600 of one asset is 60% concentrated in it. Measuring one
  // strategy's holding over the pool total reported 20% per strategy and passed a 50% limit,
  // so the control could be defeated by an ownership reassignment that moves no funds.
  describe('splitting a holding across strategies (regression: draft review)', () => {
    const split: readonly ValuedClaim[] = [
      claim('a', 'STRATEGY', BTC, 200n),
      claim('b', 'STRATEGY', BTC, 200n),
      claim('c', 'STRATEGY', BTC, 200n),
      claim('house', 'HOUSE', USDT, 400n),
    ];

    it('sums pool exposure across every owner', () => {
      expect(poolAssetExposure(split, BTC)).toBe(600n);
    });

    it('reports the exposure as exceeding a 50% limit', () => {
      const outcome = poolConcentration(split, BTC, FIFTY_PERCENT);
      expect(outcome.kind).toBe('EXCEEDED');
      expect(permitsRiskIncrease(outcome)).toBe(false);
    });

    it('gives the identical result when the same 600 sits with one strategy', () => {
      const consolidated: readonly ValuedClaim[] = [
        claim('a', 'STRATEGY', BTC, 600n),
        claim('house', 'HOUSE', USDT, 400n),
      ];
      const a = poolConcentration(split, BTC, FIFTY_PERCENT);
      const b = poolConcentration(consolidated, BTC, FIFTY_PERCENT);
      expect(a).toEqual(b);
    });

    it('is invariant under every reassignment of the same holdings', () => {
      const partitions: ReadonlyArray<readonly bigint[]> = [
        [600n],
        [300n, 300n],
        [200n, 200n, 200n],
        [1n, 599n],
        [100n, 100n, 100n, 100n, 100n, 100n],
      ];
      const results = partitions.map((parts) => {
        const claims = parts.map((value, index) => claim(`s${index}`, 'STRATEGY', BTC, value));
        return poolConcentration(
          [...claims, claim('house', 'HOUSE', USDT, 400n)],
          BTC,
          FIFTY_PERCENT,
        );
      });
      for (const result of results) expect(result).toEqual(results[0]);
    });

    it('still allows a separate per-strategy share limit to pass at 20%', () => {
      // The two controls answer different questions, and both remain available.
      expect(strategyShareOfPool(split, 'a', FIFTY_PERCENT).kind).toBe('WITHIN_LIMIT');
      expect(poolConcentration(split, BTC, FIFTY_PERCENT).kind).toBe('EXCEEDED');
    });

    it('flags a strategy that controls most of the pool', () => {
      const dominated: readonly ValuedClaim[] = [
        claim('a', 'STRATEGY', BTC, 300n),
        claim('a', 'STRATEGY', USDT, 400n),
        claim('b', 'STRATEGY', USDT, 300n),
      ];
      expect(strategyShareOfPool(dominated, 'a', FIFTY_PERCENT).kind).toBe('EXCEEDED');
    });
  });

  describe('exact rational boundaries', () => {
    it('treats exactly the limit as within it, and one atom more as exceeding', () => {
      const atLimit = [claim('a', 'STRATEGY', BTC, 500n), claim('h', 'HOUSE', USDT, 500n)];
      expect(poolConcentration(atLimit, BTC, FIFTY_PERCENT).kind).toBe('WITHIN_LIMIT');

      const overByOne = [claim('a', 'STRATEGY', BTC, 501n), claim('h', 'HOUSE', USDT, 499n)];
      expect(poolConcentration(overByOne, BTC, FIFTY_PERCENT).kind).toBe('EXCEEDED');
    });

    it('compares a repeating rational exactly, where floating point would not', () => {
      // 1/3 of the pool against a 1/3 limit is exactly at the limit, not marginally over.
      const third = ratioLimit(1n, 3n);
      const claims = [claim('a', 'STRATEGY', BTC, 1n), claim('h', 'HOUSE', USDT, 2n)];
      expect(poolConcentration(claims, BTC, third).kind).toBe('WITHIN_LIMIT');
    });

    it('handles values far beyond IEEE754 exact integers', () => {
      const huge = 10n ** 30n;
      const claims = [claim('a', 'STRATEGY', BTC, huge + 1n), claim('h', 'HOUSE', USDT, huge - 1n)];
      expect(poolConcentration(claims, BTC, FIFTY_PERCENT).kind).toBe('EXCEEDED');
    });
  });

  describe('unpriceable and empty denominators', () => {
    it('is UNCOMPUTABLE when any denominator asset lacks a fresh price', () => {
      const claims = [claim('a', 'STRATEGY', BTC, 100n), claim('h', 'HOUSE', BNB, 0n, false)];
      const outcome = poolConcentration(claims, BTC, FIFTY_PERCENT);
      expect(outcome.kind).toBe('UNCOMPUTABLE');
      expect(permitsRiskIncrease(outcome)).toBe(false);
    });

    it('never treats an unpriceable asset as worth zero', () => {
      const withUnpriced = [claim('a', 'STRATEGY', BTC, 600n), claim('h', 'HOUSE', BNB, 0n, false)];
      // Valuing the unpriceable asset at zero would make BTC 100% and merely EXCEEDED; the
      // honest answer is that the ratio is not computable at all.
      expect(poolConcentration(withUnpriced, BTC, FIFTY_PERCENT).kind).toBe('UNCOMPUTABLE');
    });

    it('reports an empty pool rather than dividing by zero', () => {
      expect(poolConcentration([], BTC, FIFTY_PERCENT).kind).toBe('EMPTY_POOL');
      expect(poolConcentration([claim('h', 'HOUSE', USDT, 0n)], BTC, FIFTY_PERCENT).kind).toBe(
        'EMPTY_POOL',
      );
    });

    it('blocks a risk increase on an empty pool, since the ratio is undefined', () => {
      expect(permitsRiskIncrease(poolConcentration([], BTC, FIFTY_PERCENT))).toBe(false);
    });
  });

  describe('prospective worst-case exposure', () => {
    const before: readonly ValuedClaim[] = [
      claim('a', 'STRATEGY', BTC, 400n),
      claim('h', 'HOUSE', USDT, 600n),
    ];

    it('passes on the current state and fails on the post-plan state', () => {
      expect(poolConcentration(before, BTC, FIFTY_PERCENT).kind).toBe('WITHIN_LIMIT');
      // Spend 300 USDT to acquire 300 BTC: exposure 700 of 1000.
      const outcome = prospectivePoolConcentration(
        before,
        {
          asset: BTC,
          maxAcquiredReferenceValueAtoms: 300n,
          spentAsset: USDT,
          maxSpentReferenceValueAtoms: 300n,
        },
        FIFTY_PERCENT,
      );
      expect(outcome.kind).toBe('EXCEEDED');
    });

    it('admits a plan that stays within the limit after it fills', () => {
      const outcome = prospectivePoolConcentration(
        before,
        {
          asset: BTC,
          maxAcquiredReferenceValueAtoms: 100n,
          spentAsset: USDT,
          maxSpentReferenceValueAtoms: 100n,
        },
        FIFTY_PERCENT,
      );
      expect(outcome.kind).toBe('WITHIN_LIMIT');
      expect(outcome.kind === 'WITHIN_LIMIT' ? outcome.exposureAtoms : 0n).toBe(500n);
    });

    it('accounts for a fee making the pool total shrink', () => {
      // Spend 300, acquire only 290: total 990, exposure 690.
      const outcome = prospectivePoolConcentration(
        before,
        {
          asset: BTC,
          maxAcquiredReferenceValueAtoms: 290n,
          spentAsset: USDT,
          maxSpentReferenceValueAtoms: 300n,
        },
        FIFTY_PERCENT,
      );
      expect(outcome.kind === 'EXCEEDED' ? outcome.totalAtoms : 0n).toBe(990n);
    });

    it('lets a first purchase into an empty pool be evaluated rather than skipped', () => {
      const outcome = prospectivePoolConcentration(
        [claim('h', 'HOUSE', USDT, 1000n)],
        {
          asset: BTC,
          maxAcquiredReferenceValueAtoms: 900n,
          spentAsset: USDT,
          maxSpentReferenceValueAtoms: 900n,
        },
        FIFTY_PERCENT,
      );
      expect(outcome.kind).toBe('EXCEEDED');
    });

    it('refuses a plan that would spend more than the pool holds in the funding asset', () => {
      expect(() =>
        prospectivePoolConcentration(
          before,
          {
            asset: BTC,
            maxAcquiredReferenceValueAtoms: 700n,
            spentAsset: USDT,
            maxSpentReferenceValueAtoms: 700n,
          },
          FIFTY_PERCENT,
        ),
      ).toThrow(/PLAN_INSUFFICIENT_CLAIM/);
    });

    it('is UNCOMPUTABLE prospectively when an asset cannot be valued', () => {
      const outcome = prospectivePoolConcentration(
        [...before, claim('h', 'HOUSE', BNB, 0n, false)],
        {
          asset: BTC,
          maxAcquiredReferenceValueAtoms: 1n,
          spentAsset: USDT,
          maxSpentReferenceValueAtoms: 1n,
        },
        FIFTY_PERCENT,
      );
      expect(outcome.kind).toBe('UNCOMPUTABLE');
    });
  });

  describe('limit validation', () => {
    it('refuses a zero or negative denominator', () => {
      expect(() => ratioLimit(1n, 0n)).toThrow(/denominator must be positive/);
    });

    it('refuses a limit outside 0..1', () => {
      expect(() => ratioLimit(3n, 2n)).toThrow(/between 0 and 1/);
      expect(() => ratioLimit(-1n, 2n)).toThrow(/between 0 and 1/);
    });

    it('refuses a negative valued claim', () => {
      expect(() =>
        poolConcentration([claim('a', 'STRATEGY', BTC, -1n)], BTC, FIFTY_PERCENT),
      ).toThrow(/MONEY_NEGATIVE_RESULT/);
    });
  });
});

// --- regression: PR 1 review, same-asset prospective exposure was overstated ------------
// Spending the same asset a plan acquires nets out. Adding the acquisition without
// subtracting the spend overstated exposure and could block a plan that does not increase it.
describe('prospective exposure when the funding asset is the target asset', () => {
  const BTC_ONLY: readonly ValuedClaim[] = [
    claim('a', 'STRATEGY', BTC, 400n),
    claim('h', 'HOUSE', USDT, 600n),
  ];

  it('does not increase exposure when acquiring and spending the same asset', () => {
    const outcome = prospectivePoolConcentration(
      BTC_ONLY,
      {
        asset: BTC,
        maxAcquiredReferenceValueAtoms: 100n,
        spentAsset: BTC,
        maxSpentReferenceValueAtoms: 100n,
      },
      ratioLimit(1n, 2n),
    );
    expect(outcome.kind).toBe('WITHIN_LIMIT');
    expect(outcome.kind === 'WITHIN_LIMIT' ? outcome.exposureAtoms : 0n).toBe(400n);
  });

  it('reflects a net increase when acquiring more of the asset than it spends', () => {
    // 400 held, +300 acquired, -100 spent => exposure 600 of a 1200 total: exactly the 50%
    // limit, so WITHIN_LIMIT is correct and the exposure figure is what this asserts.
    const outcome = prospectivePoolConcentration(
      BTC_ONLY,
      {
        asset: BTC,
        maxAcquiredReferenceValueAtoms: 300n,
        spentAsset: BTC,
        maxSpentReferenceValueAtoms: 100n,
      },
      ratioLimit(1n, 2n),
    );
    expect(outcome.kind).toBe('WITHIN_LIMIT');
    expect(outcome.kind === 'WITHIN_LIMIT' ? outcome.exposureAtoms : 0n).toBe(600n);
    expect(outcome.kind === 'WITHIN_LIMIT' ? outcome.totalAtoms : 0n).toBe(1200n);
  });

  it('exceeds the limit once the net increase passes it', () => {
    const outcome = prospectivePoolConcentration(
      BTC_ONLY,
      {
        asset: BTC,
        maxAcquiredReferenceValueAtoms: 301n,
        spentAsset: BTC,
        maxSpentReferenceValueAtoms: 100n,
      },
      ratioLimit(1n, 2n),
    );
    expect(outcome.kind).toBe('EXCEEDED');
  });

  it('still nets cross-asset spending against the funding asset only', () => {
    const outcome = prospectivePoolConcentration(
      BTC_ONLY,
      {
        asset: BTC,
        maxAcquiredReferenceValueAtoms: 100n,
        spentAsset: USDT,
        maxSpentReferenceValueAtoms: 100n,
      },
      ratioLimit(1n, 2n),
    );
    expect(outcome.kind === 'WITHIN_LIMIT' ? outcome.exposureAtoms : 0n).toBe(500n);
  });
});
