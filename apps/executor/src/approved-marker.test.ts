import { describe, expect, it } from 'vitest';
import { assertOrderMatchesSealedPlan, type ExecutableOrder } from './approved-marker.js';

const plan = {
  childClientOrderId: 'cd-plan-1',
  symbol: 'BTCUSDT',
  side: 'BUY',
  orderType: 'LIMIT',
  timeInForce: 'IOC',
  grossBaseQuantity: { asset: 'BTC@v1', atoms: '2500000' },
  limitPrice: { base: 'BTC@v1', quote: 'USDT@v1', value: '63125.50' },
  approvalExpiresAt: '2026-09-08T10:01:00.000Z',
  submissionDeadlineAt: '2026-09-08T10:00:00.000Z',
  signedRequestValidityMs: '5000',
  clockSkewBudgetMs: '100',
};

const order: ExecutableOrder = {
  symbol: 'BTCUSDT',
  side: 'BUY',
  quantity: '0.02500000',
  quantityAtoms: '2500000',
  price: '63125.50',
  clientOrderId: 'cd-plan-1',
};

describe('approval-bound marker material', () => {
  it('accepts an order only when every venue field matches the sealed authority', () => {
    expect(assertOrderMatchesSealedPlan(plan, order)).toEqual({
      approvalExpiresAt: '2026-09-08T10:01:00.000Z',
      submissionDeadlineAt: '2026-09-08T10:00:00.000Z',
      signedRequestValidityMs: 5000,
      clockSkewBudgetMs: 100,
    });
  });

  it.each([
    ['symbol', { symbol: 'ETHUSDT' }],
    ['side', { side: 'SELL' }],
    ['source atoms', { quantityAtoms: '2499999' }],
    ['price', { price: '63125.51' }],
    ['client order id', { clientOrderId: 'cd-plan-2' }],
  ])('refuses a changed %s', (_name, change) => {
    expect(() =>
      assertOrderMatchesSealedPlan(plan, { ...order, ...change } as ExecutableOrder),
    ).toThrow(/differs from the sealed plan/);
  });

  it('refuses lossy or noncanonical timing values', () => {
    expect(() =>
      assertOrderMatchesSealedPlan({ ...plan, signedRequestValidityMs: 5000 }, order),
    ).toThrow(/must be a string/);
  });
});
