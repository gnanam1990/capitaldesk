import { describe, expect, it } from 'vitest';
import { createAuthorizationBundle, recoverAuthorization } from './authorization-bundle.js';

const bundle = () =>
  createAuthorizationBundle({
    planId: 'plan-1',
    planDigest: `sha256:${'a'.repeat(64)}`,
    canonicalPlan: '{"planId":"plan-1"}',
    approvalId: 'approval-1',
    approvalDigest: `sha256:${'b'.repeat(64)}`,
    allocationPolicyVersion: 'FIFO_V1',
    feePolicyVersion: '3',
    fifo: [
      { sequence: '17', strategyId: 'strategy-a', intentId: 'intent-a', approvedBaseAtoms: '60' },
      { sequence: '18', strategyId: 'strategy-b', intentId: 'intent-b', approvedBaseAtoms: '40' },
    ],
    dispatchMarkerId: 'attempt-1',
  });

describe('authorization evidence recovery', () => {
  it('recovers the original FIFO when the database backup predates the plan', () => {
    expect(recoverAuthorization(bundle())).toEqual({
      state: 'RECOVERED',
      fifo: [
        { sequence: '17', strategyId: 'strategy-a', intentId: 'intent-a', approvedBaseAtoms: '60' },
        { sequence: '18', strategyId: 'strategy-b', intentId: 'intent-b', approvedBaseAtoms: '40' },
      ],
    });
  });

  it('never guesses attribution when neither record survived', () => {
    expect(recoverAuthorization(null).state).toBe('RESTORE_ATTRIBUTION_UNRECOVERABLE');
  });

  it('refuses a corrupted bundle instead of using plausible FIFO', () => {
    const original = bundle();
    const corrupted = {
      ...original,
      evidence: {
        ...original.evidence,
        fifo: [...original.evidence.fifo].reverse(),
      },
    };
    expect(recoverAuthorization(corrupted)).toMatchObject({
      state: 'RESTORE_ATTRIBUTION_UNRECOVERABLE',
      reason: 'bundle digest mismatch',
    });
  });

  it('requires policy versions before creating a bundle', () => {
    const original = bundle().evidence;
    expect(() => createAuthorizationBundle({ ...original, allocationPolicyVersion: '' })).toThrow(
      /versions are required/,
    );
  });
});
