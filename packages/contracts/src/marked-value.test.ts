import { describe, expect, it } from 'vitest';
import { markedValue } from './marked-value.js';
import { MAX_ATOMS, assetKey } from './money.js';

const USDT = assetKey('USDT', 'binance-spot-2026-09-08');

const valid = {
  quote: USDT,
  estimatedAtoms: 1_000n,
  priceSource: 'binance-spot-ticker',
  observedAt: '2026-09-08T10:00:00.000Z',
  freshness: 'FRESH' as const,
};

describe('marked value', () => {
  it('builds a valid estimate', () => {
    const value = markedValue(valid);
    expect(value.kind).toBe('MarkedValue');
    expect(value.estimatedAtoms).toBe(1_000n);
  });

  // --- regression: PR 1 review, the discriminator was overridable -----------------------
  // `kind` came before the spread, so a caller could hand back an object that lied about its
  // own runtime variant — the one property that keeps marked value structurally distinct
  // from spendable money.
  it('cannot have its discriminator overridden through the initialiser', () => {
    const smuggled = markedValue({ ...valid, kind: 'AssetAmount' } as never);
    expect(smuggled.kind).toBe('MarkedValue');
  });

  // --- regression: PR 1 review, the documented contract was not enforced -----------------
  describe('rejects values that contradict its own contract', () => {
    it('rejects a negative estimate', () => {
      expect(() => markedValue({ ...valid, estimatedAtoms: -1n })).toThrow(/MONEY_NEGATIVE_RESULT/);
    });

    it('rejects an estimate beyond the supported precision', () => {
      expect(() => markedValue({ ...valid, estimatedAtoms: MAX_ATOMS + 1n })).toThrow(
        /MONEY_PRECISION_EXCEEDED/,
      );
    });

    it('accepts zero and the maximum representable estimate', () => {
      expect(markedValue({ ...valid, estimatedAtoms: 0n }).estimatedAtoms).toBe(0n);
      expect(markedValue({ ...valid, estimatedAtoms: MAX_ATOMS }).estimatedAtoms).toBe(MAX_ATOMS);
    });

    it('rejects an unparseable observation time', () => {
      expect(() => markedValue({ ...valid, observedAt: 'nonsense' })).toThrow(/EVIDENCE_STALE/);
    });

    it('rejects an impossible calendar day', () => {
      expect(() => markedValue({ ...valid, observedAt: '2026-02-30T10:00:00.000Z' })).toThrow(
        /EVIDENCE_STALE/,
      );
      expect(() => markedValue({ ...valid, observedAt: '2026-02-29T10:00:00.000Z' })).toThrow(
        /EVIDENCE_STALE/,
      );
    });

    it('rejects a timezone-less observation time', () => {
      expect(() => markedValue({ ...valid, observedAt: '2026-09-08T10:00:00' })).toThrow(
        /EVIDENCE_STALE/,
      );
    });

    it('rejects an unnamed price source', () => {
      // A freshness classification means nothing without knowing what produced the estimate.
      expect(() => markedValue({ ...valid, priceSource: '' })).toThrow(
        /must name its price source/,
      );
    });
  });

  it('carries its freshness classification through unchanged', () => {
    for (const freshness of ['FRESH', 'STALE', 'UNKNOWN'] as const) {
      expect(markedValue({ ...valid, freshness }).freshness).toBe(freshness);
    }
  });
});
