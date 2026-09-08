import { formatAssetKey, violate, type AssetKey } from '@capitaldesk/contracts';

/**
 * The assets a pool may account for (TDD section 6; ADR-0010).
 *
 * Base, quote and *explicitly configured* fee assets, and nothing else. The set is closed by
 * construction rather than checked somewhere downstream, because an asset with no declared
 * scale has no proven precision: accounting for it would put a number of unknown magnitude
 * into the ledger, and "we found some DOGE in the account" has to be a refusal rather than an
 * entry.
 *
 * The scale is part of the identity. The same code at a different precision is a different
 * number, and treating the two as one is how a balance moves by a factor of a hundred.
 */
export interface SupportedAssetConfiguration {
  readonly base: AssetKey;
  readonly quote: AssetKey;
  /**
   * Third-asset fee routing, declared explicitly.
   *
   * Empty is a normal configuration, not a mistake: `STANDARD_NO_BNB_V1` charges commission in
   * the received asset, so a pool on that policy declares no third fee asset at all.
   */
  readonly feeAssets: readonly AssetKey[];
}

export interface SupportedAssets {
  /** Every declared asset, deduplicated and in a deterministic order. */
  readonly assets: readonly AssetKey[];
  readonly base: AssetKey;
  readonly quote: AssetKey;
}

export function supportedAssets(configuration: SupportedAssetConfiguration): SupportedAssets {
  const base = formatAssetKey(configuration.base);
  const quote = formatAssetKey(configuration.quote);
  if (base === quote) {
    // A pair trading an asset against itself is not a market, and its accounting would sum one
    // asset's control against its own claims twice.
    violate('POLICY_CONFIGURATION_MISSING', 'the base and quote assets are the same', {
      asset: base,
    });
  }
  const byKey = new Map<string, AssetKey>();
  for (const asset of [configuration.base, configuration.quote, ...configuration.feeAssets]) {
    // A fee asset that is already the base or the quote is a legitimate declaration under a
    // received-asset commission policy, not a duplicate to refuse.
    byKey.set(formatAssetKey(asset), asset);
  }
  const assets = [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, asset]) => asset);
  return { assets, base: configuration.base, quote: configuration.quote };
}

export function isSupportedAsset(set: SupportedAssets, asset: AssetKey): boolean {
  const key = formatAssetKey(asset);
  return set.assets.some((declared) => formatAssetKey(declared) === key);
}

export function assertSupportedAsset(set: SupportedAssets, asset: AssetKey): void {
  if (!isSupportedAsset(set, asset)) {
    violate('FEE_ASSET_UNSUPPORTED', 'this pool does not account for that asset', {
      asset: formatAssetKey(asset),
      supported: set.assets.map(formatAssetKey).join(','),
    });
  }
}
