import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CoverageAssessment } from '@capitaldesk/contracts';
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

/**
 * The only ways read state is written.
 *
 * `advance` was public and moved a cursor with no page evidence behind it — precisely what
 * `recordPageAndAdvance` exists to make impossible. Single-snapshot and single-cut writers were
 * public too, so a caller could leave a bracket with no cut, or a cut with no brackets. All
 * three are gone. A table constraint is exercised by SQL through the test harness, which is
 * where a test of a table constraint belongs.
 */
export type ScopeCheckOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'UNKNOWN_POOL' | 'NO_OPEN_EPOCH' }
  | {
      readonly ok: false;
      readonly reason: 'ACCOUNT_MISMATCH' | 'ENVIRONMENT_MISMATCH';
      readonly expected: string;
      readonly observed: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'EPOCH_NOT_CURRENT';
      readonly expected: number;
      readonly observed: number;
    };

/** One trade whose stored evidence and incoming evidence disagree. */
export interface TradeConflict {
  readonly venueTradeId: string;
  readonly conflictId: string;
}

export type RecordPageOutcome =
  | {
      readonly ok: true;
      readonly cursor: TradeCursor | null;
      readonly recorded: number;
      readonly duplicates: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'EVIDENCE_CONTRADICTORY';
      readonly conflicts: readonly TradeConflict[];
      readonly recorded: number;
      readonly duplicates: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'CURSOR_NOT_ADVANCING' | 'UNKNOWN_EPOCH' | 'EPOCH_CLOSED';
      readonly stored?: string;
      readonly proposed?: string;
      readonly recorded: number;
      readonly duplicates: number;
    };

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

/**
 * Canonical bytes for one trade payload.
 *
 * Keys sorted, so two encodings of the same fact digest identically and a genuine change
 * digests differently. `JSON.stringify` alone depends on insertion order, which would make a
 * re-read of the same trade look like a contradiction.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * A bounded, deterministic observation id for one trade.
 *
 * `raw_observations.observation_id` is capped at 64 characters by its shape CHECK. A symbol
 * and a venue trade id can exceed that together, and the insert would then fail *after* the
 * page had partly succeeded, so the id is truncated with a digest suffix that keeps it unique.
 */
function observationIdFor(symbol: string, venueTradeId: string): string {
  const plain = `trade-${symbol}-${venueTradeId}`;
  if (plain.length <= 64) return plain;
  const suffix = createHash('sha256').update(plain).digest('hex').slice(0, 16);
  return `${plain.slice(0, 47)}-${suffix}`;
}
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
    /**
     * The verdict, as the shared predicate produced it.
     *
     * The typed `CoverageAssessment`, not three strings. A caller that can name its own
     * verdict does not need the predicate, and the string form let `COMPLETE` be written
     * beside a list of unmet conditions — the one contradiction the table's CHECKs exist to
     * make unstorable.
     */
    readonly assessment: CoverageAssessment;
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

  /**
   * Refuse a reader whose provenance does not describe this pool, before anything is written.
   *
   * Every later write is scoped by workspace, pool and epoch, and the snapshot foreign keys
   * catch a bad scope eventually — but "eventually" is after a page of trade evidence has
   * already been written under it. This is the check that runs first: the pool's governing
   * account, its environment, and the epoch actually open for it, compared against what the
   * reader proved.
   */
  async assertReaderScope(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    /** The epoch the writes will be scoped by. */
    readonly scopeEpoch: number;
    /**
     * The epoch the reader stamps onto its own observations.
     *
     * Compared separately from `scopeEpoch`. Checking only the scope let a reader on epoch 99
     * write a page under scope epoch 1: the writes were consistent with themselves, and the
     * evidence they carried named a different epoch entirely.
     */
    readonly readerEpoch: number;
    readonly provenAccountId: string;
    readonly environment: string;
  }): Promise<ScopeCheckOutcome> {
    const pool = await this.pool.query<{
      stable_account_id: string;
      environment: string;
    }>(
      `SELECT stable_account_id, environment FROM pools
        WHERE workspace_id = $1 AND pool_id = $2`,
      [input.workspaceId, input.poolId],
    );
    const row = pool.rows[0];
    if (row === undefined) return { ok: false, reason: 'UNKNOWN_POOL' };
    if (row.stable_account_id !== input.provenAccountId) {
      return {
        ok: false,
        reason: 'ACCOUNT_MISMATCH',
        expected: row.stable_account_id,
        observed: input.provenAccountId,
      };
    }
    if (row.environment !== input.environment) {
      return {
        ok: false,
        reason: 'ENVIRONMENT_MISMATCH',
        expected: row.environment,
        observed: input.environment,
      };
    }
    const epoch = await this.pool.query<{ epoch: number }>(
      `SELECT epoch FROM baseline_epochs
        WHERE workspace_id = $1 AND pool_id = $2 AND closed_at IS NULL`,
      [input.workspaceId, input.poolId],
    );
    const open = epoch.rows[0]?.epoch;
    if (open === undefined) return { ok: false, reason: 'NO_OPEN_EPOCH' };
    // Both claims, against the one epoch the database says is open.
    for (const observed of [input.scopeEpoch, input.readerEpoch]) {
      if (open !== observed) {
        return { ok: false, reason: 'EPOCH_NOT_CURRENT', expected: open, observed };
      }
    }
    return { ok: true };
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
  async recordPageAndAdvance(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly symbol: string;
    readonly trades: readonly { readonly venueTradeId: string; readonly payload: unknown }[];
    readonly cursor: {
      readonly nextFromId: string;
      readonly highestTradeId: string;
      readonly digest: string;
    } | null;
  }): Promise<RecordPageOutcome> {
    if (input.cursor !== null) assertCursorShape(input.cursor);
    return serializable(this.pool, async (client): Promise<RecordPageOutcome> => {
      const conflicts: TradeConflict[] = [];
      let recorded = 0;
      let duplicates = 0;

      for (const trade of input.trades) {
        const sourceRef = `${input.symbol}:${trade.venueTradeId}`;
        // Per trade, over that trade's own canonical bytes. Stamping the whole page's response
        // digest onto every row made two different trades compare equal to each other and made
        // a corrected record indistinguishable from the original.
        const digest = createHash('sha256').update(canonicalJson(trade.payload)).digest('hex');

        const existing = await client.query<{
          observation_id: string;
          payload_digest: string;
          payload: unknown;
        }>(
          `SELECT observation_id, payload_digest, payload FROM raw_observations
            WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3
              AND source = 'rest' AND kind = 'venue_trade' AND source_ref = $4
            FOR UPDATE`,
          [input.workspaceId, input.poolId, input.epoch, sourceRef],
        );
        const stored = existing.rows[0];
        if (stored !== undefined) {
          if (stored.payload_digest === digest) {
            // The same fact delivered twice. One effect, no conflict — the journal's existing
            // dedupe boundary, not a new one.
            duplicates += 1;
            continue;
          }
          // A *different* payload under the same scoped trade id. Immutable evidence does not
          // change, so the contradiction is recorded and the stored row is left alone.
          const conflict = await client.query<{ conflict_id: string }>(
            `INSERT INTO evidence_conflicts
               (workspace_id, pool_id, epoch, subject_kind, subject_ref, stored, incoming)
             VALUES ($1, $2, $3, 'fill', $4, $5::jsonb, $6::jsonb)
             RETURNING conflict_id::text`,
            [
              input.workspaceId,
              input.poolId,
              input.epoch,
              sourceRef,
              JSON.stringify({ payload: stored.payload, digest: stored.payload_digest }),
              JSON.stringify({ payload: trade.payload, digest }),
            ],
          );
          conflicts.push({
            venueTradeId: trade.venueTradeId,
            conflictId: conflict.rows[0]?.conflict_id ?? '',
          });
          continue;
        }

        await client.query(
          `INSERT INTO raw_observations
             (workspace_id, pool_id, epoch, observation_id, source, kind, source_ref,
              source_event_time, payload, payload_digest)
           VALUES ($1, $2, $3, $4, 'rest', 'venue_trade', $5, $6, $7::jsonb, $8)`,
          [
            input.workspaceId,
            input.poolId,
            input.epoch,
            observationIdFor(input.symbol, trade.venueTradeId),
            sourceRef,
            (trade.payload as { tradedAt?: string }).tradedAt ?? null,
            JSON.stringify(trade.payload),
            digest,
          ],
        );
        recorded += 1;
      }

      if (conflicts.length > 0) {
        // The cursor does not move past a contradiction. Advancing would leave the disputed
        // trade behind a position that claims the range is settled, and the incident path
        // would have nothing to come back to.
        return { ok: false, reason: 'EVIDENCE_CONTRADICTORY', conflicts, recorded, duplicates };
      }
      if (input.cursor === null) return { ok: true, cursor: null, recorded, duplicates };
      const advanced = await advanceOn(client, input, input.cursor);
      return advanced.ok
        ? { ...advanced, recorded, duplicates }
        : { ...advanced, recorded, duplicates };
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
