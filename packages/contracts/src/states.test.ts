import { describe, expect, it } from 'vitest';
import {
  DISPATCH_ATTEMPT_STATES,
  DISPATCH_ATTEMPT_TRANSITIONS,
  VENUE_ORDER_STATUSES,
  canTransition,
  isTerminalVenueStatus,
  mayAutomaticallyResend,
  mayReleaseUnusedReservation,
  type AccountingState,
  type ObservationCoverageState,
  type VenueOrderStatus,
} from './states.js';

describe('dispatch attempt states', () => {
  it('never permits an automatic resend in any state', () => {
    for (const state of DISPATCH_ATTEMPT_STATES) {
      expect(mayAutomaticallyResend(state), state).toBe(false);
    }
  });

  it('records SEND_ATTEMPTED between the marker and any outcome', () => {
    expect(canTransition(DISPATCH_ATTEMPT_TRANSITIONS, 'DISPATCH_MARKED', 'SEND_ATTEMPTED')).toBe(
      true,
    );
    // A marked attempt may never go backwards to PREPARED and be retried.
    expect(canTransition(DISPATCH_ATTEMPT_TRANSITIONS, 'DISPATCH_MARKED', 'PREPARED')).toBe(false);
  });

  it('allows NOT_SENT_PROVEN only from a marked or unknown attempt', () => {
    expect(canTransition(DISPATCH_ATTEMPT_TRANSITIONS, 'DISPATCH_MARKED', 'NOT_SENT_PROVEN')).toBe(
      true,
    );
    expect(canTransition(DISPATCH_ATTEMPT_TRANSITIONS, 'UNKNOWN', 'NOT_SENT_PROVEN')).toBe(true);
    // Once bytes were attempted, absence can no longer be proven this way.
    expect(canTransition(DISPATCH_ATTEMPT_TRANSITIONS, 'SEND_ATTEMPTED', 'NOT_SENT_PROVEN')).toBe(
      false,
    );
  });

  it('treats every terminal outcome as final', () => {
    for (const state of [
      'ACKNOWLEDGED',
      'REJECTED',
      'NOT_SENT_PROVEN',
      'IRRECOVERABLE_UNCERTAINTY',
    ] as const) {
      expect(DISPATCH_ATTEMPT_TRANSITIONS[state], state).toEqual([]);
    }
  });
});

describe('venue order statuses', () => {
  it('includes the self-trade prevention terminal status', () => {
    expect(VENUE_ORDER_STATUSES).toContain('EXPIRED_IN_MATCH');
    expect(isTerminalVenueStatus('EXPIRED_IN_MATCH')).toBe(true);
  });

  it('does not treat an unsupported observation as terminal', () => {
    // An unknown future status must quarantine, not be read as a finished order.
    expect(isTerminalVenueStatus('UNSUPPORTED_OBSERVATION')).toBe(false);
  });

  it('does not treat a live order as terminal', () => {
    for (const status of ['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL'] as const) {
      expect(isTerminalVenueStatus(status), status).toBe(false);
    }
  });
});

describe('releasing an unused reservation', () => {
  const reconciled: AccountingState = 'RECONCILED';
  const complete: ObservationCoverageState = 'COMPLETE';

  it('releases on the ordinary path: terminal, reconciled and fully covered', () => {
    expect(
      mayReleaseUnusedReservation({
        venueStatus: 'EXPIRED',
        accounting: reconciled,
        coverage: complete,
        dispatchState: 'ACKNOWLEDGED',
      }),
    ).toBe(true);
  });

  it('requires all three of terminal status, reconciled accounting and complete coverage', () => {
    const base = {
      venueStatus: 'FILLED' as VenueOrderStatus,
      accounting: reconciled,
      coverage: complete,
      dispatchState: 'ACKNOWLEDGED' as const,
    };
    expect(mayReleaseUnusedReservation({ ...base, venueStatus: 'PARTIALLY_FILLED' })).toBe(false);
    expect(mayReleaseUnusedReservation({ ...base, accounting: 'PROVISIONAL' })).toBe(false);
    expect(mayReleaseUnusedReservation({ ...base, accounting: 'INCOMPLETE' })).toBe(false);
    for (const coverage of ['GAP_OPEN', 'BACKFILLING', 'INCOMPLETE', 'UNSUPPORTED'] as const) {
      expect(mayReleaseUnusedReservation({ ...base, coverage }), coverage).toBe(false);
    }
  });

  // --- regression: PR 1 review, NOT_SENT_PROVEN could never release ---------------------
  // A proven-unsent attempt has no venue status, because no order exists to have one.
  // Requiring a terminal status made it unable to release the reservations ADR-0001 says it
  // releases, leaving the pool blocked on the one path designed to unblock it.
  describe('a proven-unsent attempt', () => {
    it('releases with no venue status once coverage is complete', () => {
      expect(
        mayReleaseUnusedReservation({
          venueStatus: null,
          accounting: 'INCOMPLETE',
          coverage: complete,
          dispatchState: 'NOT_SENT_PROVEN',
        }),
      ).toBe(true);
    });

    it('still requires complete coverage, which is what established the absence', () => {
      for (const coverage of ['GAP_OPEN', 'BACKFILLING', 'INCOMPLETE', 'UNSUPPORTED'] as const) {
        expect(
          mayReleaseUnusedReservation({
            venueStatus: null,
            accounting: 'INCOMPLETE',
            coverage,
            dispatchState: 'NOT_SENT_PROVEN',
          }),
          coverage,
        ).toBe(false);
      }
    });
  });

  describe('an unresolved attempt never releases', () => {
    it('refuses UNKNOWN even when everything else looks complete', () => {
      expect(
        mayReleaseUnusedReservation({
          venueStatus: 'EXPIRED',
          accounting: reconciled,
          coverage: complete,
          dispatchState: 'UNKNOWN',
        }),
      ).toBe(false);
    });

    it('refuses IRRECOVERABLE_UNCERTAINTY, which retains the liability', () => {
      expect(
        mayReleaseUnusedReservation({
          venueStatus: 'EXPIRED',
          accounting: reconciled,
          coverage: complete,
          dispatchState: 'IRRECOVERABLE_UNCERTAINTY',
        }),
      ).toBe(false);
    });

    it('refuses a missing venue status on any state other than NOT_SENT_PROVEN', () => {
      expect(
        mayReleaseUnusedReservation({
          venueStatus: null,
          accounting: reconciled,
          coverage: complete,
          dispatchState: 'ACKNOWLEDGED',
        }),
      ).toBe(false);
    });
  });
});
