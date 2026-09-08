import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeWellFormed,
  assertEnvelopeWithinApproval,
  assertTransmissionPermitted,
  guaranteedTransmissionCutoffLocalMs,
  signedAtLocalMs,
  worstCaseVenueAcceptanceCutoffLocalMs,
  type SignedRequestEnvelope,
} from './dispatch-envelope.js';

const DEADLINE_ISO = '2026-09-08T10:00:00.000Z';
const DEADLINE = Date.parse(DEADLINE_ISO);
const DIGEST = `sha256:${'0'.repeat(64)}`;

/**
 * An independent model of the venue's documented acceptance predicate.
 *
 * Written from the official Timing security rule
 * (`serverTime - recvWindow <= timestamp <= serverTime + 1000`) rather than by calling the
 * production helper, so these tests cannot pass merely because the implementation is
 * self-consistent.
 */
function venueAcceptsIndependently(
  signedTimestampMs: number,
  recvWindowMs: number,
  venueServerTimeMs: number,
): boolean {
  return (
    signedTimestampMs >= venueServerTimeMs - recvWindowMs &&
    signedTimestampMs <= venueServerTimeMs + 1000
  );
}

/** Convert a LOCAL instant to the VENUE clock under a given true offset. */
function venueTimeAt(localMs: number, trueOffsetMs: number): number {
  return localMs + trueOffsetMs;
}

function envelope(overrides: Partial<SignedRequestEnvelope> = {}): SignedRequestEnvelope {
  return {
    signedTimestampMs: DEADLINE - 4000,
    venueClockOffsetMs: 0,
    validityMs: 3000,
    clockSkewBudgetMs: 100,
    transmissionLatencyBudgetMs: 200,
    signedPayloadDigest: DIGEST,
    ...overrides,
  };
}

describe('signed request timing envelope', () => {
  describe('well-formedness', () => {
    it('accepts a usable envelope', () => {
      expect(() => assertEnvelopeWellFormed(envelope())).not.toThrow();
    });

    it('refuses a recvWindow above the venue maximum', () => {
      expect(() => assertEnvelopeWellFormed(envelope({ validityMs: 60_001 }))).toThrow(
        /between 1 and 60000/,
      );
    });

    it('refuses an envelope with no guaranteed transmission window', () => {
      // validity must exceed 2*skew + latency, otherwise no local instant is certain to be
      // accepted and the executor would be gambling on its clock.
      expect(() =>
        assertEnvelopeWellFormed(
          envelope({ validityMs: 400, clockSkewBudgetMs: 150, transmissionLatencyBudgetMs: 100 }),
        ),
      ).toThrow(/CLOCK_SKEW_UNBOUNDED/);
    });

    it('refuses non-integer or non-finite timing fields', () => {
      expect(() => assertEnvelopeWellFormed(envelope({ venueClockOffsetMs: 1.5 }))).toThrow(
        /safe integer/,
      );
      expect(() => assertEnvelopeWellFormed(envelope({ clockSkewBudgetMs: Number.NaN }))).toThrow(
        /safe integer/,
      );
    });
  });

  describe('clock domains are distinguished', () => {
    it('converts the signed venue timestamp back to a local instant', () => {
      const env = envelope({ signedTimestampMs: DEADLINE - 4000, venueClockOffsetMs: 2500 });
      expect(signedAtLocalMs(env)).toBe(DEADLINE - 6500);
    });

    it('separates the safety cutoff from the liveness cutoff', () => {
      const env = envelope();
      // worst case = signedAtLocal + validity + skew ; guaranteed = + validity - skew - latency
      expect(worstCaseVenueAcceptanceCutoffLocalMs(env)).toBe(signedAtLocalMs(env) + 3100);
      expect(guaranteedTransmissionCutoffLocalMs(env)).toBe(signedAtLocalMs(env) + 2700);
      expect(worstCaseVenueAcceptanceCutoffLocalMs(env)).toBeGreaterThan(
        guaranteedTransmissionCutoffLocalMs(env),
      );
    });
  });

  // --- regression: maintainer draft review, wrong cutoff bound to the deadline ----------
  // The first draft compared `timestamp + recvWindow - skew` to the deadline. The venue can
  // still accept through `timestamp + recvWindow`, so an envelope whose bytes remained
  // valid past the approval was accepted by the validator.
  describe('approval binding (regression: draft review)', () => {
    it("refuses the maintainer's reported envelope", () => {
      // signedTimestamp = deadline - 900, validity = 1000, skew = 100.
      // Old check: -900 + 1000 - 100 = deadline -> accepted.
      // Venue at zero skew accepts through deadline + 100.
      const reported = envelope({
        signedTimestampMs: DEADLINE - 900,
        validityMs: 1000,
        clockSkewBudgetMs: 100,
        transmissionLatencyBudgetMs: 0,
      });
      expect(() => assertEnvelopeWithinApproval(reported, DEADLINE_ISO, DEADLINE_ISO)).toThrow(
        /could still be accepted by the venue after the approved submission deadline/,
      );
    });

    it('reports the exact overshoot it refused', () => {
      const reported = envelope({
        signedTimestampMs: DEADLINE - 900,
        validityMs: 1000,
        clockSkewBudgetMs: 100,
        transmissionLatencyBudgetMs: 0,
      });
      try {
        assertEnvelopeWithinApproval(reported, DEADLINE_ISO, DEADLINE_ISO);
        throw new Error('expected a refusal');
      } catch (error) {
        // worst case = (deadline - 900) + 1000 + 100 = deadline + 200
        expect((error as { detail: Record<string, string> }).detail['overshootMs']).toBe('200');
      }
    });

    it('accepts an envelope that expires at the venue before the deadline', () => {
      const safe = envelope({
        signedTimestampMs: DEADLINE - 4000,
        validityMs: 3000,
        clockSkewBudgetMs: 100,
      });
      expect(() => assertEnvelopeWithinApproval(safe, DEADLINE_ISO, DEADLINE_ISO)).not.toThrow();
    });

    it('refuses a submission deadline that outlives the approval it depends on', () => {
      expect(() =>
        assertEnvelopeWithinApproval(envelope(), DEADLINE_ISO, '2026-09-08T09:59:00.000Z'),
      ).toThrow(/may not outlive the owner approval/);
    });
  });

  /**
   * The property that actually matters, checked against the independent venue model rather
   * than against our own helper: for an envelope our validator accepted, there is no true
   * clock offset within budget and no transmission instant — including one after an
   * arbitrary pause — at which the venue accepts the bytes after the approved deadline.
   */
  describe('no permitted offset allows post-deadline acceptance', () => {
    const accepted = envelope({
      signedTimestampMs: DEADLINE - 4000,
      venueClockOffsetMs: 0,
      validityMs: 3000,
      clockSkewBudgetMs: 100,
      transmissionLatencyBudgetMs: 200,
    });

    it('is accepted by the validator', () => {
      expect(() =>
        assertEnvelopeWithinApproval(accepted, DEADLINE_ISO, DEADLINE_ISO),
      ).not.toThrow();
    });

    for (const trueOffsetMs of [-100, -50, 0, 50, 100]) {
      it(`holds at a true venue clock offset of ${trueOffsetMs} ms`, () => {
        // Simulate a transmitter that paused for an arbitrary time between its final local
        // check and the physical send, then transmitted anyway.
        for (let pauseMs = 0; pauseMs <= 8000; pauseMs += 25) {
          const localSendAt = signedAtLocalMs(accepted) + pauseMs;
          const arrivesAtVenue = venueTimeAt(localSendAt, trueOffsetMs);
          const venueAccepts = venueAcceptsIndependently(
            accepted.signedTimestampMs,
            accepted.validityMs,
            arrivesAtVenue,
          );
          if (venueAccepts) {
            // If the venue would accept, that acceptance must happen no later than the
            // deadline in LOCAL terms — which is the domain the owner approved in.
            expect(localSendAt, `pause=${pauseMs} offset=${trueOffsetMs}`).toBeLessThanOrEqual(
              DEADLINE,
            );
          }
        }
      });
    }

    it('the old, wrong bound would have failed this same property', () => {
      // Demonstrates the regression is real rather than hypothetical: reconstruct the
      // superseded rule and show it admits an envelope the venue accepts past the deadline.
      const reported = { signedTimestampMs: DEADLINE - 900, validityMs: 1000, skew: 100 };
      const supersededCutoff = reported.signedTimestampMs + reported.validityMs - reported.skew;
      expect(supersededCutoff).toBeLessThanOrEqual(DEADLINE); // old rule accepted it

      const acceptedPastDeadline = venueAcceptsIndependently(
        reported.signedTimestampMs,
        reported.validityMs,
        DEADLINE + 50, // zero true skew, 50 ms after the approval lapsed
      );
      expect(acceptedPastDeadline).toBe(true);
    });
  });

  describe('transmission permission is liveness, not safety', () => {
    it('permits transmission inside the guaranteed window', () => {
      const env = envelope();
      expect(() =>
        assertTransmissionPermitted(env, guaranteedTransmissionCutoffLocalMs(env)),
      ).not.toThrow();
    });

    it('refuses transmission after the guaranteed window and demands a new approval', () => {
      const env = envelope();
      expect(() =>
        assertTransmissionPermitted(env, guaranteedTransmissionCutoffLocalMs(env) + 1),
      ).toThrow(/never a re-signature/);
    });

    it('a paused transmitter that ignores the check still cannot be accepted late', () => {
      const env = envelope();
      assertEnvelopeWithinApproval(env, DEADLINE_ISO, DEADLINE_ISO);
      // Transmit one hour late at the most favourable permitted offset.
      const localSendAt = signedAtLocalMs(env) + 3_600_000;
      const arrivesAtVenue = venueTimeAt(localSendAt, -env.clockSkewBudgetMs);
      expect(venueAcceptsIndependently(env.signedTimestampMs, env.validityMs, arrivesAtVenue)).toBe(
        false,
      );
    });
  });
});
