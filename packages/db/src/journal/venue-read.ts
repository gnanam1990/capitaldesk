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

/** One bracket of a cut, as the reader observed it. */
export interface SnapshotRecord {
  readonly snapshotId: string;
  readonly stableAccountId: string;
  readonly requestedAt: string;
  readonly respondedAt: string;
  readonly sourceTime: string | null;
  readonly responseDigest: string;
  readonly balances: readonly {
    readonly asset: string;
    readonly freeAtoms: string;
    readonly lockedAtoms: string;
  }[];
}

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
  | { readonly ok: false; readonly reason: 'UNKNOWN_EPOCH' }
  /** The epoch exists but a reset closed it; read state may not be written to it. */
  | { readonly ok: false; readonly reason: 'EPOCH_CLOSED' };

const DIGITS = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The atom magnitude this system supports, matching the money contract and the CHECK. */
const MAX_ID_DIGITS = 78;

function assertCursorShape(next: {
  readonly nextFromId: string;
  readonly highestTradeId: string;
  readonly digest: string;
}): void {
  for (const [field, value] of [
    ['nextFromId', next.nextFromId],
    ['highestTradeId', next.highestTradeId],
  ] as const) {
    if (!DIGITS.test(value)) {
      throw new TypeError(`${field} must be canonical digits`);
    }
    if (value.length > MAX_ID_DIGITS) {
      throw new RangeError(`${field} exceeds the ${String(MAX_ID_DIGITS)}-digit bound`);
    }
  }
  // `fromId` is inclusive, so the next request starts exactly one past the highest id actually
  // observed. Any other pair either re-reads a booked trade or skips one, and both look like a
  // legitimate cursor afterwards.
  if (BigInt(next.nextFromId) !== BigInt(next.highestTradeId) + 1n) {
    throw new RangeError(
      `nextFromId ${next.nextFromId} is not one past highestTradeId ${next.highestTradeId}`,
    );
  }
  // The digest is the evidence that moved the cursor. An unverifiable one makes the trail
  // decorative.
  if (!DIGEST.test(next.digest)) {
    throw new TypeError('advancing digest must be a sha256 reference');
  }
}

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
    assertCursorShape(next);
    return serializable(this.pool, (client) => advanceOn(client, scope, next));
  }

  /**
   * Both brackets and the assessed cut, in one transaction.
   *
   * A cut whose snapshots are missing is not evidence of anything, and snapshots with no cut
   * are two readings nobody drew a conclusion from. Writing them separately leaves either
   * outcome reachable through an ordinary crash, so all three commit together or none does.
   *
   * The verdict is the typed `CoverageAssessment` produced by the shared predicate, not a
   * caller-supplied string. Accepting a string would let a caller write `COMPLETE` beside a
   * list of unmet conditions, which is the one contradiction the table's CHECKs exist to make
   * unstorable — and a caller that can name its own verdict does not need the predicate.
   */
  recordAssessedCut(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly cutId: string;
    readonly opening: SnapshotRecord;
    readonly closing: SnapshotRecord;
    readonly assessment: {
      readonly state: string;
      readonly unmet: readonly string[];
      readonly detectionScope: string;
    };
    readonly observedSymbols: readonly string[];
  }): Promise<void> {
    return serializable(this.pool, async (client) => {
      await insertSnapshot(client, input.workspaceId, input.poolId, input.epoch, input.opening);
      await insertSnapshot(client, input.workspaceId, input.poolId, input.epoch, input.closing);
      await client.query(
        `INSERT INTO venue_observation_cuts
           (workspace_id, pool_id, epoch, cut_id, window_from, window_to, opening_snapshot_id,
            closing_snapshot_id, coverage_state, detection_scope, unmet, observed_symbols)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.cutId,
          input.opening.requestedAt,
          input.closing.respondedAt,
          input.opening.snapshotId,
          input.closing.snapshotId,
          input.assessment.state,
          input.assessment.detectionScope,
          JSON.stringify(input.assessment.unmet),
          JSON.stringify(input.observedSymbols),
        ],
      );
    });
  }

  /** Every cursor this pool holds in this epoch, for a restart to resume from. */
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

  /**
   * One page of trade evidence and the cursor advance, in one transaction.
   *
   * Advancing the cursor separately from recording what the page contained is the shape of bug
   * that loses history silently: the cursor moves, the process dies before the trades are
   * durable, and the next run resumes past a page nothing ever recorded. Neither half is
   * useful without the other, so neither commits without the other.
   *
   * Observations are keyed by the venue trade id under `source = 'rest'`, so a page delivered
   * twice records once — the journal's existing dedupe boundary, not a new one.
   */
  recordPageAndAdvance(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly symbol: string;
    readonly trades: readonly {
      readonly venueTradeId: string;
      readonly payload: unknown;
      readonly payloadDigest: string;
      readonly tradedAt: string;
    }[];
    readonly cursor: {
      readonly nextFromId: string;
      readonly highestTradeId: string;
      readonly digest: string;
    } | null;
  }): Promise<AdvanceCursorOutcome | { readonly ok: true; readonly cursor: null }> {
    if (input.cursor !== null) assertCursorShape(input.cursor);
    return serializable(this.pool, async (client) => {
      for (const trade of input.trades) {
        await client.query(
          `INSERT INTO raw_observations
             (workspace_id, pool_id, epoch, observation_id, source, kind, source_ref,
              source_event_time, payload, payload_digest)
           VALUES ($1, $2, $3, $4, 'rest', 'venue_trade', $5, $6, $7::jsonb, $8)
           ON CONFLICT (workspace_id, pool_id, epoch, source, kind, source_ref) DO NOTHING`,
          [
            input.workspaceId,
            input.poolId,
            input.epoch,
            `trade-${input.symbol}-${trade.venueTradeId}`,
            `${input.symbol}:${trade.venueTradeId}`,
            trade.tradedAt,
            JSON.stringify(trade.payload),
            trade.payloadDigest,
          ],
        );
      }
      if (input.cursor === null) return { ok: true as const, cursor: null };
      return advanceOn(client, input, input.cursor);
    });
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

/**
 * The cursor advance, on a caller's client.
 *
 * Shared by `advance` and `recordPageAndAdvance` so the two entry points cannot drift: the
 * atomic one exists precisely because the cursor must not move without its evidence, and a
 * second copy of the forward-only rule would eventually disagree with the first.
 */
async function advanceOn(
  client: Queryable,
  scope: CursorScope,
  next: { readonly nextFromId: string; readonly highestTradeId: string; readonly digest: string },
): Promise<AdvanceCursorOutcome> {
  const epoch = await client.query<{ closed_at: Date | null }>(
    `SELECT closed_at FROM baseline_epochs
      WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3`,
    [scope.workspaceId, scope.poolId, scope.epoch],
  );
  const row = epoch.rows[0];
  if (row === undefined) return { ok: false, reason: 'UNKNOWN_EPOCH' };
  // A closed epoch is one a reset invalidated. Advancing its cursor would attribute
  // post-reset evidence to the account that existed before it.
  if (row.closed_at !== null) return { ok: false, reason: 'EPOCH_CLOSED' };

  const existing = await client.query<{ next_from_id: string }>(
    `SELECT next_from_id FROM venue_trade_cursors
      WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4 FOR UPDATE`,
    [scope.workspaceId, scope.poolId, scope.epoch, scope.symbol],
  );
  const stored = existing.rows[0]?.next_from_id;
  // Strictly forward. An equal cursor that rewrote the digest, the highest id and the version
  // recorded a new advance for a position that had not moved, so the evidence trail claimed a
  // page had been read when none had.
  if (stored !== undefined && BigInt(next.nextFromId) <= BigInt(stored)) {
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
}

/** One snapshot insert, on a caller's client. */
async function insertSnapshot(
  client: Queryable,
  workspaceId: string,
  poolId: string,
  epoch: number,
  snapshot: SnapshotRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO venue_account_snapshots
       (workspace_id, pool_id, epoch, snapshot_id, stable_account_id, requested_at,
        responded_at, source_time, response_digest, balances)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      workspaceId,
      poolId,
      epoch,
      snapshot.snapshotId,
      snapshot.stableAccountId,
      snapshot.requestedAt,
      snapshot.respondedAt,
      snapshot.sourceTime,
      snapshot.responseDigest,
      JSON.stringify(snapshot.balances),
    ],
  );
}
