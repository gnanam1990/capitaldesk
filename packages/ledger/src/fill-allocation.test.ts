import { describe, expect, it } from 'vitest';
import { allocateCompleteFills } from './fill-allocation.js';

const BTC = { code: 'BTC', scaleVersion: 'v1' } as const;
const USDT = { code: 'USDT', scaleVersion: 'v1' } as const;

const approval = (
  strategyId: string,
  intentId: string,
  requestedGrossBaseAtoms: bigint,
  maxQuoteDebitAtoms: bigint,
) => ({
  strategyId,
  intentId,
  requestedGrossBaseAtoms,
  maxQuoteDebitAtoms,
  maxBaseDebitAtoms: requestedGrossBaseAtoms + 1_000_000n,
  maxBaseCommissionAtoms: 1_000_000n,
  maxQuoteCommissionAtoms: 1_000_000n,
});

describe('complete fill allocation', () => {
  it('reproduces the 500/500 golden partial fill without synthetic remainder', () => {
    const result = allocateCompleteFills({
      side: 'BUY',
      baseAsset: BTC,
      quoteAsset: USDT,
      fifo: [
        approval('strategy-a', 'intent-a', 1_000_000n, 200_200_000n),
        approval('strategy-b', 'intent-b', 2_000_000n, 400_400_000n),
      ],
      fills: [
        {
          tradeId: 'trade-1',
          baseAtoms: 2_000_000n,
          quoteAtoms: 398_000_000n,
          commissionAsset: USDT,
          commissionAtoms: 398_000n,
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      algorithm: 'fifo-circulation-v1',
      cells: [
        {
          tradeId: 'trade-1',
          strategyId: 'strategy-a',
          intentId: 'intent-a',
          grossBaseAtoms: 1_000_000n,
          grossQuoteAtoms: 199_000_000n,
          commissionAsset: USDT,
          commissionAtoms: 199_000n,
        },
        {
          tradeId: 'trade-1',
          strategyId: 'strategy-b',
          intentId: 'intent-b',
          grossBaseAtoms: 1_000_000n,
          grossQuoteAtoms: 199_000_000n,
          commissionAsset: USDT,
          commissionAtoms: 199_000n,
        },
      ],
    });
  });

  it('freezes FIFO across prices and conserves every source row', () => {
    const fills = [
      {
        tradeId: '01',
        baseAtoms: 3n,
        quoteAtoms: 8n,
        commissionAsset: USDT,
        commissionAtoms: 3n,
      },
      {
        tradeId: '02',
        baseAtoms: 3n,
        quoteAtoms: 3n,
        commissionAsset: USDT,
        commissionAtoms: 3n,
      },
    ];
    const result = allocateCompleteFills({
      side: 'BUY',
      baseAsset: BTC,
      quoteAsset: USDT,
      fifo: [approval('a', 'ia', 4n, 20n), approval('b', 'ib', 4n, 20n)],
      fills,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.cells.filter((cell) => cell.tradeId === '01').map((cell) => cell.grossBaseAtoms),
    ).toEqual([3n]);
    expect(
      result.cells.filter((cell) => cell.tradeId === '02').map((cell) => cell.grossBaseAtoms),
    ).toEqual([1n, 2n]);
    for (const fill of fills) {
      const cells = result.cells.filter((cell) => cell.tradeId === fill.tradeId);
      expect(cells.reduce((sum, cell) => sum + cell.grossBaseAtoms, 0n)).toBe(fill.baseAtoms);
      expect(cells.reduce((sum, cell) => sum + cell.grossQuoteAtoms, 0n)).toBe(fill.quoteAtoms);
      expect(cells.reduce((sum, cell) => sum + cell.commissionAtoms, 0n)).toBe(
        fill.commissionAtoms,
      );
    }
  });

  it('enforces the combined BUY quote cost and commission cap', () => {
    const result = allocateCompleteFills({
      side: 'BUY',
      baseAsset: BTC,
      quoteAsset: USDT,
      fifo: [
        { ...approval('a', 'ia', 1n, 1n), maxQuoteCommissionAtoms: 1n },
        { ...approval('b', 'ib', 1n, 3n), maxQuoteCommissionAtoms: 1n },
      ],
      fills: [
        {
          tradeId: '1',
          baseAtoms: 2n,
          quoteAtoms: 3n,
          commissionAsset: USDT,
          commissionAtoms: 1n,
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      reason: 'ALLOCATION_INFEASIBLE',
      detail: 'integer circulation infeasible for USDT:v1:DEBIT',
    });
  });

  it('preserves unsupported third-asset fees as an allocation refusal', () => {
    const result = allocateCompleteFills({
      side: 'BUY',
      baseAsset: BTC,
      quoteAsset: USDT,
      fifo: [approval('a', 'ia', 1n, 10n)],
      fills: [
        {
          tradeId: '1',
          baseAtoms: 1n,
          quoteAtoms: 2n,
          commissionAsset: { code: 'BNB', scaleVersion: 'v1' },
          commissionAtoms: 1n,
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, reason: 'FEE_ASSET_UNSUPPORTED' });
  });

  it('uses the SELL posting quantities and refuses base fees beyond approved debit', () => {
    const result = allocateCompleteFills({
      side: 'SELL',
      baseAsset: BTC,
      quoteAsset: USDT,
      fifo: [
        {
          ...approval('a', 'ia', 10n, 0n),
          maxBaseDebitAtoms: 10n,
          maxBaseCommissionAtoms: 2n,
        },
      ],
      fills: [
        {
          tradeId: '1',
          baseAtoms: 10n,
          quoteAtoms: 100n,
          commissionAsset: BTC,
          commissionAtoms: 1n,
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, reason: 'ALLOCATION_INFEASIBLE' });
  });
});
