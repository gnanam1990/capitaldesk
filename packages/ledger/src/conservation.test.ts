import { describe, expect, it } from 'vitest';
import { verifyConservation, type AssetPosition } from './conservation.js';

/**
 * The acceptance gate for this module (T-012, prompt 06 task 5).
 *
 * For each asset, the units the account controls equal the units its owners claim. This is
 * recomputed here from the positions a caller read, independently of whatever projection
 * produced them — the point is to disagree with a wrong projection, not to restate it.
 *
 * A balancing plug is a test failure, so there is no "adjustment" term anywhere below.
 */
function position(overrides: Partial<AssetPosition> = {}): AssetPosition {
  return {
    asset: { code: 'USDT', scaleVersion: 'v1' },
    controlAtoms: 1_000n,
    claims: [{ owner: 'HOUSE', availableAtoms: 1_000n, reservedAtoms: 0n, quarantinedAtoms: 0n }],
    ...overrides,
  };
}

describe('per-asset conservation', () => {
  it('holds when control equals the sum of every claim partition', () => {
    const result = verifyConservation([position()]);
    expect(result.conserved).toBe(true);
    expect(result.discrepancies).toEqual([]);
  });

  it('sums AVAILABLE, RESERVED and QUARANTINED across every owner', () => {
    // The partitions are not separate assets; they are one asset's units in three states.
    const result = verifyConservation([
      position({
        controlAtoms: 1_000n,
        claims: [
          { owner: 'HOUSE', availableAtoms: 100n, reservedAtoms: 0n, quarantinedAtoms: 50n },
          { owner: 'strategy-a', availableAtoms: 300n, reservedAtoms: 200n, quarantinedAtoms: 0n },
          { owner: 'strategy-b', availableAtoms: 350n, reservedAtoms: 0n, quarantinedAtoms: 0n },
        ],
      }),
    ]);
    expect(result.conserved).toBe(true);
  });

  it('reports the exact shortfall when claims fall short of control', () => {
    // Units the account holds that nobody claims: the "unassigned inventory" this module
    // exists to make impossible.
    const result = verifyConservation([position({ controlAtoms: 1_500n })]);
    expect(result.discrepancies).toEqual([
      { asset: 'USDT@v1', controlAtoms: 1_500n, claimedAtoms: 1_000n, differenceAtoms: 500n },
    ]);
    expect(result.conserved).toBe(false);
  });

  it('reports the exact excess when claims exceed control', () => {
    // Claims on units the account does not hold, which is the direction that pays somebody
    // twice.
    const result = verifyConservation([position({ controlAtoms: 900n })]);
    expect(result.discrepancies[0]?.differenceAtoms).toBe(-100n);
  });

  it('never balances one asset against another', () => {
    // A BTC surplus does not excuse a USDT shortfall. Each asset is judged alone, and both
    // appear.
    const result = verifyConservation([
      position({ asset: { code: 'USDT', scaleVersion: 'v1' }, controlAtoms: 900n }),
      position({
        asset: { code: 'BTC', scaleVersion: 'v1' },
        controlAtoms: 1_100n,
        claims: [
          { owner: 'HOUSE', availableAtoms: 1_000n, reservedAtoms: 0n, quarantinedAtoms: 0n },
        ],
      }),
    ]);
    expect(result.conserved).toBe(false);
    expect(result.discrepancies.map((d) => d.asset)).toEqual(['BTC@v1', 'USDT@v1']);
  });

  it('treats the same code at a different scale as a different asset', () => {
    const result = verifyConservation([
      position({ asset: { code: 'USDT', scaleVersion: 'v1' } }),
      position({ asset: { code: 'USDT', scaleVersion: 'v2' }, controlAtoms: 7n }),
    ]);
    expect(result.discrepancies.map((d) => d.asset)).toEqual(['USDT@v2']);
  });

  it('holds for an asset with no control and no claims', () => {
    const result = verifyConservation([position({ controlAtoms: 0n, claims: [] })]);
    expect(result.conserved).toBe(true);
  });

  it('reports a claim with no control at all', () => {
    const result = verifyConservation([position({ controlAtoms: 0n })]);
    expect(result.discrepancies[0]?.differenceAtoms).toBe(-1_000n);
  });

  it('refuses a negative claim partition, which is never a legitimate state', () => {
    // INV-03. A negative claim would otherwise cancel a positive one and let the sum agree.
    const result = verifyConservation([
      position({
        controlAtoms: 500n,
        claims: [
          { owner: 'HOUSE', availableAtoms: 1_000n, reservedAtoms: 0n, quarantinedAtoms: 0n },
          { owner: 'strategy-a', availableAtoms: -500n, reservedAtoms: 0n, quarantinedAtoms: 0n },
        ],
      }),
    ]);
    expect(result.conserved).toBe(false);
    expect(result.negativeClaims).toEqual([
      { asset: 'USDT@v1', owner: 'strategy-a', partition: 'AVAILABLE', atoms: -500n },
    ]);
  });

  it('refuses negative control, and names it separately from a claim discrepancy', () => {
    const result = verifyConservation([position({ controlAtoms: -1n, claims: [] })]);
    expect(result.conserved).toBe(false);
    expect(result.negativeControl).toEqual(['USDT@v1']);
  });

  it('orders discrepancies by asset, so two runs compare', () => {
    const result = verifyConservation([
      position({ asset: { code: 'ZRX', scaleVersion: 'v1' }, controlAtoms: 1n }),
      position({ asset: { code: 'AAA', scaleVersion: 'v1' }, controlAtoms: 1n }),
    ]);
    expect(result.discrepancies.map((d) => d.asset)).toEqual(['AAA@v1', 'ZRX@v1']);
  });
});
