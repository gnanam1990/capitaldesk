import type { Pool } from 'pg';
import { currentEpochOf, requireAuthorityPool, type AuthorityRefusal } from './dispatch.js';
import { serializable, serializableOn, type Queryable } from './transaction.js';

/**
 * The ledger: append-only double entry per asset, and the only source of a balance.
 *
 * A posting is balanced when, per asset, the ASSET_CONTROL delta equals the sum of the claim
 * deltas (INV-02, INV-04). The repository refuses an unbalanced posting before it reaches the
 * database, and the database refuses it again at COMMIT, so no writer can make one durable.
 *
 * Balances are read from a projection that only the rebuild function can write, and the
 * rebuild derives them from the entries (INV-16). `balancesFromEntries` computes the same
 * figures independently so a test can prove the projection says what the entries say.
 */

export interface AssetRef {
  readonly code: string;
  readonly scale: string;
}

export type ClaimState = 'AVAILABLE' | 'RESERVED' | 'QUARANTINED';

export interface LedgerEntryInput {
  readonly accountKind: 'ASSET_CONTROL' | 'HOUSE' | 'STRATEGY';
  /** 'ASSET_CONTROL', 'HOUSE' or a strategy id, matching accountKind. */
  readonly owner: string;
  readonly claimState: 'CONTROL' | ClaimState;
  readonly asset: AssetRef;
  readonly deltaAtoms: bigint;
  /**
   * Required for a RESERVED movement, and only for one. A reservation's remainder is the sum
   * of the entries carrying its id, so consuming and releasing are attributable to it rather
   * than to the strategy's RESERVED claim as a whole.
   */
  readonly reservationId?: string;
}

export interface LedgerPostingInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly ledgerTxnId: string;
  /** Unique within the pool and epoch: posting the same source twice is refused. */
  readonly source: { readonly kind: string; readonly ref: string };
  readonly description: string;
  readonly entries: readonly LedgerEntryInput[];
}

export type PostOutcome =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly reason: 'UNBALANCED';
      readonly asset: string;
      readonly controlAtoms: bigint;
      readonly claimAtoms: bigint;
    }
  | { readonly ok: false; readonly reason: 'SOURCE_ALREADY_POSTED'; readonly ledgerTxnId: string }
  | { readonly ok: false; readonly reason: 'NO_ENTRIES' }
  | { readonly ok: false; readonly reason: 'UNKNOWN_POOL' };

export interface ReserveInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly reservationId: string;
  readonly strategyId: string;
  readonly planId: string;
  readonly asset: AssetRef;
  readonly atoms: bigint;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly reason: 'INSUFFICIENT_AVAILABLE';
      readonly availableAtoms: bigint;
    }
  | { readonly ok: false; readonly reason: 'NONPOSITIVE_AMOUNT' }
  | { readonly ok: false; readonly reason: 'SOURCE_ALREADY_POSTED'; readonly ledgerTxnId: string }
  | {
      readonly ok: false;
      readonly reason: 'EPOCH_NOT_CURRENT';
      readonly currentEpoch: number | null;
    }
  | AuthorityRefusal;

export type ReleaseOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: 'UNKNOWN_RESERVATION' }
  | { readonly ok: false; readonly reason: 'NOT_HELD'; readonly state: string }
  /** More than this reservation still holds, after whatever its fills consumed. */
  | { readonly ok: false; readonly reason: 'EXCEEDS_REMAINING'; readonly remainingAtoms: bigint }
  | { readonly ok: false; readonly reason: 'SOURCE_ALREADY_POSTED'; readonly ledgerTxnId: string };

export interface ClaimBalance {
  readonly owner: string;
  readonly asset: AssetRef;
  readonly availableAtoms: bigint;
  readonly reservedAtoms: bigint;
  readonly quarantinedAtoms: bigint;
}

function assetKey(asset: AssetRef): string {
  return `${asset.code}:${asset.scale}`;
}

/** Control vs claims per asset. Null when balanced. */
function findImbalance(
  entries: readonly LedgerEntryInput[],
): { asset: string; control: bigint; claims: bigint } | null {
  const totals = new Map<string, { control: bigint; claims: bigint }>();
  for (const entry of entries) {
    const key = assetKey(entry.asset);
    const total = totals.get(key) ?? { control: 0n, claims: 0n };
    if (entry.accountKind === 'ASSET_CONTROL') total.control += entry.deltaAtoms;
    else total.claims += entry.deltaAtoms;
    totals.set(key, total);
  }
  for (const [asset, total] of totals) {
    if (total.control !== total.claims)
      return { asset, control: total.control, claims: total.claims };
  }
  return null;
}

function byOwnerThenAsset(a: ClaimBalance, b: ClaimBalance): number {
  return a.owner === b.owner
    ? assetKey(a.asset).localeCompare(assetKey(b.asset))
    : a.owner.localeCompare(b.owner);
}

export class LedgerRepository {
  constructor(private readonly pool: Pool) {}

  postTransaction(input: LedgerPostingInput): Promise<PostOutcome> {
    return serializable(this.pool, (client) => LedgerRepository.postOn(client, input));
  }

  /**
   * Post inside the caller's transaction.
   *
   * Locks the pool row (the account-wide lock every claim change takes), refuses an unbalanced
   * or already-posted source, and advances the pool's ledger revision with the transaction.
   */
  static async postOn(client: Queryable, input: LedgerPostingInput): Promise<PostOutcome> {
    if (input.entries.length === 0) return { ok: false, reason: 'NO_ENTRIES' };
    const imbalance = findImbalance(input.entries);
    if (imbalance !== null) {
      return {
        ok: false,
        reason: 'UNBALANCED',
        asset: imbalance.asset,
        controlAtoms: imbalance.control,
        claimAtoms: imbalance.claims,
      };
    }

    const pool = await client.query<{ ledger_revision: string }>(
      'SELECT ledger_revision FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
      [input.workspaceId, input.poolId],
    );
    const current = pool.rows[0];
    if (current === undefined) return { ok: false, reason: 'UNKNOWN_POOL' };

    const posted = await client.query<{ ledger_txn_id: string }>(
      `SELECT ledger_txn_id FROM ledger_transactions
        WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND source_kind = $4 AND source_ref = $5`,
      [input.workspaceId, input.poolId, input.epoch, input.source.kind, input.source.ref],
    );
    const already = posted.rows[0];
    if (already !== undefined)
      return { ok: false, reason: 'SOURCE_ALREADY_POSTED', ledgerTxnId: already.ledger_txn_id };

    const revision = Number(current.ledger_revision) + 1;
    await client.query(
      `INSERT INTO ledger_transactions
         (workspace_id, pool_id, epoch, ledger_txn_id, revision, source_kind, source_ref, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.workspaceId,
        input.poolId,
        input.epoch,
        input.ledgerTxnId,
        revision,
        input.source.kind,
        input.source.ref,
        input.description,
      ],
    );
    let seq = 0;
    for (const entry of input.entries) {
      seq += 1;
      await client.query(
        `INSERT INTO ledger_entries
           (workspace_id, pool_id, epoch, ledger_txn_id, entry_seq, account_kind, account_owner,
            claim_state, asset_code, asset_scale, delta_atoms, reservation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.ledgerTxnId,
          seq,
          entry.accountKind,
          entry.owner,
          entry.claimState,
          entry.asset.code,
          entry.asset.scale,
          entry.deltaAtoms.toString(),
          entry.reservationId ?? null,
        ],
      );
    }
    await client.query(
      'UPDATE pools SET ledger_revision = $3, updated_at = now() WHERE workspace_id = $1 AND pool_id = $2',
      [input.workspaceId, input.poolId, revision],
    );
    return { ok: true, revision };
  }

  reserve(input: ReserveInput): Promise<ReserveOutcome> {
    return serializable(this.pool, (client) => reserveBody(client, input));
  }

  /** The same reservation pinned to one connection, for contention proven on independent backends. */
  static reserveOn(client: Queryable, input: ReserveInput): Promise<ReserveOutcome> {
    return serializableOn(client, (c) => reserveBody(c, input));
  }

  /**
   * Return unspent reserved atoms to AVAILABLE and close the reservation.
   *
   * The amount is what remains unspent, which the caller establishes from reconciled fills;
   * this method verifies it against the strategy's RESERVED claim and never guesses it.
   */
  release(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly reservationId: string;
    readonly atoms: bigint;
    readonly source: { readonly kind: string; readonly ref: string };
  }): Promise<ReleaseOutcome> {
    return serializable(this.pool, (client) => LedgerRepository.releaseOn(client, input));
  }

  static async releaseOn(
    client: Queryable,
    input: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly reservationId: string;
      readonly atoms: bigint;
      readonly source: { readonly kind: string; readonly ref: string };
    },
  ): Promise<ReleaseOutcome> {
    const reservation = await client.query<{
      epoch: number;
      strategy_id: string;
      asset_code: string;
      asset_scale: string;
      state: string;
    }>(
      `SELECT epoch, strategy_id, asset_code, asset_scale, state FROM reservations
        WHERE workspace_id = $1 AND pool_id = $2 AND reservation_id = $3 FOR UPDATE`,
      [input.workspaceId, input.poolId, input.reservationId],
    );
    const row = reservation.rows[0];
    if (row === undefined) return { ok: false, reason: 'UNKNOWN_RESERVATION' };
    if (row.state !== 'HELD') return { ok: false, reason: 'NOT_HELD', state: row.state };

    // What this reservation still holds, from its own postings - not what it was created
    // with. Comparing against the original let a release of the full amount follow a fill
    // that had already consumed part of it, driving the RESERVED claim negative.
    const remaining = await client.query<{ remaining: string }>(
      `SELECT coalesce(sum(delta_atoms), 0)::text AS remaining FROM ledger_entries
        WHERE workspace_id = $1 AND pool_id = $2 AND reservation_id = $3`,
      [input.workspaceId, input.poolId, input.reservationId],
    );
    const remainingAtoms = BigInt(remaining.rows[0]?.remaining ?? '0');
    if (input.atoms < 0n || input.atoms > remainingAtoms) {
      return { ok: false, reason: 'EXCEEDS_REMAINING', remainingAtoms };
    }

    const asset = { code: row.asset_code, scale: row.asset_scale };
    if (input.atoms > 0n) {
      const posted = await LedgerRepository.postOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        epoch: row.epoch,
        ledgerTxnId: `txn-release-${input.reservationId}`,
        source: input.source,
        description: `release ${input.reservationId}`,
        entries: [
          {
            accountKind: 'STRATEGY',
            owner: row.strategy_id,
            claimState: 'RESERVED',
            asset,
            deltaAtoms: -input.atoms,
            reservationId: input.reservationId,
          },
          {
            accountKind: 'STRATEGY',
            owner: row.strategy_id,
            claimState: 'AVAILABLE',
            asset,
            deltaAtoms: input.atoms,
          },
        ],
      });
      if (!posted.ok) {
        if (posted.reason === 'SOURCE_ALREADY_POSTED') return posted;
        throw new Error(`release posting refused: ${posted.reason}`);
      }
      await client.query(
        `UPDATE reservations SET state = 'RELEASED', version = version + 1, updated_at = now()
          WHERE workspace_id = $1 AND pool_id = $2 AND reservation_id = $3`,
        [input.workspaceId, input.poolId, input.reservationId],
      );
      return { ok: true, revision: posted.revision };
    }

    await client.query(
      `UPDATE reservations SET state = 'RELEASED', version = version + 1, updated_at = now()
        WHERE workspace_id = $1 AND pool_id = $2 AND reservation_id = $3`,
      [input.workspaceId, input.poolId, input.reservationId],
    );
    const pool = await client.query<{ ledger_revision: string }>(
      'SELECT ledger_revision FROM pools WHERE workspace_id = $1 AND pool_id = $2',
      [input.workspaceId, input.poolId],
    );
    return { ok: true, revision: Number(pool.rows[0]?.ledger_revision ?? '0') };
  }

  /** What a reservation still holds, derived from its postings. */
  async remainingOf(scope: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly reservationId: string;
  }): Promise<bigint> {
    const result = await this.pool.query<{ remaining: string }>(
      `SELECT coalesce(sum(delta_atoms), 0)::text AS remaining FROM ledger_entries
        WHERE workspace_id = $1 AND pool_id = $2 AND reservation_id = $3`,
      [scope.workspaceId, scope.poolId, scope.reservationId],
    );
    return BigInt(result.rows[0]?.remaining ?? '0');
  }

  async rebuildProjection(scope: {
    workspaceId: string;
    poolId: string;
  }): Promise<{ revision: number }> {
    const result = await this.pool.query<{ revision: string }>(
      'SELECT rebuild_claim_balances($1, $2)::text AS revision',
      [scope.workspaceId, scope.poolId],
    );
    return { revision: Number(result.rows[0]?.revision ?? '0') };
  }

  /**
   * The projection, brought up to date first.
   *
   * A projection is only a cache of the entries (INV-16). If its recorded revision is behind
   * the pool's ledger revision, or it has never been built, reading it would report balances
   * the ledger has already moved past - so it is rebuilt inside the same transaction before it
   * is read. The rebuild is the only writer of this table.
   */
  /**
   * Claims as they stand in one epoch.
   *
   * The epoch is required, not optional. An epoch exists so a venue reset cannot let old funds
   * become current authority, and a balance read that spanned epochs handed exactly that back:
   * after a rotation the closed epoch's opening still appeared as spendable availability.
   * History stays queryable by asking for its own epoch.
   */
  balances(scope: { workspaceId: string; poolId: string; epoch: number }): Promise<ClaimBalance[]> {
    return serializable(this.pool, async (client) => {
      const pool = await client.query<{ ledger_revision: string }>(
        'SELECT ledger_revision FROM pools WHERE workspace_id = $1 AND pool_id = $2',
        [scope.workspaceId, scope.poolId],
      );
      const current = pool.rows[0]?.ledger_revision;
      if (current === undefined) return [];
      const projected = await client.query<{ revision: string | null; rows: string }>(
        `SELECT min(ledger_revision)::text AS revision, count(*)::text AS rows
           FROM claim_balances WHERE workspace_id = $1 AND pool_id = $2`,
        [scope.workspaceId, scope.poolId],
      );
      // Staleness is judged across the whole pool because the rebuild is whole-pool: one
      // epoch's postings still advance the pool's revision.
      const stale = projected.rows[0]?.rows === '0' || projected.rows[0]?.revision !== current;
      if (stale) {
        await client.query('SELECT rebuild_claim_balances($1, $2)', [
          scope.workspaceId,
          scope.poolId,
        ]);
      }
      return LedgerRepository.readProjection(client, scope);
    });
  }

  /** The projection exactly as stored, without a rebuild. */
  async storedBalances(scope: {
    workspaceId: string;
    poolId: string;
    epoch: number;
  }): Promise<ClaimBalance[]> {
    return LedgerRepository.readProjection(this.pool, scope);
  }

  private static async readProjection(
    client: Queryable | Pool,
    scope: { workspaceId: string; poolId: string; epoch: number },
  ): Promise<ClaimBalance[]> {
    const result = await client.query<{
      account_owner: string;
      asset_code: string;
      asset_scale: string;
      available_atoms: string;
      reserved_atoms: string;
      quarantined_atoms: string;
    }>(
      `SELECT account_owner, asset_code, asset_scale, available_atoms::text, reserved_atoms::text, quarantined_atoms::text
         FROM claim_balances WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3`,
      [scope.workspaceId, scope.poolId, scope.epoch],
    );
    return result.rows
      .map((row): ClaimBalance => ({
        owner: row.account_owner,
        asset: { code: row.asset_code, scale: row.asset_scale },
        availableAtoms: BigInt(row.available_atoms),
        reservedAtoms: BigInt(row.reserved_atoms),
        quarantinedAtoms: BigInt(row.quarantined_atoms),
      }))
      .sort(byOwnerThenAsset);
  }

  /** The same figures, computed here from the entries rather than read from the projection. */
  async balancesFromEntries(scope: {
    workspaceId: string;
    poolId: string;
    epoch: number;
  }): Promise<ClaimBalance[]> {
    const result = await this.pool.query<{
      account_owner: string;
      claim_state: string;
      asset_code: string;
      asset_scale: string;
      delta_atoms: string;
    }>(
      `SELECT account_owner, claim_state, asset_code, asset_scale, delta_atoms::text
         FROM ledger_entries
        WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3
          AND account_kind <> 'ASSET_CONTROL'`,
      [scope.workspaceId, scope.poolId, scope.epoch],
    );
    const totals = new Map<string, ClaimBalance>();
    for (const row of result.rows) {
      const key = `${row.account_owner}|${row.asset_code}:${row.asset_scale}`;
      const total = totals.get(key) ?? {
        owner: row.account_owner,
        asset: { code: row.asset_code, scale: row.asset_scale },
        availableAtoms: 0n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      };
      const delta = BigInt(row.delta_atoms);
      totals.set(key, {
        ...total,
        availableAtoms: total.availableAtoms + (row.claim_state === 'AVAILABLE' ? delta : 0n),
        reservedAtoms: total.reservedAtoms + (row.claim_state === 'RESERVED' ? delta : 0n),
        quarantinedAtoms: total.quarantinedAtoms + (row.claim_state === 'QUARANTINED' ? delta : 0n),
      });
    }
    return [...totals.values()].sort(byOwnerThenAsset);
  }
}

async function reserveBody(client: Queryable, input: ReserveInput): Promise<ReserveOutcome> {
  if (input.atoms <= 0n) return { ok: false, reason: 'NONPOSITIVE_AMOUNT' };

  // The account-wide lock, first. Under SERIALIZABLE a second reserver that blocked here
  // behind a committed change fails serialization and re-runs from a fresh snapshot, where it
  // reads the reduced availability. Two readers of the same opening balance cannot both
  // commit against it (T-013).
  //
  // The same lock also carries the authority gate. A reservation is new economic authority
  // over the owner's capital, so it needs a pool that may create authority and a live
  // governance lease, exactly as marking a dispatch does.
  const authority = await requireAuthorityPool(client, input);
  if (!authority.ok) return authority;

  // Under the same lock rotation takes: a reservation against a closed epoch would commit
  // capital to a baseline that no longer governs.
  const currentEpoch = await currentEpochOf(client, input);
  if (currentEpoch !== input.epoch) {
    return { ok: false, reason: 'EPOCH_NOT_CURRENT', currentEpoch };
  }

  // Scoped to the epoch. A closed epoch's surplus is history, not spending power: summing
  // across epochs let old funds back a new reservation after a reset.
  const available = await client.query<{ available: string }>(
    `SELECT coalesce(sum(delta_atoms), 0)::text AS available FROM ledger_entries
      WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $6 AND account_owner = $3
        AND claim_state = 'AVAILABLE' AND asset_code = $4 AND asset_scale = $5`,
    [
      input.workspaceId,
      input.poolId,
      input.strategyId,
      input.asset.code,
      input.asset.scale,
      input.epoch,
    ],
  );
  const availableAtoms = BigInt(available.rows[0]?.available ?? '0');
  if (availableAtoms < input.atoms)
    return { ok: false, reason: 'INSUFFICIENT_AVAILABLE', availableAtoms };

  // The row first: the entries below reference it, and a reservation with no row would be a
  // RESERVED movement attributable to nothing.
  await client.query(
    `INSERT INTO reservations
       (workspace_id, pool_id, epoch, reservation_id, strategy_id, plan_id, asset_code, asset_scale, reserved_atoms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric)`,
    [
      input.workspaceId,
      input.poolId,
      input.epoch,
      input.reservationId,
      input.strategyId,
      input.planId,
      input.asset.code,
      input.asset.scale,
      input.atoms.toString(),
    ],
  );

  const posted = await LedgerRepository.postOn(client, {
    workspaceId: input.workspaceId,
    poolId: input.poolId,
    epoch: input.epoch,
    ledgerTxnId: `txn-reserve-${input.reservationId}`,
    source: { kind: 'reserve', ref: input.reservationId },
    description: `reserve ${input.reservationId} for ${input.planId}`,
    entries: [
      {
        accountKind: 'STRATEGY',
        owner: input.strategyId,
        claimState: 'AVAILABLE',
        asset: input.asset,
        deltaAtoms: -input.atoms,
      },
      {
        accountKind: 'STRATEGY',
        owner: input.strategyId,
        claimState: 'RESERVED',
        asset: input.asset,
        deltaAtoms: input.atoms,
        reservationId: input.reservationId,
      },
    ],
  });
  if (!posted.ok) {
    if (posted.reason === 'SOURCE_ALREADY_POSTED') return posted;
    throw new Error(`reservation posting refused: ${posted.reason}`);
  }
  return { ok: true, revision: posted.revision };
}
