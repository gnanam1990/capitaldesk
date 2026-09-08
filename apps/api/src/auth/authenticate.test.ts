import { describe, expect, it } from 'vitest';
import { verifyOwnerPassword } from './authenticate.js';

/**
 * Structural evidence for the login timing equalisation: not a wall-clock measurement, which
 * would be flaky, but a count of the expensive operations on each path.
 */
describe('owner password verification', () => {
  const digest = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA';

  it('performs exactly one verification whether or not the login exists', async () => {
    const calls: Array<[string, string]> = [];
    const verify = (against: string, presented: string): Promise<boolean> => {
      calls.push([against, presented]);
      return Promise.resolve(against === digest && presented === 'right');
    };

    // Unknown login: one verification, against the equalisation digest, answer false.
    expect(await verifyOwnerPassword(null, 'right', { equalisationDigest: digest, verify })).toBe(
      false,
    );
    expect(calls).toEqual([[digest, 'right']]);

    // Known login, wrong password: one verification, against the stored hash.
    calls.length = 0;
    expect(
      await verifyOwnerPassword('$argon2id$stored', 'wrong', {
        equalisationDigest: digest,
        verify,
      }),
    ).toBe(false);
    expect(calls).toEqual([['$argon2id$stored', 'wrong']]);

    // Known login, right password.
    calls.length = 0;
    expect(await verifyOwnerPassword(digest, 'right', { equalisationDigest: digest, verify })).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
  });

  it('never returns true for an unknown login, whatever the verifier says', async () => {
    // A verifier that would accept anything must still not authenticate a login that does
    // not exist: the equalisation verify is for timing, never for a decision.
    const accepting = (): Promise<boolean> => Promise.resolve(true);
    expect(
      await verifyOwnerPassword(null, 'anything', {
        equalisationDigest: digest,
        verify: accepting,
      }),
    ).toBe(false);
  });
});
