import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_CLASSES,
  PROCESS_ROLES,
  assertMayMount,
  assertReaderAndTraderMatch,
  mayMount,
} from './credentials.js';

describe('credential classes', () => {
  it('permits exactly the documented mounts', () => {
    expect(mayMount('executor', 'VENUE_TRADE')).toBe(true);
    expect(mayMount('worker', 'VENUE_READ')).toBe(true);
    expect(mayMount('api', 'OWNER_SESSION')).toBe(true);
  });

  it('never mounts a venue credential into the console', () => {
    for (const credential of CREDENTIAL_CLASSES) {
      expect(mayMount('web', credential), credential).toBe(false);
    }
  });

  it('never mounts the trade credential outside the executor', () => {
    for (const role of PROCESS_ROLES) {
      if (role === 'executor') continue;
      expect(mayMount(role, 'VENUE_TRADE'), role).toBe(false);
      expect(() => assertMayMount(role, 'VENUE_TRADE')).toThrow(/AUTHZ_CREDENTIAL_CLASS_DENIED/);
    }
  });

  it('never mounts the read credential outside the worker', () => {
    for (const role of PROCESS_ROLES) {
      if (role === 'worker') continue;
      expect(mayMount(role, 'VENUE_READ'), role).toBe(false);
    }
  });

  // --- regression: PR 1 review, two absent identities compared equal --------------------
  // The same-account gate exists to catch reconciling one account while trading another.
  // Comparing the ids directly let it pass when neither credential had established one.
  describe('reader and trader must be the same established account', () => {
    it('accepts two identical valid account ids', () => {
      expect(() => assertReaderAndTraderMatch('81234567', '81234567')).not.toThrow();
    });

    it('rejects two empty ids rather than treating them as a match', () => {
      expect(() => assertReaderAndTraderMatch('', '')).toThrow(/established no account id/);
    });

    it('rejects an empty id on either side', () => {
      expect(() => assertReaderAndTraderMatch('', '81234567')).toThrow(/reader/);
      expect(() => assertReaderAndTraderMatch('81234567', '')).toThrow(/trader/);
    });

    it('rejects whitespace-only ids, which are not identities', () => {
      for (const blank of [' ', '\t', '\n', '   ']) {
        expect(() => assertReaderAndTraderMatch(blank, blank), JSON.stringify(blank)).toThrow(
          /established no account id/,
        );
      }
    });

    it('rejects a padded id rather than trimming it into a match', () => {
      expect(() => assertReaderAndTraderMatch(' 81234567', '81234567')).toThrow(/malformed/);
      expect(() => assertReaderAndTraderMatch('81234567 ', '81234567')).toThrow(/malformed/);
    });

    it('rejects a malformed id under the same segment rules as venueAccountKey', () => {
      for (const bad of ['has space', 'has/slash', '#hash', 'a'.repeat(65)]) {
        expect(() => assertReaderAndTraderMatch(bad, bad), bad).toThrow(/malformed/);
      }
    });

    it('still rejects two different valid ids', () => {
      expect(() => assertReaderAndTraderMatch('81234567', '99999999')).toThrow(
        /different venue accounts/,
      );
    });
  });
});
