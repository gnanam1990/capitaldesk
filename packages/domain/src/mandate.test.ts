import { describe, expect, it } from 'vitest';
import { assetKey, ContractViolation } from '@capitaldesk/contracts';
import {
  evaluateMandate,
  mandatePolicy,
  type AdmissionCandidate,
  type MandatePolicyWire,
} from './mandate.js';

const BTC = assetKey('BTC', 'v1');
const USDT = assetKey('USDT', 'v1');
const draft: MandatePolicyWire = {
  policyVersion: '1',
  selectedSymbol: 'BTCUSDT',
  baseAsset: 'BTC@v1',
  quoteAsset: 'USDT@v1',
  maxPoolPlanQuoteDebitAtoms: '500',
  maxDailyGrossBuyQuoteAtoms: '1000',
  poolConcentrationNumerator: '3',
  poolConcentrationDenominator: '4',
  freshnessMaxAgeMs: {
    PRICE_SNAPSHOT: '1000',
    ACCOUNT_SNAPSHOT: '2000',
    SYMBOL_METADATA: '3000',
    VENUE_CLOCK: '4000',
  },
  planLifetimeMs: '60000',
  buyInhibitUntil: null,
  riskIncreaseHalted: false,
  feePolicyVersion: 'STANDARD_NO_BNB_V1',
  strategyLimits: [
    {
      strategyId: 'strategy-a',
      maxTargetBaseAtoms: '100',
      maxPlanQuoteDebitAtoms: '400',
      maxDailyGrossBuyQuoteAtoms: '800',
    },
  ],
};
const policy = mandatePolicy(draft);
const candidate: AdmissionCandidate = {
  policyVersion: 1n,
  strategyId: 'strategy-a',
  symbol: 'BTCUSDT',
  side: 'BUY',
  fundingAsset: USDT,
  requiredFundingAtoms: 200n,
  strategyAvailableFundingAtoms: 300n,
  venueAvailableFundingAtoms: 1_000_000n,
  maxQuoteDebitAtoms: 200n,
  committedBuyQuoteAtoms: 100n,
  outstandingBuyQuoteAtoms: 100n,
  currentUtcBucket: '2026-09-08',
  dispatchUtcBucket: '2026-09-08',
  expiresInMs: 30_000n,
  buyInhibitActive: false,
  feePolicyVersion: 'STANDARD_NO_BNB_V1',
  freshnessAgeMs: {
    PRICE_SNAPSHOT: 10n,
    ACCOUNT_SNAPSHOT: 10n,
    SYMBOL_METADATA: 10n,
    VENUE_CLOCK: 10n,
  },
  valuedClaims: [
    {
      ownerId: 'strategy-a',
      ownerKind: 'STRATEGY',
      asset: BTC,
      referenceValueAtoms: 100n,
      valued: true,
    },
    {
      ownerId: 'strategy-a',
      ownerKind: 'STRATEGY',
      asset: USDT,
      referenceValueAtoms: 900n,
      valued: true,
    },
  ],
  prospectiveExposure: {
    asset: BTC,
    maxAcquiredReferenceValueAtoms: 200n,
    spentAsset: USDT,
    maxSpentReferenceValueAtoms: 200n,
  },
};

describe('deterministic mandate admission', () => {
  it('admits a candidate inside every owner limit', () => {
    expect(evaluateMandate(policy, candidate)).toEqual({
      allowed: true,
      explanation: 'candidate is inside every owner mandate',
    });
  });

  it('uses strategy authority even when the venue shows surplus funds', () => {
    expect(
      evaluateMandate(policy, { ...candidate, strategyAvailableFundingAtoms: 199n }),
    ).toMatchObject({ allowed: false, reason: 'PLAN_INSUFFICIENT_CLAIM' });
  });

  it('counts committed fills and outstanding reservations in the daily budget', () => {
    expect(
      evaluateMandate(policy, {
        ...candidate,
        committedBuyQuoteAtoms: 500n,
        outstandingBuyQuoteAtoms: 101n,
      }),
    ).toMatchObject({ allowed: false, reason: 'POLICY_BUDGET_EXCEEDED' });
  });

  it('invalidates a pre-dispatch BUY crossing midnight UTC', () => {
    expect(
      evaluateMandate(policy, { ...candidate, dispatchUtcBucket: '2026-09-09' }),
    ).toMatchObject({ allowed: false, reason: 'APPROVAL_EXPIRED' });
  });

  it('blocks an owner buy inhibit without creating a SELL', () => {
    const outcome = evaluateMandate(policy, { ...candidate, buyInhibitActive: true });
    expect(outcome).toMatchObject({ allowed: false, reason: 'POLICY_RISK_INCREASE_HALTED' });
    expect(candidate.side).toBe('BUY');
  });

  it.each([
    ['PRICE_SNAPSHOT', 'POLICY_CONCENTRATION_UNCOMPUTABLE'],
    ['ACCOUNT_SNAPSHOT', 'EVIDENCE_STALE'],
    ['SYMBOL_METADATA', 'EVIDENCE_STALE'],
    ['VENUE_CLOCK', 'CLOCK_SKEW_UNBOUNDED'],
  ] as const)('fails closed when %s is stale', (freshnessClass, reason) => {
    const freshness = { ...candidate.freshnessAgeMs, [freshnessClass]: 10_000n };
    expect(evaluateMandate(policy, { ...candidate, freshnessAgeMs: freshness })).toMatchObject({
      allowed: false,
      reason,
    });
  });

  it('blocks an unpriceable denominator asset', () => {
    expect(
      evaluateMandate(policy, {
        ...candidate,
        valuedClaims: [
          ...candidate.valuedClaims,
          {
            ownerId: 'HOUSE',
            ownerKind: 'HOUSE',
            asset: assetKey('BNB', 'v1'),
            referenceValueAtoms: 0n,
            valued: false,
          },
        ],
      }),
    ).toMatchObject({ allowed: false, reason: 'POLICY_CONCENTRATION_UNCOMPUTABLE' });
  });

  it('requires all four freshness limits with no default', () => {
    const missing = {
      ...draft,
      freshnessMaxAgeMs: { ...draft.freshnessMaxAgeMs, VENUE_CLOCK: undefined },
    } as unknown as MandatePolicyWire;
    let failure: unknown;
    try {
      mandatePolicy(missing);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ContractViolation);
    expect((failure as ContractViolation).reason).toBe('POLICY_CONFIGURATION_MISSING');
  });
});
