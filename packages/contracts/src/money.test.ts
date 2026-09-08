import { describe, expect, it } from 'vitest';
import { ContractViolation } from './errors.js';
import {
  MAX_ATOMS,
  MAX_ATOM_DIGITS,
  addAmounts,
  amount,
  assetKey,
  compareAmounts,
  decodeAmount,
  encodeAmount,
  parseAtoms,
  subtractAmounts,
  sumAmounts,
} from './money.js';

const USDT = assetKey('USDT', 'binance-spot-2026-09-08');
const BTC = assetKey('BTC', 'binance-spot-2026-09-08');
const USDT_RESCALED = assetKey('USDT', 'binance-spot-2027-01-01');

describe('money', () => {
  it('adds and subtracts within one asset exactly', () => {
    expect(addAmounts(amount(USDT, 199_199n), amount(USDT, 801n)).atoms).toBe(200_000n);
    expect(subtractAmounts(amount(USDT, 500n), amount(USDT, 199n)).atoms).toBe(301n);
  });

  it('refuses arithmetic across different assets', () => {
    expect(() => addAmounts(amount(USDT, 1n), amount(BTC, 1n))).toThrow(/MONEY_ASSET_MISMATCH/);
    expect(() => compareAmounts(amount(USDT, 1n), amount(BTC, 1n))).toThrow(/MONEY_ASSET_MISMATCH/);
  });

  it('treats the same venue code under a different verified scale as a different asset', () => {
    expect(() => addAmounts(amount(USDT, 1n), amount(USDT_RESCALED, 1n))).toThrow(
      /MONEY_ASSET_MISMATCH/,
    );
  });

  it('refuses a subtraction that would produce a negative claim', () => {
    expect(() => subtractAmounts(amount(USDT, 1n), amount(USDT, 2n))).toThrow(
      /MONEY_NEGATIVE_RESULT/,
    );
  });

  it('round-trips through the wire encoding without loss', () => {
    const value = amount(USDT, 123_456_789_012_345_678_901_234_567_890n);
    expect(decodeAmount(encodeAmount(value)).atoms).toBe(value.atoms);
    expect(encodeAmount(value).asset).toBe('USDT@binance-spot-2026-09-08');
  });

  it('sums an empty list to a typed zero rather than a bare 0', () => {
    const total = sumAmounts(USDT, []);
    expect(total.atoms).toBe(0n);
    expect(total.asset.code).toBe('USDT');
  });

  describe('atom string parsing', () => {
    it('accepts canonical nonnegative integers only', () => {
      expect(parseAtoms('0')).toBe(0n);
      expect(parseAtoms('1000')).toBe(1000n);
    });

    it('refuses leading zeros, signs, decimals and exponents', () => {
      for (const text of ['00', '01', '-1', '+1', '1.0', '1e3', '', ' 1', '0x10']) {
        expect(() => parseAtoms(text), text).toThrow(ContractViolation);
      }
    });

    // --- regression: maintainer draft review, oversized input ---------------------------
    // The length bound is now checked before BigInt parsing, so the cost of rejecting an
    // oversized caller-supplied digit string does not grow with its length.
    it('refuses an oversized atom string before parsing it', () => {
      const oversized = '9'.repeat(MAX_ATOM_DIGITS + 1);
      expect(() => parseAtoms(oversized)).toThrow(/exceeds 78 digits/);
    });

    it('refuses a pathologically long digit string quickly', () => {
      const huge = '9'.repeat(2_000_000);
      const startedAt = process.hrtime.bigint();
      expect(() => parseAtoms(huge)).toThrow(/exceeds 78 digits/);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // A pre-parse length check is O(1). Parsing two million digits first would not be.
      expect(elapsedMs).toBeLessThan(50);
    });

    it('accepts exactly the maximum supported precision and refuses one more atom', () => {
      expect(parseAtoms(MAX_ATOMS.toString())).toBe(MAX_ATOMS);
      expect(() => amount(USDT, MAX_ATOMS + 1n)).toThrow(/MONEY_PRECISION_EXCEEDED/);
    });
  });
});
