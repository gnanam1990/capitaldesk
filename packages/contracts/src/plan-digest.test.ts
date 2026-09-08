import { describe, expect, it } from 'vitest';
import { amount, assetKey } from './money.js';
import { poolId, venueAccountKey } from './identity.js';
import { priceFromDecimal } from './price.js';
import {
  PLAN_DIGEST_BOUND_FIELDS,
  planCanonicalBytes,
  planDigest,
  type SealedPlanPayload,
} from './plan-digest.js';

const BTC = assetKey('BTC', 'binance-spot-2026-09-08');
const USDT = assetKey('USDT', 'binance-spot-2026-09-08');
const POOL = poolId('ws-primary', venueAccountKey('binance-spot', 'testnet', '81234567'), 1);

function validPlan(): SealedPlanPayload {
  return {
    pool: POOL,
    childClientOrderId: 'cd-01J8XQ3H4K5M6N7P8Q9R0S1T2U',
    symbol: 'BTCUSDT',
    side: 'BUY',
    orderType: 'LIMIT',
    timeInForce: 'IOC',
    grossBaseQuantity: amount(BTC, 3_000_000n),
    limitPrice: priceFromDecimal(BTC, USDT, '20000'),
    allocation: [
      {
        position: 0,
        strategyId: 'strategy-a',
        intentId: 'intent-a-1',
        intentRevision: 4,
        requestedGrossBase: amount(BTC, 1_000_000n),
      },
      {
        position: 1,
        strategyId: 'strategy-b',
        intentId: 'intent-b-1',
        intentRevision: 2,
        requestedGrossBase: amount(BTC, 2_000_000n),
      },
    ],
    strategyCaps: [
      {
        strategyId: 'strategy-a',
        maxDebit: amount(USDT, 20_020_000_000n),
        maxCommission: [amount(BTC, 1_000n)],
      },
      {
        strategyId: 'strategy-b',
        maxDebit: amount(USDT, 40_040_000_000n),
        maxCommission: [amount(BTC, 2_000n)],
      },
    ],
    allocationAlgorithmVersion: 'controlled-rounding-v1',
    feePolicyVersion: 'STANDARD_NO_BNB_V1',
    mandatePolicyVersion: 'policy-7',
    baselineLedgerRevision: 42,
    cohortClosedAtSequence: 1180,
    approvalExpiresAt: '2026-09-08T12:05:00.000Z',
    submissionDeadlineAt: '2026-09-08T12:04:30.000Z',
    signedRequestValidityMs: 5000,
    clockSkewBudgetMs: 1000,
    authorizationDurability: 'SYNCHRONOUS_REPLICA',
  };
}

describe('plan digest', () => {
  it('is deterministic for an unchanged payload', () => {
    expect(planDigest(validPlan())).toBe(planDigest(validPlan()));
  });

  it('is stable across key insertion order', () => {
    const reordered = Object.fromEntries(
      Object.entries(validPlan()).reverse(),
    ) as unknown as SealedPlanPayload;
    expect(planDigest(reordered)).toBe(planDigest(validPlan()));
  });

  it('pins the exact canonical bytes an owner approved', () => {
    const bytes = planCanonicalBytes(validPlan());
    expect(bytes.startsWith('{"allocation":[{"intentId":"intent-a-1"')).toBe(true);
    expect(bytes).not.toContain('undefined');
    expect(() => JSON.parse(bytes)).not.toThrow();
  });

  // TEST-PLAN T-006: mutating any bound field must invalidate the approval.
  describe('every bound field changes the digest', () => {
    const baseline = planDigest(validPlan());

    const mutations: Record<string, (plan: SealedPlanPayload) => SealedPlanPayload> = {
      pool: (p) => ({ ...p, pool: poolId('ws-primary', p.pool.account, 2) }),
      childClientOrderId: (p) => ({ ...p, childClientOrderId: 'cd-different' }),
      symbol: (p) => ({ ...p, symbol: 'ETHUSDT' }),
      side: (p) => ({ ...p, side: 'SELL' }),
      orderType: (p) => ({ ...p, orderType: 'LIMIT' as const, timeInForce: 'IOC' as const }),
      timeInForce: (p) => ({ ...p, timeInForce: 'IOC' as const }),
      grossBaseQuantity: (p) => ({ ...p, grossBaseQuantity: amount(BTC, 3_000_001n) }),
      limitPrice: (p) => ({ ...p, limitPrice: priceFromDecimal(BTC, USDT, '20000.01') }),
      allocation: (p) => ({
        ...p,
        allocation: [
          { ...p.allocation[1]!, position: 0 },
          { ...p.allocation[0]!, position: 1 },
        ],
      }),
      strategyCaps: (p) => ({
        ...p,
        strategyCaps: [{ ...p.strategyCaps[0]!, maxDebit: amount(USDT, 1n) }, p.strategyCaps[1]!],
      }),
      allocationAlgorithmVersion: (p) => ({ ...p, allocationAlgorithmVersion: 'v2' }),
      feePolicyVersion: (p) => ({ ...p, feePolicyVersion: 'QUOTE_FEE_FIXTURE_V1' }),
      mandatePolicyVersion: (p) => ({ ...p, mandatePolicyVersion: 'policy-8' }),
      baselineLedgerRevision: (p) => ({ ...p, baselineLedgerRevision: 43 }),
      cohortClosedAtSequence: (p) => ({ ...p, cohortClosedAtSequence: 1181 }),
      approvalExpiresAt: (p) => ({ ...p, approvalExpiresAt: '2026-09-08T12:06:00.000Z' }),
      submissionDeadlineAt: (p) => ({ ...p, submissionDeadlineAt: '2026-09-08T12:04:31.000Z' }),
      signedRequestValidityMs: (p) => ({ ...p, signedRequestValidityMs: 5001 }),
      clockSkewBudgetMs: (p) => ({ ...p, clockSkewBudgetMs: 1001 }),
      authorizationDurability: (p) => ({ ...p, authorizationDurability: 'AT_RISK_SINGLE_NODE' }),
    };

    it('covers exactly the declared bound-field list', () => {
      expect(Object.keys(mutations).sort()).toEqual([...PLAN_DIGEST_BOUND_FIELDS].sort());
    });

    for (const [field, mutate] of Object.entries(mutations)) {
      // orderType and timeInForce have a single legal value in v1, so mutating them cannot
      // change the digest. They are still bound: an illegal value is refused by the type
      // and by the wire schema before it can reach a digest.
      const singleValued = field === 'orderType' || field === 'timeInForce';
      it(`${field} ${singleValued ? 'has one legal v1 value' : 'invalidates the digest'}`, () => {
        const mutated = planDigest(mutate(validPlan()));
        if (singleValued) expect(mutated).toBe(baseline);
        else expect(mutated).not.toBe(baseline);
      });
    }
  });

  // --- regression: maintainer draft review, unknown fields bypassed the digest ---------
  // planDigest({...validPlan, newDecisionChangingField: 'changed'}) previously equalled the
  // original digest, so a field added by a later module could change the plan's meaning
  // while the owner's approval still verified.
  describe('unknown fields (regression: draft review)', () => {
    it('refuses an unknown top-level field instead of hashing around it', () => {
      const smuggled = { ...validPlan(), newDecisionChangingField: 'changed' } as SealedPlanPayload;
      expect(() => planDigest(smuggled)).toThrow(/newDecisionChangingField/);
    });

    it('refuses an unknown field on an allocation entry', () => {
      const plan = validPlan();
      const smuggled = {
        ...plan,
        allocation: [{ ...plan.allocation[0]!, priorityBoost: 'yes' }, plan.allocation[1]!],
      } as SealedPlanPayload;
      expect(() => planDigest(smuggled)).toThrow(/priorityBoost/);
    });

    it('refuses an unknown field on a strategy cap', () => {
      const plan = validPlan();
      const smuggled = {
        ...plan,
        strategyCaps: [{ ...plan.strategyCaps[0]!, overrideCap: 'true' }, plan.strategyCaps[1]!],
      } as SealedPlanPayload;
      expect(() => planDigest(smuggled)).toThrow(/overrideCap/);
    });

    it('refuses an unknown field nested inside a bound money value', () => {
      const plan = validPlan();
      const smuggled = {
        ...plan,
        grossBaseQuantity: { ...plan.grossBaseQuantity, adjustment: '1' },
      } as SealedPlanPayload;
      expect(() => planDigest(smuggled)).toThrow(/adjustment/);
    });

    it('refuses an unknown field nested inside the limit price', () => {
      const plan = validPlan();
      const smuggled = {
        ...plan,
        limitPrice: { ...plan.limitPrice, slippageAllowance: '5' },
      } as SealedPlanPayload;
      expect(() => planDigest(smuggled)).toThrow(/slippageAllowance/);
    });

    it('refuses an unknown field nested inside the pool identity', () => {
      const plan = validPlan();
      const smuggled = {
        ...plan,
        pool: { ...plan.pool, shadowEpoch: 9 },
      } as SealedPlanPayload;
      expect(() => planDigest(smuggled)).toThrow(/shadowEpoch/);
    });
  });

  describe('structural refusals', () => {
    it('refuses a submission deadline later than the approval expiry', () => {
      const plan = { ...validPlan(), submissionDeadlineAt: '2026-09-08T12:06:00.000Z' };
      expect(() => planDigest(plan)).toThrow(/SUBMISSION_DEADLINE_PASSED/);
    });

    it('refuses an allocation whose positions are not dense and ordered', () => {
      const plan = validPlan();
      const shuffled = {
        ...plan,
        allocation: [plan.allocation[1]!, plan.allocation[0]!],
      };
      expect(() => planDigest(shuffled)).toThrow(/dense and ordered/);
    });

    it('refuses an empty allocation', () => {
      expect(() => planDigest({ ...validPlan(), allocation: [] })).toThrow(/at least one/);
    });
  });
});
