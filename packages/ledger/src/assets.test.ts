import { describe, expect, it } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import { assertSupportedAsset, isSupportedAsset, supportedAssets } from './assets.js';

/**
 * Which assets this pool may account for at all (TDD section 6; prompt 06 task 4).
 *
 * Base, quote and *explicitly configured* fee assets. Nothing else: an asset with no declared
 * scale has no proven precision, and accounting for it would put a number of unknown magnitude
 * into the ledger. The set is closed by construction rather than by a runtime check somewhere
 * downstream, because "we found some DOGE in the account" must be a refusal, not an entry.
 */
describe('the supported asset set', () => {
  const set = supportedAssets({
    base: { code: 'BTC', scaleVersion: 'v1' },
    quote: { code: 'USDT', scaleVersion: 'v1' },
    feeAssets: [{ code: 'BNB', scaleVersion: 'v1' }],
  });

  it('contains the base, the quote and the configured fee assets', () => {
    expect(set.assets.map((asset) => asset.code)).toEqual(['BNB', 'BTC', 'USDT']);
  });

  it('is ordered deterministically, so an evidence export is comparable', () => {
    const reordered = supportedAssets({
      base: { code: 'BTC', scaleVersion: 'v1' },
      quote: { code: 'USDT', scaleVersion: 'v1' },
      feeAssets: [{ code: 'BNB', scaleVersion: 'v1' }],
    });
    expect(reordered.assets).toEqual(set.assets);
  });

  it('accepts an asset it declares', () => {
    for (const code of ['BTC', 'USDT', 'BNB']) {
      expect(isSupportedAsset(set, { code, scaleVersion: 'v1' }), code).toBe(true);
    }
  });

  it('refuses an asset it does not declare', () => {
    expect(isSupportedAsset(set, { code: 'DOGE', scaleVersion: 'v1' })).toBe(false);
    expect(() => assertSupportedAsset(set, { code: 'DOGE', scaleVersion: 'v1' })).toThrow(
      ContractViolation,
    );
  });

  it('refuses a declared code at an undeclared scale', () => {
    // The scale is part of the identity: the same code at a different precision is a
    // different number, and treating them as one is how a balance moves by a factor of 100.
    expect(isSupportedAsset(set, { code: 'BTC', scaleVersion: 'v2' })).toBe(false);
    try {
      assertSupportedAsset(set, { code: 'BTC', scaleVersion: 'v2' });
      expect.unreachable('a declared code at another scale must be refused');
    } catch (error) {
      // The refusal names the asset it refused and the set it compared against, so an
      // operator can see that the code matched and the precision did not.
      expect((error as ContractViolation).detail['asset']).toBe('BTC@v2');
      expect((error as ContractViolation).detail['supported']).toBe('BNB@v1,BTC@v1,USDT@v1');
    }
  });

  it('names FEE_ASSET_UNSUPPORTED so the refusal is the documented one', () => {
    try {
      assertSupportedAsset(set, { code: 'DOGE', scaleVersion: 'v1' });
      expect.unreachable('an undeclared asset must be refused');
    } catch (error) {
      expect((error as ContractViolation).reason).toBe('FEE_ASSET_UNSUPPORTED');
    }
  });

  it('works with no fee asset configured, which is the initial policy', () => {
    // ADR-0010 enables STANDARD_NO_BNB_V1, whose commission is in the received asset. A pool
    // on that policy declares no third fee asset, and that is not a misconfiguration.
    const noFee = supportedAssets({
      base: { code: 'BTC', scaleVersion: 'v1' },
      quote: { code: 'USDT', scaleVersion: 'v1' },
      feeAssets: [],
    });
    expect(noFee.assets.map((asset) => asset.code)).toEqual(['BTC', 'USDT']);
    expect(isSupportedAsset(noFee, { code: 'BNB', scaleVersion: 'v1' })).toBe(false);
  });

  it('refuses a configuration whose base and quote are the same asset', () => {
    // A pair that trades an asset against itself is not a market, and the accounting for it
    // would sum one asset's control against its own claims twice.
    expect(() =>
      supportedAssets({
        base: { code: 'BTC', scaleVersion: 'v1' },
        quote: { code: 'BTC', scaleVersion: 'v1' },
        feeAssets: [],
      }),
    ).toThrow(ContractViolation);
  });

  it('deduplicates a fee asset that is already the base or the quote', () => {
    // STANDARD_NO_BNB_V1 charges commission in the received asset, so naming the quote as a
    // fee asset is a legitimate configuration rather than a duplicate declaration.
    const overlapping = supportedAssets({
      base: { code: 'BTC', scaleVersion: 'v1' },
      quote: { code: 'USDT', scaleVersion: 'v1' },
      feeAssets: [{ code: 'USDT', scaleVersion: 'v1' }],
    });
    expect(overlapping.assets.map((asset) => asset.code)).toEqual(['BTC', 'USDT']);
  });
});
