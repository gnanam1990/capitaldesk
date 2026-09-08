import { describe, expect, it } from 'vitest';
import { amount, assetKey, ContractViolation } from '@capitaldesk/contracts';
import { targetProgress, validateStrategyTarget } from './strategy-intent.js';

const BTC = assetKey('BTC', 'v1');
const USDT = assetKey('USDT', 'v1');
const market = {
  symbol: 'BTCUSDT',
  baseAsset: BTC,
  quoteAsset: USDT,
  maxTargetBaseAtoms: 1000n,
  activePolicyVersion: 3n,
} as const;
const proposal = {
  intentId: 'intent-1',
  symbol: 'BTCUSDT',
  targetBaseQtyAtoms: '600',
  maxBuyPrice: '62000.00',
  minSellPrice: '59000.0',
  maxQuoteDebitAtoms: '500000',
  expiresAt: '2030-01-01T00:00:00.000Z',
  strategyRevision: '7',
  policyVersion: '3',
} as const;

describe('absolute strategy targets', () => {
  it('validates and canonicalises exact quantities, bounds, expiry and policy binding', () => {
    const result = validateStrategyTarget(proposal, market, new Date('2029-01-01T00:00:00Z'));
    expect(result.targetBase.atoms).toBe(600n);
    expect(result.maxBuyPrice).toBe('62000');
    expect(result.minSellPrice).toBe('59000');
    expect(result.strategyRevision).toBe(7n);
  });

  it.each([
    [{ ...proposal, symbol: 'ETHUSDT' }, 'IDENTITY_SCOPE_MISMATCH'],
    [{ ...proposal, targetBaseQtyAtoms: '1001' }, 'POLICY_BUDGET_EXCEEDED'],
    [{ ...proposal, policyVersion: '2' }, 'POLICY_MANDATE_VERSION_STALE'],
    [{ ...proposal, expiresAt: '2028-01-01T00:00:00Z' }, 'INTENT_EXPIRED'],
    [{ ...proposal, targetBaseQtyAtoms: 600 as never }, 'MONEY_NOT_AN_INTEGER'],
    [{ ...proposal, maxBuyPrice: null, minSellPrice: null }, 'PLAN_LIMIT_INCOMPATIBLE'],
  ])('refuses malformed or unauthorized target %j', (candidate, reason) => {
    let failure: unknown;
    try {
      validateStrategyTarget(candidate, market, new Date('2029-01-01T00:00:00Z'));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ContractViolation);
    expect((failure as ContractViolation).reason).toBe(reason);
  });

  it('treats a repeated target as an absolute holding, not another buy', () => {
    const target = amount(BTC, 600n);
    expect(
      targetProgress({
        target,
        owned: amount(BTC, 600n),
        incomingCommittedAtoms: 0n,
        outgoingCommittedAtoms: 0n,
      }),
    ).toMatchObject({ direction: 'SATISFIED', remainingAtoms: 0n, replannable: false });
  });

  it('counts an unresolved commitment once and blocks a second plan', () => {
    expect(
      targetProgress({
        target: amount(BTC, 600n),
        owned: amount(BTC, 400n),
        incomingCommittedAtoms: 150n,
        outgoingCommittedAtoms: 0n,
      }),
    ).toMatchObject({ direction: 'BUY', remainingAtoms: 50n, replannable: false });
  });

  it('keeps the exact residual after a partial IOC without authorizing an automatic repeat', () => {
    expect(
      targetProgress({
        target: amount(BTC, 600n),
        owned: amount(BTC, 590n),
        incomingCommittedAtoms: 0n,
        outgoingCommittedAtoms: 0n,
      }),
    ).toMatchObject({ direction: 'BUY', remainingAtoms: 10n, replannable: true });
  });
});
