import { describe, expect, it } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import { openingFromSnapshot } from './snapshot.js';
import { supportedAssets } from './assets.js';

/**
 * The opening position is derived from the closing snapshot, never supplied alongside it.
 *
 * A caller that names a cut and then states its own balances can state anything: the shipped
 * service accepted an opening of 1000 against a snapshot holding nothing. The snapshot is the
 * evidence; the opening is a function of it.
 */
const SUPPORTED = supportedAssets({
  base: { code: 'BTC', scaleVersion: 'v1' },
  quote: { code: 'USDT', scaleVersion: 'v1' },
  feeAssets: [],
});

describe('deriving the opening from a closing snapshot', () => {
  it('sums free and locked exactly, per asset', () => {
    // Total holdings, not spendable holdings: locked units are still owned, and an opening
    // that ignored them would credit HOUSE less than the account holds.
    expect(
      openingFromSnapshot(
        [
          { asset: 'USDT@v1', freeAtoms: '900', lockedAtoms: '100' },
          { asset: 'BTC@v1', freeAtoms: '50000000', lockedAtoms: '0' },
        ],
        SUPPORTED,
      ),
    ).toEqual([
      { asset: { code: 'BTC', scaleVersion: 'v1' }, atoms: 50_000_000n },
      { asset: { code: 'USDT', scaleVersion: 'v1' }, atoms: 1_000n },
    ]);
  });

  it('is ordered deterministically, so two derivations compare', () => {
    const one = openingFromSnapshot(
      [
        { asset: 'USDT@v1', freeAtoms: '1', lockedAtoms: '0' },
        { asset: 'BTC@v1', freeAtoms: '2', lockedAtoms: '0' },
      ],
      SUPPORTED,
    );
    const other = openingFromSnapshot(
      [
        { asset: 'BTC@v1', freeAtoms: '2', lockedAtoms: '0' },
        { asset: 'USDT@v1', freeAtoms: '1', lockedAtoms: '0' },
      ],
      SUPPORTED,
    );
    expect(one).toEqual(other);
  });

  it('drops an asset holding nothing, because a zero entry is not a posting', () => {
    expect(
      openingFromSnapshot([{ asset: 'USDT@v1', freeAtoms: '0', lockedAtoms: '0' }], SUPPORTED),
    ).toEqual([]);
  });

  it('derives an empty opening from an empty snapshot', () => {
    expect(openingFromSnapshot([], SUPPORTED)).toEqual([]);
  });

  describe('it refuses rather than normalising', () => {
    it('refuses a negative free or locked amount', () => {
      for (const balance of [
        { asset: 'USDT@v1', freeAtoms: '-1', lockedAtoms: '0' },
        { asset: 'USDT@v1', freeAtoms: '0', lockedAtoms: '-1' },
      ]) {
        expect(() => openingFromSnapshot([balance], SUPPORTED), JSON.stringify(balance)).toThrow(
          /negative/,
        );
      }
    });

    it('refuses an amount that is not a canonical integer', () => {
      for (const atoms of ['', ' ', '1.5', '1e3', '0x10', 'NaN', 'Infinity', '007', '+1']) {
        expect(
          () =>
            openingFromSnapshot(
              [{ asset: 'USDT@v1', freeAtoms: atoms, lockedAtoms: '0' }],
              SUPPORTED,
            ),
          JSON.stringify(atoms),
        ).toThrow(ContractViolation);
      }
    });

    it('accepts a canonical zero and a large exact integer', () => {
      // The positive control for the shape rule.
      expect(
        openingFromSnapshot(
          [{ asset: 'USDT@v1', freeAtoms: '0', lockedAtoms: '12345678901234567890' }],
          SUPPORTED,
        ),
      ).toEqual([
        { asset: { code: 'USDT', scaleVersion: 'v1' }, atoms: 12_345_678_901_234_567_890n },
      ]);
    });

    it('refuses a duplicate asset rather than summing it twice', () => {
      // Two rows for one asset is a contradiction in the source; adding them would silently
      // double the opening.
      try {
        openingFromSnapshot(
          [
            { asset: 'USDT@v1', freeAtoms: '100', lockedAtoms: '0' },
            { asset: 'USDT@v1', freeAtoms: '900', lockedAtoms: '0' },
          ],
          SUPPORTED,
        );
        expect.unreachable('a duplicate asset must be refused');
      } catch (error) {
        expect((error as ContractViolation).reason).toBe('EVIDENCE_CONTRADICTORY');
        expect((error as ContractViolation).message).toContain('lists an asset twice');
        expect((error as ContractViolation).detail['asset']).toBe('USDT@v1');
      }
    });

    it('refuses an asset this pool does not support', () => {
      try {
        openingFromSnapshot([{ asset: 'DOGE@v1', freeAtoms: '1', lockedAtoms: '0' }], SUPPORTED);
        expect.unreachable('an unsupported asset must be refused');
      } catch (error) {
        expect((error as ContractViolation).reason).toBe('FEE_ASSET_UNSUPPORTED');
        expect((error as ContractViolation).detail['asset']).toBe('DOGE@v1');
      }
    });

    it('refuses a supported code at an unknown scale', () => {
      expect(() =>
        openingFromSnapshot([{ asset: 'USDT@v9', freeAtoms: '1', lockedAtoms: '0' }], SUPPORTED),
      ).toThrow(ContractViolation);
    });

    it('refuses a malformed asset key', () => {
      for (const asset of ['USDT', '@v1', 'USDT@', '', 'USDT@v1@v2']) {
        expect(
          () => openingFromSnapshot([{ asset, freeAtoms: '1', lockedAtoms: '0' }], SUPPORTED),
          JSON.stringify(asset),
        ).toThrow(ContractViolation);
      }
    });

    it('refuses a row missing a field, rather than reading it as zero', () => {
      expect(() =>
        openingFromSnapshot([{ asset: 'USDT@v1', freeAtoms: '1' } as unknown as never], SUPPORTED),
      ).toThrow(ContractViolation);
    });
  });
});
