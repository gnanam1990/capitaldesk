import type { Pool } from 'pg';
import { serializable, type Queryable } from './transaction.js';

/**
 * Durable state for the module 05 read boundary.
 *
 * The readers themselves are stateless. What must survive a restart is the position they had
 * reached and the cuts they assessed: ADR-0002 establishes backfill completeness by contiguous
 * cursor pagination, so a lost cursor is a window that can no longer be proven. Losing one
 * corrupts nothing, but it makes the affected window UNSUPPORTED, which stops dispatch — which
 * is why this is durable state rather than a cache.
 */

export interface CursorScope {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly symbol: string;
}

export interface TradeCursor {
  readonly symbol: string;
  /** The next `fromId` to request. Inclusive, so one past the highest id observed. */
  readonly nextFromId: string;
  readonly highestTradeId: string;
  readonly advancedByDigest: string;
  readonly version: number;
}

export type AdvanceCursorOutcome =
  | { readonly ok: true; readonly cursor: TradeCursor }
  /** The proposed cursor is not ahead of the stored one. */
  | {
      readonly ok: false;
      readonly reason: 'CURSOR_NOT_ADVANCING';
      readonly stored: string;
      readonly proposed: string;
    }
  | { readonly ok: false; readonly reason: 'UNKNOWN_EPOCH' };

const DIGITS = /^(0|[1-9][0-9]*)$/;

export class VenueReadRepository {
  constructor(private readonly pool: Pool) {}

  /** The stored cursor for one symbol, or null when this epoch has never read it. */
  async cursor(scope: CursorScope): Promise<TradeCursor | null> {
    const result = await this.pool.query<{
      symbol: string;
      next_from_id: string;
      highest_trade_id: string;
      advanced_by_digest: string;
      version: number;
    }>(
      `SELECT symbol, next_from_id, highest_trade_id, advanced_by_digest, version
         FROM venue_trade_cursors
        WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4`,
      [scope.workspaceId, scope.poolId, scope.epoch, scope.symbol],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          symbol: row.symbol,
          nextFromId: row.next_from_id,
          highestTradeId: row.highest_trade_id,
          advancedByDigest: row.advanced_by_digest,
          version: row.version,
        };
  }

  /**
   * Move a cursor forward, or refuse.
   *
   * Compared as integers, not as text: '9' sorts after '10' as a string, and a text comparison
   * would accept a rollback from 10 to 9 while rejecting a legitimate advance from 9 to 10.
   * The database refuses a rollback independently, so a writer that bypasses this method is
   * refused too.
   */
  async advance(
    scope: CursorScope,
    next: { readonly nextFromId: string; readonly highestTradeId: string; readonly digest: string },
  ): Promise<AdvanceCursorOutcome> {
    // `async` so this arrives as a rejection rather than a synchronous throw. A method that
    // returns a promise but throws before creating one is missed by every caller using
    // `.catch()`, which is exactly how a validation failure becomes silence.
    if (!DIGITS.test(next.nextFromId) || !DIGITS.test(next.highestTradeId)) {
      throw new TypeError('a trade cursor must be canonical digits');
    }
    return serializable(this.pool, async (client): Promise<AdvanceCursorOutcome> => {
      const epoch = await client.query(
        `SELECT 1 FROM baseline_epochs
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3`,
        [scope.workspaceId, scope.poolId, scope.epoch],
      );
      if (epoch.rowCount !== 1) return { ok: false, reason: 'UNKNOWN_EPOCH' };

      const existing = await client.query<{ next_from_id: string }>(
        `SELECT next_from_id FROM venue_trade_cursors
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4 FOR UPDATE`,
        [scope.workspaceId, scope.poolId, scope.epoch, scope.symbol],
      );
      const stored = existing.rows[0]?.next_from_id;
      if (stored !== undefined && BigInt(next.nextFromId) < BigInt(stored)) {
        return { ok: false, reason: 'CURSOR_NOT_ADVANCING', stored, proposed: next.nextFromId };
      }

      const written = await client.query<{ version: number }>(
        `INSERT INTO venue_trade_cursors
           (workspace_id, pool_id, epoch, symbol, next_from_id, highest_trade_id,
            advanced_by_digest, advanced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (workspace_id, pool_id, epoch, symbol) DO UPDATE
            SET next_from_id = EXCLUDED.next_from_id,
                highest_trade_id = EXCLUDED.highest_trade_id,
                advanced_by_digest = EXCLUDED.advanced_by_digest,
                advanced_at = now(),
                version = venue_trade_cursors.version + 1
         RETURNING version`,
        [
          scope.workspaceId,
          scope.poolId,
          scope.epoch,
          scope.symbol,
          next.nextFromId,
          next.highestTradeId,
          next.digest,
        ],
      );
      return {
        ok: true,
        cursor: {
          symbol: scope.symbol,
          nextFromId: next.nextFromId,
          highestTradeId: next.highestTradeId,
          advancedByDigest: next.digest,
          version: written.rows[0]?.version ?? 1,
        },
      };
    });
  }

  /** Record one bracket of a cut. Append-only: the database refuses an update or a delete. */
  async recordSnapshot(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly snapshotId: string;
    readonly stableAccountId: string;
    readonly requestedAt: string;
    readonly respondedAt: string;
    readonly sourceTime: string | null;
    readonly responseDigest: string;
    readonly balances: readonly { asset: string; freeAtoms: string; lockedAtoms: string }[];
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO venue_account_snapshots
         (workspace_id, pool_id, epoch, snapshot_id, stable_account_id, requested_at,
          responded_at, source_time, response_digest, balances)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        input.workspaceId,
        input.poolId,
        input.epoch,
        input.snapshotId,
        input.stableAccountId,
        input.requestedAt,
        input.respondedAt,
        input.sourceTime,
        input.responseDigest,
        JSON.stringify(input.balances),
      ],
    );
  }

  /** Record an assessed cut with its verdict and every unmet condition. */
  async recordCut(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly cutId: string;
    readonly windowFrom: string;
    readonly windowTo: string;
    readonly openingSnapshotId: string;
    readonly closingSnapshotId: string;
    readonly coverageState: string;
    readonly detectionScope: string;
    readonly unmet: readonly string[];
    readonly observedSymbols: readonly string[];
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO venue_observation_cuts
         (workspace_id, pool_id, epoch, cut_id, window_from, window_to, opening_snapshot_id,
          closing_snapshot_id, coverage_state, detection_scope, unmet, observed_symbols)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
      [
        input.workspaceId,
        input.poolId,
        input.epoch,
        input.cutId,
        input.windowFrom,
        input.windowTo,
        input.openingSnapshotId,
        input.closingSnapshotId,
        input.coverageState,
        input.detectionScope,
        JSON.stringify(input.unmet),
        JSON.stringify(input.observedSymbols),
      ],
    );
  }

  /** Every cursor this pool holds in this epoch, for a restart to resume from. */
  async cursors(scope: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
  }): Promise<readonly TradeCursor[]> {
    const result = await this.pool.query<{
      symbol: string;
      next_from_id: string;
      highest_trade_id: string;
      advanced_by_digest: string;
      version: number;
    }>(
      `SELECT symbol, next_from_id, highest_trade_id, advanced_by_digest, version
         FROM venue_trade_cursors
        WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3
        ORDER BY symbol`,
      [scope.workspaceId, scope.poolId, scope.epoch],
    );
    return result.rows.map((row) => ({
      symbol: row.symbol,
      nextFromId: row.next_from_id,
      highestTradeId: row.highest_trade_id,
      advancedByDigest: row.advanced_by_digest,
      version: row.version,
    }));
  }
}

/** Read a cursor on a caller's client, for a transaction that spans more than this. */
export async function cursorOn(client: Queryable, scope: CursorScope): Promise<TradeCursor | null> {
  const result = await client.query<{
    symbol: string;
    next_from_id: string;
    highest_trade_id: string;
    advanced_by_digest: string;
    version: number;
  }>(
    `SELECT symbol, next_from_id, highest_trade_id, advanced_by_digest, version
       FROM venue_trade_cursors
      WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4`,
    [scope.workspaceId, scope.poolId, scope.epoch, scope.symbol],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        symbol: row.symbol,
        nextFromId: row.next_from_id,
        highestTradeId: row.highest_trade_id,
        advancedByDigest: row.advanced_by_digest,
        version: row.version,
      };
}
