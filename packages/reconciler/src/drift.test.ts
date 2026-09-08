import { describe, expect, it } from 'vitest';
import { assessDrift, mayOpenResetEpoch, mayResume } from './drift.js';

describe('drift containment', () => {
  it('quarantines incomplete history even when balances happen to match', () => {
    expect(
      assessDrift({
        expectedAccountId: 'a',
        observedAccountId: 'a',
        coverage: 'INCOMPLETE',
        expectedBalances: { 'BTC:v1': 1n },
        observedBalances: { 'BTC:v1': 1n },
        externalActivityObserved: false,
        unknownOpenOrderObserved: false,
        scaleChanged: false,
        resetPositivelyDetected: false,
      }),
    ).toEqual({ quarantine: true, incidents: ['INCOMPLETE_HISTORY'], balancesEqual: true });
  });

  it('detects external activity outside the selected symbol without guessing attribution', () => {
    expect(
      assessDrift({
        expectedAccountId: 'a',
        observedAccountId: 'a',
        coverage: 'COMPLETE',
        expectedBalances: {},
        observedBalances: {},
        externalActivityObserved: true,
        unknownOpenOrderObserved: false,
        scaleChanged: false,
        resetPositivelyDetected: false,
      }).incidents,
    ).toEqual(['EXTERNAL_ACTIVITY']);
  });

  it('requires positive reset evidence, sender fencing and zero UNKNOWN liabilities', () => {
    expect(
      mayOpenResetEpoch({
        resetPositivelyDetected: true,
        senderFenced: true,
        unresolvedDispatchCount: 1n,
        coverage: 'COMPLETE',
      }),
    ).toBe(false);
    expect(
      mayResume({
        coverage: 'COMPLETE',
        activeIncidentCount: 0n,
        unresolvedDispatchCount: 0n,
        accountIdentityMatches: true,
      }),
    ).toBe(true);
  });
});
