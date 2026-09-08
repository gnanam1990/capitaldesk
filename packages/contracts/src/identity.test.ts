import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENTS,
  VENUES,
  formatPoolId,
  poolId,
  requireSamePool,
  symbolCode,
  venueAccountKey,
} from './identity.js';

const ACCOUNT = venueAccountKey('binance-spot', 'testnet', '81234567');

describe('venue account identity', () => {
  it('builds a key from a supported venue and environment', () => {
    expect(ACCOUNT.stableAccountId).toBe('81234567');
    expect(VENUES).toContain(ACCOUNT.venue);
    expect(ENVIRONMENTS).toContain(ACCOUNT.environment);
  });

  // --- regression: PR 1 review, allowlists enforced only in the type system --------------
  // A wire value that never met the compiler could enter persistence and routing as a
  // malformed identity, so the exported allowlists are now checked at runtime too.
  describe('rejects values outside the exported allowlists', () => {
    it('rejects an unsupported venue', () => {
      for (const venue of ['made-up-venue', 'binance-futures', '', 'BINANCE-SPOT']) {
        expect(() => venueAccountKey(venue as never, 'testnet', '81234567'), venue).toThrow(
          /unsupported venue/,
        );
      }
    });

    it('rejects an unsupported environment', () => {
      for (const environment of ['staging', 'prod', '', 'TESTNET']) {
        expect(
          () => venueAccountKey('binance-spot', environment as never, '81234567'),
          environment,
        ).toThrow(/unsupported environment/);
      }
    });

    it('names the supported values when it refuses', () => {
      try {
        venueAccountKey('nope' as never, 'testnet', '1');
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as { detail: Record<string, string> }).detail['supported']).toBe(
          VENUES.join(','),
        );
      }
    });

    it('still rejects a malformed account id', () => {
      expect(() => venueAccountKey('binance-spot', 'testnet', 'has space')).toThrow(
        /IDENTITY_MALFORMED/,
      );
    });
  });
});

describe('pool identity', () => {
  it('rejects an epoch below one', () => {
    for (const epoch of [0, -1, 1.5]) {
      expect(() => poolId('ws', ACCOUNT, epoch), String(epoch)).toThrow(/baselineEpoch/);
    }
  });

  it('formats a pool so its environment and epoch are visible', () => {
    expect(formatPoolId(poolId('ws-primary', ACCOUNT, 3))).toBe(
      'ws-primary/binance-spot:testnet:81234567/e3',
    );
  });

  describe('cross-pool interaction is refused with the specific mismatch', () => {
    const pool = poolId('ws', ACCOUNT, 1);

    it('reports an environment mismatch distinctly', () => {
      const other = poolId('ws', venueAccountKey('binance-spot', 'production', '81234567'), 1);
      expect(() => requireSamePool(pool, other, 'fill')).toThrow(/IDENTITY_ENVIRONMENT_MISMATCH/);
    });

    it('reports an epoch mismatch distinctly', () => {
      expect(() => requireSamePool(pool, poolId('ws', ACCOUNT, 2), 'fill')).toThrow(
        /IDENTITY_EPOCH_MISMATCH/,
      );
    });

    it('reports an unrelated pool as a scope mismatch', () => {
      expect(() => requireSamePool(pool, poolId('other-ws', ACCOUNT, 1), 'fill')).toThrow(
        /IDENTITY_SCOPE_MISMATCH/,
      );
    });

    it('permits the same pool', () => {
      expect(() => requireSamePool(pool, poolId('ws', ACCOUNT, 1), 'fill')).not.toThrow();
    });
  });
});

describe('symbol codes', () => {
  it('accepts an uppercase venue symbol', () => {
    expect(symbolCode('BTCUSDT')).toBe('BTCUSDT');
  });

  it('rejects lowercase, punctuation and empty symbols', () => {
    for (const symbol of ['btcusdt', 'BTC-USDT', '', 'B']) {
      expect(() => symbolCode(symbol), symbol).toThrow(/IDENTITY_MALFORMED/);
    }
  });
});
