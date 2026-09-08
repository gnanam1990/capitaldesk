import { describe, expect, it } from 'vitest';
import {
  assertOrderedInterval,
  covers,
  isStrictUtcInstant,
  parseStrictUtcInstant,
  strictUtcMs,
} from './time.js';

/**
 * One strict parser replaced scattered `Date.parse` calls that accepted two different kinds
 * of wrong instant: a timezone-less string resolved in the host's local zone, and an
 * impossible calendar day silently normalised into a different date.
 */
describe('strict UTC instants', () => {
  it('accepts a real instant with and without milliseconds', () => {
    expect(isStrictUtcInstant('2026-09-08T10:00:00.000Z')).toBe(true);
    expect(isStrictUtcInstant('2026-09-08T10:00:00Z')).toBe(true);
    expect(isStrictUtcInstant('2026-09-08T10:00:00.5Z')).toBe(true);
  });

  // --- regression: PR 1 review, host-local interpretation -------------------------------
  // Reproduced under two host timezones: the same timezone-less deadline was accepted under
  // TZ=UTC and rejected under TZ=Asia/Kolkata, so two executors derived different deadlines
  // from one approval.
  it('refuses a timezone-less instant regardless of host timezone', () => {
    expect(isStrictUtcInstant('2026-09-08T10:00:00')).toBe(false);
    expect(isStrictUtcInstant('2026-09-08T10:00:00.000')).toBe(false);
    expect(isStrictUtcInstant('2026-09-08T10:00:00+05:30')).toBe(false);
    expect(isStrictUtcInstant('2026-09-08')).toBe(false);
  });

  // --- regression: PR 1 review, impossible dates normalised -----------------------------
  describe('impossible calendar days are refused, not normalised', () => {
    it('refuses 30 February', () => {
      expect(isStrictUtcInstant('2026-02-30T12:00:00.000Z')).toBe(false);
    });

    it('refuses 29 February in a non-leap year', () => {
      expect(isStrictUtcInstant('2026-02-29T00:00:00Z')).toBe(false);
      expect(isStrictUtcInstant('2100-02-29T00:00:00Z')).toBe(false);
    });

    it('accepts 29 February in a leap year', () => {
      expect(isStrictUtcInstant('2024-02-29T00:00:00Z')).toBe(true);
      expect(isStrictUtcInstant('2000-02-29T00:00:00Z')).toBe(true);
    });

    it('refuses a 31st in a 30-day month', () => {
      expect(isStrictUtcInstant('2026-09-31T00:00:00Z')).toBe(false);
      expect(isStrictUtcInstant('2026-04-31T00:00:00Z')).toBe(false);
    });

    it('refuses out-of-range months, hours, minutes and seconds', () => {
      for (const text of [
        '2026-13-01T00:00:00Z',
        '2026-00-01T00:00:00Z',
        '2026-09-00T00:00:00Z',
        '2026-09-08T24:00:00Z',
        '2026-09-08T10:60:00Z',
        '2026-09-08T10:00:61Z',
      ]) {
        expect(isStrictUtcInstant(text), text).toBe(false);
      }
    });

    it('accepts the boundaries either side of a month end', () => {
      expect(isStrictUtcInstant('2026-09-30T23:59:59.999Z')).toBe(true);
      expect(isStrictUtcInstant('2026-10-01T00:00:00.000Z')).toBe(true);
    });

    it('accepts a leap second boundary as the following second, not 61', () => {
      expect(isStrictUtcInstant('2026-12-31T23:59:59Z')).toBe(true);
      expect(isStrictUtcInstant('2026-12-31T23:59:60Z')).toBe(false);
    });
  });

  it('names the field it refused', () => {
    expect(() => parseStrictUtcInstant('approvalExpiresAt', '2026-02-30T00:00:00Z')).toThrow(
      /approvalExpiresAt/,
    );
  });

  it('returns epoch milliseconds that match the UTC interpretation', () => {
    expect(strictUtcMs('t', '1970-01-01T00:00:00.000Z')).toBe(0);
    expect(strictUtcMs('t', '2026-09-08T10:00:00.000Z')).toBe(Date.UTC(2026, 8, 8, 10, 0, 0, 0));
  });

  describe('intervals', () => {
    it('accepts an ordered interval', () => {
      expect(() =>
        assertOrderedInterval('w', { from: '2026-09-08T10:00:00Z', to: '2026-09-08T11:00:00Z' }),
      ).not.toThrow();
    });

    it('refuses an empty or inverted interval', () => {
      const same = { from: '2026-09-08T10:00:00Z', to: '2026-09-08T10:00:00Z' };
      expect(() => assertOrderedInterval('w', same)).toThrow(/strictly before/);
      expect(() =>
        assertOrderedInterval('w', { from: same.to, to: '2026-09-08T09:00:00Z' }),
      ).toThrow(/strictly before/);
    });

    it('computes containment inclusively at both ends', () => {
      const outer = { from: '2026-09-08T10:00:00Z', to: '2026-09-08T11:00:00Z' };
      expect(covers(outer, outer)).toBe(true);
      expect(covers(outer, { from: '2026-09-08T10:10:00Z', to: '2026-09-08T10:20:00Z' })).toBe(
        true,
      );
      expect(covers(outer, { from: '2026-09-08T09:59:59Z', to: '2026-09-08T10:20:00Z' })).toBe(
        false,
      );
      expect(covers(outer, { from: '2026-09-08T10:10:00Z', to: '2026-09-08T11:00:01Z' })).toBe(
        false,
      );
    });
  });
});
