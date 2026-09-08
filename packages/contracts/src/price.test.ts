import { describe, expect, it } from 'vitest';
import { MAX_ATOMS, amount, assetKey } from './money.js';
import {
  comparePrices,
  formatPrice,
  priceFromDecimal,
  quoteAmountForBase,
  quoteAtomsForBase,
} from './price.js';

const BTC = assetKey('BTC', 'binance-spot-2026-09-08');
const USDT = assetKey('USDT', 'binance-spot-2026-09-08');

const BTC_SCALE = 8;
const USDT_SCALE = 8;
const p20000 = priceFromDecimal(BTC, USDT, '20000');
const p19900 = priceFromDecimal(BTC, USDT, '19900');

describe('price', () => {
  it('parses and reformats exact decimals without binary floating point', () => {
    expect(formatPrice(priceFromDecimal(BTC, USDT, '19900.55'))).toBe('19900.55');
    expect(formatPrice(priceFromDecimal(BTC, USDT, '0.00000001'))).toBe('0.00000001');
    // 0.1 + 0.2 is exact here because nothing is ever a JavaScript number.
    expect(formatPrice(priceFromDecimal(BTC, USDT, '0.3'))).toBe('0.3');
  });

  it('compares prices of the same pair across different exponents', () => {
    expect(
      comparePrices(priceFromDecimal(BTC, USDT, '20000'), priceFromDecimal(BTC, USDT, '20000.00')),
    ).toBe(0);
    expect(comparePrices(p19900, p20000)).toBe(-1);
  });

  it('converts base atoms to quote atoms exactly for the reviewed golden example', () => {
    // 0.02 BTC filled at 19900 => 398 USDT gross quote, exactly.
    const filled = amount(BTC, 2_000_000n); // 0.02 BTC at scale 8
    const gross = quoteAmountForBase(p19900, filled, BTC_SCALE, USDT_SCALE, 'EXACT');
    expect(gross.atoms).toBe(39_800_000_000n); // 398.00000000 USDT
    expect(gross.asset.code).toBe('USDT');
  });

  it('requires an explicit rounding direction when a conversion is inexact', () => {
    const odd = priceFromDecimal(BTC, USDT, '19900.000000005');
    expect(() => quoteAtomsForBase(odd, 1n, BTC_SCALE, USDT_SCALE, 'EXACT')).toThrow(
      /MONEY_INEXACT_CONVERSION/,
    );
    const floor = quoteAtomsForBase(odd, 1n, BTC_SCALE, USDT_SCALE, 'FLOOR');
    const ceil = quoteAtomsForBase(odd, 1n, BTC_SCALE, USDT_SCALE, 'CEIL');
    expect(ceil - floor).toBe(1n);
  });

  it('refuses a quantity whose asset is not the price base asset', () => {
    expect(() =>
      quoteAmountForBase(p20000, amount(USDT, 1n), BTC_SCALE, USDT_SCALE, 'EXACT'),
    ).toThrow(/MONEY_ASSET_MISMATCH/);
  });

  // --- regression: maintainer draft review, unbound accounting scales -------------------
  // A negative accounting scale silently multiplied where the caller expected a division:
  // quoteAtomsForBase(p20000, 1n, -1, 0, 'EXACT') returned 200000 instead of being refused.
  describe('accounting scales (regression: draft review)', () => {
    it('refuses a negative base scale', () => {
      expect(() => quoteAtomsForBase(p20000, 1n, -1, 0, 'EXACT')).toThrow(
        /baseScale must be an integer number of decimal places/,
      );
    });

    it('refuses a negative quote scale', () => {
      expect(() => quoteAtomsForBase(p20000, 1n, 8, -1, 'EXACT')).toThrow(
        /quoteScale must be an integer number of decimal places/,
      );
    });

    it('refuses non-integer and non-finite scales', () => {
      for (const scale of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
        expect(() => quoteAtomsForBase(p20000, 1n, scale, 8, 'EXACT'), String(scale)).toThrow(
          /MONEY_PRECISION_EXCEEDED/,
        );
      }
    });

    it('refuses a scale beyond the supported asset precision', () => {
      expect(() => quoteAtomsForBase(p20000, 1n, 31, 8, 'EXACT')).toThrow(
        /MONEY_PRECISION_EXCEEDED/,
      );
    });
  });

  // --- regression: maintainer draft review, unbounded conversion magnitude --------------
  // The raw helper returned an 82-digit result for baseAtoms = 10^77 while the monetary
  // bound is 78 digits, producing a quantity no other money function would accept.
  describe('conversion magnitude bound (regression: draft review)', () => {
    it('refuses a base quantity above the supported precision', () => {
      expect(() =>
        quoteAtomsForBase(p20000, MAX_ATOMS + 1n, BTC_SCALE, USDT_SCALE, 'FLOOR'),
      ).toThrow(/base atoms exceed 78 digits/);
    });

    it('refuses a conversion whose result would exceed the supported precision', () => {
      // 10^77 base atoms times 20000 is an 82-digit quote quantity.
      expect(() => quoteAtomsForBase(p20000, 10n ** 77n, BTC_SCALE, USDT_SCALE, 'FLOOR')).toThrow(
        /converted quote quantity exceeds 78 digits/,
      );
    });

    it('still converts a large but representable quantity exactly', () => {
      const result = quoteAtomsForBase(p20000, 10n ** 60n, BTC_SCALE, USDT_SCALE, 'EXACT');
      expect(result).toBe(2n * 10n ** 64n);
      expect(result).toBeLessThanOrEqual(MAX_ATOMS);
    });
  });
});
