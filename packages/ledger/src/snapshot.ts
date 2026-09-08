import { formatAssetKey, violate, type AssetKey } from '@capitaldesk/contracts';
import { isSupportedAsset, type SupportedAssets } from './assets.js';

/**
 * Deriving an opening position from a persisted closing snapshot.
 *
 * The opening is a *function of* the snapshot, never a claim made alongside it. A caller that
 * names a cut and then states its own balances can state anything, and the first version of
 * this service accepted an opening of 1000 against a snapshot holding nothing — the record
 * then said the opening came from that cut, and nothing in the system disagreed.
 *
 * Everything here refuses rather than normalises. A malformed amount, a negative one, a
 * duplicate asset or an unsupported one is a contradiction in the evidence; carrying on with a
 * repaired value would put a number nobody can trace into the ledger's first posting.
 */

/** One balance row as `venue_account_snapshots.balances` stores it. */
export interface SnapshotBalance {
  /** `CODE@scaleVersion`, as the reader wrote it. */
  readonly asset: string;
  readonly freeAtoms: string;
  readonly lockedAtoms: string;
}

export interface OpeningPosition {
  readonly asset: AssetKey;
  /** Free plus locked: total units owned, not units currently spendable. */
  readonly atoms: bigint;
}

/** Canonical non-negative integer, with no sign, exponent, separator or leading zero. */
const CANONICAL_ATOMS = /^(0|[1-9][0-9]*)$/;

function parseAtoms(value: unknown, asset: string, field: string): bigint {
  if (typeof value !== 'string' || !CANONICAL_ATOMS.test(value)) {
    // Negative is refused by the same rule, and named separately so the message is useful.
    if (typeof value === 'string' && /^-\d+$/.test(value)) {
      violate('EVIDENCE_CONTRADICTORY', `${asset} ${field} is negative in the snapshot`, {
        asset,
        field,
      });
    }
    violate('EVIDENCE_CONTRADICTORY', `${asset} ${field} is not a canonical integer`, {
      asset,
      field,
      value: typeof value === 'string' ? value : typeof value,
    });
  }
  return BigInt(value);
}

function parseAssetKey(text: unknown, supported: SupportedAssets): AssetKey {
  if (typeof text !== 'string') {
    violate('EVIDENCE_CONTRADICTORY', 'a snapshot balance has no asset key', {});
  }
  const parts = text.split('@');
  const [code, scaleVersion] = parts;
  if (
    parts.length !== 2 ||
    code === undefined ||
    scaleVersion === undefined ||
    code === '' ||
    scaleVersion === ''
  ) {
    violate('EVIDENCE_CONTRADICTORY', 'a snapshot balance has a malformed asset key', {
      asset: text,
    });
  }
  const asset: AssetKey = { code, scaleVersion };
  if (!isSupportedAsset(supported, asset)) {
    // Refused here as well as by the readiness predicate: this is the point where the number
    // would otherwise become a posting.
    violate('FEE_ASSET_UNSUPPORTED', 'the snapshot holds an asset this pool does not support', {
      asset: formatAssetKey(asset),
    });
  }
  return asset;
}

/**
 * The opening each supported asset is owed, from the snapshot's own rows.
 *
 * Free and locked are summed because both are owned: an opening that counted only free units
 * would credit HOUSE less than the account actually holds, and the difference would surface
 * later as an unexplained gain. Assets holding nothing are dropped, because a zero entry is
 * not a posting.
 */
export function openingFromSnapshot(
  balances: readonly SnapshotBalance[],
  supported: SupportedAssets,
): readonly OpeningPosition[] {
  const byAsset = new Map<string, OpeningPosition>();
  for (const balance of balances) {
    const asset = parseAssetKey(balance?.asset, supported);
    const key = formatAssetKey(asset);
    if (byAsset.has(key)) {
      // Two rows for one asset is a contradiction in the source. Adding them would silently
      // double the opening; taking either would be a choice nobody made.
      violate('EVIDENCE_CONTRADICTORY', 'the snapshot lists an asset twice', { asset: key });
    }
    const atoms =
      parseAtoms(balance?.freeAtoms, key, 'free') + parseAtoms(balance?.lockedAtoms, key, 'locked');
    byAsset.set(key, { asset, atoms });
  }
  return [...byAsset.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, position]) => position)
    .filter((position) => position.atoms !== 0n);
}
