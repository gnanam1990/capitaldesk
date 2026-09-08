import { formatAssetKey, type AssetKey } from '@capitaldesk/contracts';

/**
 * Independent per-asset verification (T-012; prompt 06 task 5).
 *
 * For each asset, the units the account controls equal the units its owners claim. This is
 * recomputed from the positions a caller read, deliberately without consulting whatever
 * projection produced them: the point is to be able to disagree with a wrong projection, not
 * to restate it.
 *
 * There is no adjustment term anywhere here, and there will not be one. A balancing plug is
 * how an unexplained difference stops being visible, and every invariant downstream is written
 * assuming this holds.
 */

export type ClaimPartition = 'AVAILABLE' | 'RESERVED' | 'QUARANTINED';

export interface OwnerClaim {
  /** `HOUSE`, or a strategy id. */
  readonly owner: string;
  readonly availableAtoms: bigint;
  readonly reservedAtoms: bigint;
  readonly quarantinedAtoms: bigint;
}

export interface AssetPosition {
  readonly asset: AssetKey;
  /** What the account holds at the venue, per booked authoritative evidence. */
  readonly controlAtoms: bigint;
  readonly claims: readonly OwnerClaim[];
}

export interface ConservationDiscrepancy {
  readonly asset: string;
  readonly controlAtoms: bigint;
  readonly claimedAtoms: bigint;
  /** Control minus claims: positive means units nobody claims, negative means over-claimed. */
  readonly differenceAtoms: bigint;
}

export interface NegativeClaim {
  readonly asset: string;
  readonly owner: string;
  readonly partition: ClaimPartition;
  readonly atoms: bigint;
}

export interface ConservationResult {
  readonly conserved: boolean;
  /** Assets whose control and claims disagree, ordered by asset. */
  readonly discrepancies: readonly ConservationDiscrepancy[];
  /** Claim partitions below zero (INV-03), which are never a legitimate state. */
  readonly negativeClaims: readonly NegativeClaim[];
  readonly negativeControl: readonly string[];
}

export function verifyConservation(positions: readonly AssetPosition[]): ConservationResult {
  const discrepancies: ConservationDiscrepancy[] = [];
  const negativeClaims: NegativeClaim[] = [];
  const negativeControl: string[] = [];

  for (const position of positions) {
    const asset = formatAssetKey(position.asset);
    if (position.controlAtoms < 0n) negativeControl.push(asset);

    let claimedAtoms = 0n;
    for (const claim of position.claims) {
      // Checked before summing. A negative partition would otherwise cancel a positive one and
      // let the total agree while one owner's claim was impossible.
      for (const [partition, atoms] of [
        ['AVAILABLE', claim.availableAtoms],
        ['RESERVED', claim.reservedAtoms],
        ['QUARANTINED', claim.quarantinedAtoms],
      ] as const) {
        if (atoms < 0n) negativeClaims.push({ asset, owner: claim.owner, partition, atoms });
      }
      claimedAtoms += claim.availableAtoms + claim.reservedAtoms + claim.quarantinedAtoms;
    }

    // Each asset alone. A BTC surplus does not excuse a USDT shortfall.
    if (claimedAtoms !== position.controlAtoms) {
      discrepancies.push({
        asset,
        controlAtoms: position.controlAtoms,
        claimedAtoms,
        differenceAtoms: position.controlAtoms - claimedAtoms,
      });
    }
  }

  const byAsset = (a: { asset: string }, b: { asset: string }): number =>
    a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0;

  return {
    conserved:
      discrepancies.length === 0 && negativeClaims.length === 0 && negativeControl.length === 0,
    discrepancies: [...discrepancies].sort(byAsset),
    negativeClaims: [...negativeClaims].sort(byAsset),
    negativeControl: [...negativeControl].sort(),
  };
}
