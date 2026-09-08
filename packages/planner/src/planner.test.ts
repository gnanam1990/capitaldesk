import { describe, expect, it } from 'vitest';
import { assetKey } from '@capitaldesk/contracts';
import { previewPlan, type PlannerIntent, type PlannerMarket } from './planner.js';

const market: PlannerMarket = {
  workspaceId: 'ws-1',
  poolId: 'pool-1',
  accountKey: 'binance-spot/local/account-1',
  epoch: 1,
  symbol: 'BTCUSDT',
  baseAsset: assetKey('BTC', 'v1'),
  quoteAsset: assetKey('USDT', 'v1'),
  baseScale: 2,
  quoteScale: 2,
  priceScale: 2,
  tickAtoms: 100n,
  minPriceAtoms: 100n,
  maxPriceAtoms: 10_000_000n,
  lotStepAtoms: 5n,
  minQtyAtoms: 5n,
  maxQtyAtoms: 10_000n,
  minNotionalQuoteAtoms: 100n,
  maxNotionalQuoteAtoms: null,
  policyVersion: 1n,
  feePolicyVersion: 'STANDARD_NO_BNB_V1',
  nowMs: 1_000n,
};

function intent(overrides: Partial<PlannerIntent> = {}): PlannerIntent {
  return {
    intentId: 'intent-a',
    strategyId: 'strategy-a',
    acceptedSequence: 1n,
    strategyRevision: 1n,
    accountKey: market.accountKey,
    epoch: 1,
    symbol: 'BTCUSDT',
    policyVersion: 1n,
    feePolicyVersion: 'STANDARD_NO_BNB_V1',
    targetBaseAtoms: 20n,
    ownedBaseAtoms: 0n,
    availableBaseAtoms: 0n,
    availableQuoteAtoms: 1_000_000n,
    maxQuoteDebitAtoms: 1_000_000n,
    maxBuyPriceAtoms: 2_000_000n,
    minSellPriceAtoms: null,
    worstBaseCommissionAtoms: 0n,
    expiresAtMs: 2_000n,
    authorized: true,
    deferred: false,
    current: true,
    ...overrides,
  };
}

describe('deterministic plan preview', () => {
  it('coalesces same-side intents at the strictest BUY price in immutable FIFO order', () => {
    const a = intent();
    const b = intent({
      intentId: 'intent-b',
      strategyId: 'strategy-b',
      acceptedSequence: 2n,
      targetBaseAtoms: 15n,
      maxBuyPriceAtoms: 1_990_050n,
    });
    const result = previewPlan(market, [b, a]);
    expect(result).toMatchObject({
      kind: 'ORDER',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'IOC',
      limitPriceAtoms: 1_990_000n,
      grossBaseAtoms: 35n,
    });
    expect(
      result.kind === 'ORDER' ? result.allocations.map((entry) => entry.strategyId) : [],
    ).toEqual(['strategy-a', 'strategy-b']);
  });

  it('produces the same canonical preview after input shuffling', () => {
    const values = [
      intent({ intentId: 'c', strategyId: 'c', acceptedSequence: 3n }),
      intent({ intentId: 'a', strategyId: 'a', acceptedSequence: 1n }),
      intent({ intentId: 'b', strategyId: 'b', acceptedSequence: 2n }),
    ];
    expect(previewPlan(market, values)).toEqual(previewPlan(market, [...values].reverse()));
  });

  it('reports opposite active directions without creating an internal crossing', () => {
    const sell = intent({
      intentId: 'sell',
      strategyId: 'strategy-b',
      acceptedSequence: 2n,
      targetBaseAtoms: 10n,
      ownedBaseAtoms: 30n,
      availableBaseAtoms: 30n,
      maxBuyPriceAtoms: null,
      minSellPriceAtoms: 1_900_000n,
    });
    expect(previewPlan(market, [intent(), sell])).toMatchObject({
      kind: 'CONFLICT',
      buyIntentIds: ['intent-a'],
      sellIntentIds: ['sell'],
    });
  });

  it('excludes stale and deferred rows before opposite-direction evaluation', () => {
    const staleSell = intent({
      intentId: 'stale-sell',
      strategyId: 'strategy-b',
      acceptedSequence: 2n,
      targetBaseAtoms: 0n,
      ownedBaseAtoms: 30n,
      availableBaseAtoms: 30n,
      maxBuyPriceAtoms: null,
      minSellPriceAtoms: 1_900_000n,
      expiresAtMs: 999n,
    });
    expect(previewPlan(market, [intent(), staleSell])).toMatchObject({
      kind: 'ORDER',
      side: 'BUY',
    });
  });

  it('rounds aggregate quantity down and leaves the exact FIFO residual visible', () => {
    const result = previewPlan(market, [intent({ targetBaseAtoms: 12n })]);
    expect(result).toMatchObject({ kind: 'ORDER', grossBaseAtoms: 10n });
    expect(result.kind === 'ORDER' ? result.allocations[0]?.residualBaseAtoms : null).toBe(2n);
  });

  it('refuses a child below minimum notional', () => {
    expect(previewPlan({ ...market, minNotionalQuoteAtoms: 1_000_000n }, [intent()])).toMatchObject(
      { kind: 'NO_ORDER', exclusions: [{ reason: 'PLAN_EXCHANGE_FILTER_UNSATISFIED' }] },
    );
  });

  it('does not let another strategy fund a FIFO allocation', () => {
    const unfunded = intent({ availableQuoteAtoms: 1n, maxQuoteDebitAtoms: 1n });
    const funded = intent({
      intentId: 'intent-b',
      strategyId: 'strategy-b',
      acceptedSequence: 2n,
      availableQuoteAtoms: 9_000_000n,
      maxQuoteDebitAtoms: 9_000_000n,
    });
    expect(previewPlan(market, [unfunded, funded])).toMatchObject({ kind: 'NO_ORDER' });
  });

  it('constrains SELL gross quantity by owned base plus supported base commission', () => {
    const sell = intent({
      targetBaseAtoms: 0n,
      ownedBaseAtoms: 22n,
      availableBaseAtoms: 22n,
      maxBuyPriceAtoms: null,
      minSellPriceAtoms: 1_900_001n,
      worstBaseCommissionAtoms: 2n,
    });
    expect(previewPlan(market, [sell])).toMatchObject({
      kind: 'ORDER',
      side: 'SELL',
      limitPriceAtoms: 1_900_100n,
      grossBaseAtoms: 20n,
    });
  });
});
