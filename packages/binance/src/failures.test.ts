import { describe, expect, it } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import {
  MAX_RETRY_AFTER_SECONDS,
  ReadFailure,
  deferUntil,
  isRetryable,
  parseRetryAfter,
  rateLimited,
  schemaUnrecognized,
  unavailable,
  venueRejected,
} from './failures.js';

/**
 * A failed read is a typed fact, never an empty success (prompt 05 task 3).
 *
 * The three failure classes exist because they have three different correct responses: back
 * off and retry, treat the source as degraded and preserve reservations, or quarantine an
 * unrecognised fact for an owner. Collapsing them into one error, or into `[]`, is how a
 * reconciler concludes that an account has no trades.
 */
describe('typed read failures', () => {
  it('is a ContractViolation, so one catch handles every contract failure', () => {
    const failure = unavailable('account', 'connection reset');
    expect(failure).toBeInstanceOf(ReadFailure);
    expect(failure).toBeInstanceOf(ContractViolation);
    expect(failure.reason).toBe('SOURCE_UNAVAILABLE');
  });

  it('names the endpoint that failed, in every class', () => {
    expect(unavailable('myTrades', 'timeout').detail['endpoint']).toBe('myTrades');
    expect(rateLimited('openOrders', 429, 61).detail['endpoint']).toBe('openOrders');
    expect(schemaUnrecognized('order', 'status').detail['endpoint']).toBe('order');
    expect(venueRejected('order', -2013, 'Order does not exist.').detail['endpoint']).toBe('order');
  });

  describe('rate limiting', () => {
    it('carries the status and the wait the venue asked for', () => {
      const failure = rateLimited('myTrades', 429, 61);
      expect(failure.reason).toBe('SOURCE_RATE_LIMITED');
      expect(failure.detail['status']).toBe('429');
      expect(failure.retryAfterSeconds).toBe(61);
    });

    it('distinguishes a 418 ban from a 429 warning', () => {
      // 418 is an auto-ban that scales from 2 minutes to 3 days for repeat offenders.
      // Retrying through one is how the ban lengthens.
      expect(rateLimited('account', 418, 120).detail['status']).toBe('418');
      expect(isRetryable(rateLimited('account', 429, 1))).toBe(true);
      expect(isRetryable(rateLimited('account', 418, 120))).toBe(false);
    });

    it('treats an unavailable source as retryable and a rejected request as not', () => {
      expect(isRetryable(unavailable('account', 'ECONNRESET'))).toBe(true);
      expect(isRetryable(venueRejected('order', -2013, 'Order does not exist.'))).toBe(false);
      expect(isRetryable(schemaUnrecognized('order', 'status'))).toBe(false);
    });
  });

  describe('parseRetryAfter', () => {
    it('reads the documented delay-seconds form', () => {
      expect(parseRetryAfter('61')).toBe(61);
      expect(parseRetryAfter('0')).toBe(0);
      expect(parseRetryAfter(' 120 ')).toBe(120);
    });

    it('returns null for a missing or unusable header rather than guessing zero', () => {
      // Guessing zero turns a ban into an immediate retry, which is how the ban lengthens.
      for (const value of [null, '', '   ', 'soon', '-5', '1.5', 'NaN', 'Infinity', '1e3']) {
        expect(parseRetryAfter(value), JSON.stringify(value)).toBeNull();
      }
    });

    /**
     * The venue documents IP bans that "scale in duration for repeat offenders, from 2
     * minutes to 3 days", and says Retry-After on a 418 gives the seconds until the ban is
     * over. A one-day or three-day defer is therefore a legitimate value, and discarding it
     * as absurd is the dangerous direction: null means the caller has no instruction and
     * retries early, into the ban that is lengthening because of it.
     */
    it('accepts the full documented ban range, up to three days', () => {
      expect(parseRetryAfter('3600')).toBe(3600);
      expect(parseRetryAfter('86400')).toBe(86_400);
      expect(parseRetryAfter(String(MAX_RETRY_AFTER_SECONDS))).toBe(259_200);
    });

    it('refuses only what exceeds the documented bound', () => {
      expect(MAX_RETRY_AFTER_SECONDS).toBe(3 * 24 * 60 * 60);
      expect(parseRetryAfter('259201')).toBeNull();
      expect(parseRetryAfter('999999999999999999999')).toBeNull();
    });
  });

  /**
   * A long defer is scheduled, never slept through.
   *
   * Blocking a worker for three days is not a backoff, it is an outage. The failure carries
   * an absolute instant so the caller persists it and the scheduler decides when to look
   * again; a restart then reads the instant rather than restarting a timer.
   */
  describe('deferUntil', () => {
    const NOW = new Date('2026-09-08T12:00:00.000Z');

    it('computes an absolute instant from the venue delay', () => {
      expect(deferUntil(rateLimited('account', 429, 61), NOW)).toEqual(
        new Date('2026-09-08T12:01:01.000Z'),
      );
      expect(deferUntil(rateLimited('account', 418, 259_200), NOW)).toEqual(
        new Date('2026-09-11T12:00:00.000Z'),
      );
    });

    it('falls back to a conservative floor when the venue sent no usable header', () => {
      // No instruction is not permission to retry immediately.
      const failure = rateLimited('account', 418, null);
      expect(failure.retryAfterSeconds).toBeNull();
      expect(deferUntil(failure, NOW)).toEqual(new Date('2026-09-08T12:02:00.000Z'));
      // A 429 with no header waits the shorter documented floor.
      expect(deferUntil(rateLimited('account', 429, null), NOW)).toEqual(
        new Date('2026-09-08T12:00:30.000Z'),
      );
    });

    it('refuses to compute against an invalid clock rather than producing an invalid date', () => {
      // An Invalid Date propagates silently into a persisted column and reads as "never".
      expect(() => deferUntil(rateLimited('account', 429, 61), new Date(Number.NaN))).toThrow(
        ContractViolation,
      );
    });

    /**
     * The inputs being sound does not make the result sound.
     *
     * A clock already near the ECMAScript time-value limit (8.64e15 ms) plus a legitimate
     * three-day defer lands outside it, and `new Date` answers with an Invalid Date whose
     * getTime() is NaN. Persisted, that reads as "never" — the opposite of a wait.
     */
    it('refuses a defer that would land outside representable time', () => {
      const nearLimit = new Date(8.64e15 - 1000);
      expect(Number.isNaN(nearLimit.getTime())).toBe(false);
      expect(() =>
        deferUntil(rateLimited('account', 418, MAX_RETRY_AFTER_SECONDS), nearLimit),
      ).toThrow(ContractViolation);
      expect(() =>
        deferUntil(rateLimited('account', 418, MAX_RETRY_AFTER_SECONDS), nearLimit),
      ).toThrow(/representable time/);
    });

    it('still computes a defer that only just fits, so the guard is a bound and not a ban', () => {
      // The positive control: one second inside the limit is a real instant and is returned.
      const nearLimit = new Date(8.64e15 - 2000);
      const until = deferUntil(rateLimited('account', 429, 1), nearLimit);
      expect(until).not.toBeNull();
      expect(Number.isNaN(until?.getTime() ?? Number.NaN)).toBe(false);
      expect(until?.getTime()).toBe(8.64e15 - 1000);
    });

    it('stays a real instant at the far end of the range', () => {
      const far = deferUntil(rateLimited('account', 418, MAX_RETRY_AFTER_SECONDS), NOW);
      expect(far).not.toBeNull();
      expect(Number.isFinite(far?.getTime())).toBe(true);
      expect(far?.toISOString()).toBe('2026-09-11T12:00:00.000Z');
    });

    it('is undefined for a failure class that is not a rate limit', () => {
      expect(deferUntil(unavailable('account', 'timeout'), NOW)).toBeNull();
    });
  });

  /**
   * `rateLimited` is exported, so `parseRetryAfter` is not the only route a number takes into
   * a failure. Leaving the bound in the parser alone let a caller construct a failure that
   * scheduled a retry in the past, or one whose instant was not a time at all.
   */
  describe('the defer bound holds on every route in, not just the header parser', () => {
    const NOW = new Date('2026-09-08T12:00:00.000Z');

    it('discards a negative, fractional or non-finite duration handed in directly', () => {
      for (const seconds of [-1, -0.5, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const failure = rateLimited('account', 429, seconds);
        expect(failure.retryAfterSeconds, String(seconds)).toBeNull();
        // It falls back to the conservative floor rather than scheduling in the past.
        expect(deferUntil(failure, NOW)?.getTime(), String(seconds)).toBe(NOW.getTime() + 30_000);
      }
    });

    it('discards a duration above the documented ban bound handed in directly', () => {
      expect(rateLimited('account', 418, MAX_RETRY_AFTER_SECONDS + 1).retryAfterSeconds).toBeNull();
      expect(rateLimited('account', 418, Number.MAX_SAFE_INTEGER).retryAfterSeconds).toBeNull();
    });

    it('keeps every value inside the documented range, including both ends', () => {
      expect(rateLimited('account', 429, 0).retryAfterSeconds).toBe(0);
      expect(rateLimited('account', 418, MAX_RETRY_AFTER_SECONDS).retryAfterSeconds).toBe(259_200);
    });

    it('never schedules a defer at or before the instant it was computed from', () => {
      for (const seconds of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e18]) {
        const until = deferUntil(rateLimited('account', 429, seconds), NOW);
        expect(until, String(seconds)).not.toBeNull();
        expect((until?.getTime() ?? 0) > NOW.getTime(), String(seconds)).toBe(true);
      }
    });
  });

  describe('venue rejections', () => {
    it('keeps the venue error code, which is how a caller tells absent from unknown', () => {
      // -2013 is "Order does not exist." A single one of those must never release a
      // reservation (T-029), and the caller can only apply that rule if it sees the code.
      const failure = venueRejected('order', -2013, 'Order does not exist.');
      expect(failure.venueCode).toBe(-2013);
      expect(failure.detail['venueCode']).toBe('-2013');
    });

    it('redacts credential material out of a venue message before storing it', () => {
      const failure = venueRejected(
        'account',
        -1022,
        'Signature for this request is not valid: signature=abcdef0123456789',
      );
      expect(failure.message).not.toContain('abcdef0123456789');
      expect(failure.detail['venueMessage']).not.toContain('abcdef0123456789');
    });
  });

  it('never carries a raw response body in its detail', () => {
    // The body of a signed request's error can echo the query string back at us.
    const failure = schemaUnrecognized('myTrades', 'commissionAsset missing');
    for (const value of Object.values(failure.detail)) {
      expect(value).not.toMatch(/signature=[^R]/);
    }
  });
});
