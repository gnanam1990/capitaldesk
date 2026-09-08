import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { LedgerRepository, type LedgerEntryInput } from './ledger.js';
import { serializable } from './transaction.js';

/**
 * Raw observations, venue orders and fills.
 *
 * An observation is what a source said, verbatim, once. Applying it to the ledger is a later,
 * separate act recorded on the row, so a crash between the two leaves a replayable fact
 * (T-030). Orders and fills carry the complete identity - pool, epoch, symbol, venue ids -
 * so an id the venue reused in another scope is another row, never a collision (T-031).
 */

export interface RecordObservationInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly observationId: string;
  readonly source: 'rest' | 'stream' | 'operator';
  readonly kind: string;
  readonly sourceRef: string;
  readonly sourceEventTime: Date | null;
  readonly payload: unknown;
  /**
   * The bytes as received, when the adapter has them. The digest is taken over these; without
   * them it is taken over the stored serialisation of `payload`.
   */
  readonly rawText?: string;
}

export type RecordObservationOutcome =
  | { readonly kind: 'recorded' }
  /** Byte-for-byte the same fact already recorded. Nothing is written. */
  | { readonly kind: 'duplicate'; readonly observationId: string }
  /**
   * The same source reference carrying different evidence. The stored row is kept and a
   * conflict is recorded for the incident path; this is never reported as a duplicate.
   */
  | { readonly kind: 'conflict'; readonly observationId: string; readonly conflictId: string };

export interface ApplyObservationInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly observationId: string;
  readonly ledger: {
    readonly ledgerTxnId: string;
    readonly source: { readonly kind: string; readonly ref: string };
    readonly description: string;
    readonly entries: readonly LedgerEntryInput[];
  };
}

export type ApplyObservationOutcome =
  | { readonly kind: 'applied'; readonly revision: number }
  | { readonly kind: 'already-applied'; readonly ledgerTxnId: string }
  | { readonly kind: 'unknown-observation' };

export interface ApplyHooks {
  /** Test seam: runs after the ledger posting and before the observation is marked applied. */
  readonly afterLedgerPost?: () => Promise<void>;
}

export type VenueOrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'PENDING_CANCEL'
  | 'EXPIRED'
  | 'EXPIRED_IN_MATCH'
  | 'REJECTED'
  | 'UNSUPPORTED_OBSERVATION';

export interface RecordOrderInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly symbol: string;
  readonly venueOrderId: string;
  readonly clientOrderId?: string;
  readonly status: VenueOrderStatus;
}

export interface RecordFillInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly symbol: string;
  readonly venueOrderId: string;
  readonly venueTradeId: string;
  readonly observationId: string;
  readonly baseAtoms: bigint;
  readonly quoteAtoms: bigint;
  readonly commission: {
    readonly asset: { readonly code: string; readonly scale: string };
    readonly atoms: bigint;
  };
  readonly tradedAt: Date;
}

export type RecordOutcome = { readonly kind: 'recorded' } | { readonly kind: 'already-recorded' };
export type RecordFillOutcome = RecordOutcome | { readonly kind: 'unknown-order' };

export type RecordOrderOutcome =
  | { readonly kind: 'recorded' }
  /** The same status again. */
  | { readonly kind: 'duplicate' }
  /** The order advanced; the row now carries the newer status. */
  | {
      readonly kind: 'progressed';
      readonly from: VenueOrderStatus;
      readonly to: VenueOrderStatus;
      readonly version: number;
    }
  /** An older status arriving late. Out of order, not a contradiction; nothing is rewritten. */
  | { readonly kind: 'stale'; readonly current: VenueOrderStatus }
  /**
   * Two different terminal statuses for one order, or an unsupported status where a known one
   * is stored. Recorded as conflict evidence; the stored status is kept.
   */
  | {
      readonly kind: 'conflict';
      readonly current: VenueOrderStatus;
      readonly incoming: VenueOrderStatus;
      readonly conflictId: string;
    };

/**
 * How far through its life a status places an order.
 *
 * Ranks, not a transition table: the venue is the authority on its own order, and we are
 * observing it through two sources that can deliver out of order. What we can say is that an
 * order does not go backwards, and that it does not reach two different ends.
 */
const STATUS_RANK: Readonly<Record<VenueOrderStatus, number>> = {
  NEW: 0,
  PARTIALLY_FILLED: 1,
  PENDING_CANCEL: 2,
  FILLED: 3,
  CANCELED: 3,
  EXPIRED: 3,
  EXPIRED_IN_MATCH: 3,
  REJECTED: 3,
  // Never overwrites a known status: an unrecognised one is preserved as evidence with a
  // fail-closed disposition rather than mapped onto the nearest familiar thing (ADR-0004).
  UNSUPPORTED_OBSERVATION: -1,
};
const TERMINAL_RANK = 3;

/**
 * Digest of the evidence as stored.
 *
 * Not the canonical money encoding: that refuses JSON numbers by design, and a venue response
 * is full of them. Evidence is what the source said, so its digest is over the bytes received
 * when the adapter supplies them, and otherwise over the serialisation that is persisted.
 * Deduplication does not depend on this digest - it is by source reference - so the digest
 * is a fixity check on the stored row, not an identity.
 */
function digestOf(payload: unknown, rawText: string | undefined): string {
  return createHash('sha256')
    .update(rawText ?? JSON.stringify(payload))
    .digest('hex');
}

export class ObservationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Persist a source fact.
   *
   * A repeat of the same fact is recorded once. A *different* payload under the same source
   * reference is not a repeat: the source has said two contradictory things about one fact,
   * and treating that as an ordinary duplicate silently discarded the second statement. The
   * stored evidence is still never overwritten, but the contradiction is recorded durably as
   * conflict evidence for the incident path to resolve.
   */
  record(input: RecordObservationInput): Promise<RecordObservationOutcome> {
    return serializable(this.pool, async (client): Promise<RecordObservationOutcome> => {
      const digest = digestOf(input.payload, input.rawText);
      const existing = await client.query<{
        observation_id: string;
        payload_digest: string;
        payload: unknown;
      }>(
        `SELECT observation_id, payload_digest, payload FROM raw_observations
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND source = $4 AND kind = $5 AND source_ref = $6
          FOR UPDATE`,
        [input.workspaceId, input.poolId, input.epoch, input.source, input.kind, input.sourceRef],
      );
      const stored = existing.rows[0];
      if (stored !== undefined) {
        if (stored.payload_digest === digest) {
          return { kind: 'duplicate', observationId: stored.observation_id };
        }
        const conflict = await client.query<{ conflict_id: string }>(
          `INSERT INTO evidence_conflicts
             (workspace_id, pool_id, epoch, subject_kind, subject_ref, stored, incoming)
           VALUES ($1, $2, $3, 'observation', $4, $5::jsonb, $6::jsonb)
           RETURNING conflict_id::text`,
          [
            input.workspaceId,
            input.poolId,
            input.epoch,
            stored.observation_id,
            JSON.stringify({ payload: stored.payload, digest: stored.payload_digest }),
            JSON.stringify({
              payload: input.payload,
              digest,
              source: input.source,
              kind: input.kind,
              sourceRef: input.sourceRef,
            }),
          ],
        );
        return {
          kind: 'conflict',
          observationId: stored.observation_id,
          conflictId: conflict.rows[0]?.conflict_id ?? '',
        };
      }
      await client.query(
        `INSERT INTO raw_observations
           (workspace_id, pool_id, epoch, observation_id, source, kind, source_ref, source_event_time, payload, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.observationId,
          input.source,
          input.kind,
          input.sourceRef,
          input.sourceEventTime,
          JSON.stringify(input.payload),
          digest,
        ],
      );
      return { kind: 'recorded' };
    });
  }

  /**
   * Post an observation's ledger effect and mark it applied, together.
   *
   * Idempotent across a crash: a second application finds the row already applied, and even a
   * writer that lost that race is stopped by the ledger's unique source operation.
   */
  apply(input: ApplyObservationInput, hooks: ApplyHooks = {}): Promise<ApplyObservationOutcome> {
    return serializable(this.pool, async (client): Promise<ApplyObservationOutcome> => {
      const observation = await client.query<{
        epoch: number;
        applied_ledger_txn_id: string | null;
      }>(
        `SELECT epoch, applied_ledger_txn_id FROM raw_observations
          WHERE workspace_id = $1 AND pool_id = $2 AND observation_id = $3 FOR UPDATE`,
        [input.workspaceId, input.poolId, input.observationId],
      );
      const row = observation.rows[0];
      if (row === undefined) return { kind: 'unknown-observation' };
      if (row.applied_ledger_txn_id !== null)
        return { kind: 'already-applied', ledgerTxnId: row.applied_ledger_txn_id };

      const posted = await LedgerRepository.postOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        epoch: row.epoch,
        ledgerTxnId: input.ledger.ledgerTxnId,
        source: input.ledger.source,
        description: input.ledger.description,
        entries: input.ledger.entries,
      });
      if (!posted.ok) {
        if (posted.reason === 'SOURCE_ALREADY_POSTED') {
          // The effect exists but the observation was not marked: a crash landed between the
          // two in some earlier, non-transactional writer. Reconcile the record to the fact.
          await client.query(
            `UPDATE raw_observations SET applied_ledger_txn_id = $4
              WHERE workspace_id = $1 AND pool_id = $2 AND observation_id = $3`,
            [input.workspaceId, input.poolId, input.observationId, posted.ledgerTxnId],
          );
          return { kind: 'already-applied', ledgerTxnId: posted.ledgerTxnId };
        }
        throw new Error(
          `observation ${input.observationId} could not be applied: ${posted.reason}`,
        );
      }
      await hooks.afterLedgerPost?.();
      await client.query(
        `UPDATE raw_observations SET applied_ledger_txn_id = $4
          WHERE workspace_id = $1 AND pool_id = $2 AND observation_id = $3`,
        [input.workspaceId, input.poolId, input.observationId, input.ledger.ledgerTxnId],
      );
      return { kind: 'applied', revision: posted.revision };
    });
  }

  /**
   * Record what the venue says about an order.
   *
   * `ON CONFLICT DO NOTHING` made every observation after the first a no-op, so an order
   * observed as NEW stayed NEW through PARTIALLY_FILLED and FILLED: the status, the last
   * observation time and the version never moved. The policy is explicit instead - advance,
   * repeat, arrive late, or contradict - and only the first of those writes.
   */
  recordOrder(input: RecordOrderInput): Promise<RecordOrderOutcome> {
    return serializable(this.pool, async (client): Promise<RecordOrderOutcome> => {
      const existing = await client.query<{ status: VenueOrderStatus; version: number }>(
        `SELECT status, version FROM venue_orders
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4 AND venue_order_id = $5
          FOR UPDATE`,
        [input.workspaceId, input.poolId, input.epoch, input.symbol, input.venueOrderId],
      );
      const stored = existing.rows[0];
      if (stored === undefined) {
        await client.query(
          `INSERT INTO venue_orders (workspace_id, pool_id, epoch, symbol, venue_order_id, client_order_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.workspaceId,
            input.poolId,
            input.epoch,
            input.symbol,
            input.venueOrderId,
            input.clientOrderId ?? null,
            input.status,
          ],
        );
        return { kind: 'recorded' };
      }
      if (stored.status === input.status) {
        await client.query(
          `UPDATE venue_orders SET last_observed_at = now()
            WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4 AND venue_order_id = $5`,
          [input.workspaceId, input.poolId, input.epoch, input.symbol, input.venueOrderId],
        );
        return { kind: 'duplicate' };
      }

      const current = STATUS_RANK[stored.status];
      const incoming = STATUS_RANK[input.status];
      const contradicts =
        (current === TERMINAL_RANK && incoming === TERMINAL_RANK) || incoming < 0 || current < 0;
      if (contradicts) {
        const conflict = await client.query<{ conflict_id: string }>(
          `INSERT INTO evidence_conflicts
             (workspace_id, pool_id, epoch, subject_kind, subject_ref, stored, incoming)
           VALUES ($1, $2, $3, 'order-status', $4, $5::jsonb, $6::jsonb)
           RETURNING conflict_id::text`,
          [
            input.workspaceId,
            input.poolId,
            input.epoch,
            `${input.symbol}/${input.venueOrderId}`,
            JSON.stringify({ status: stored.status }),
            JSON.stringify({ status: input.status }),
          ],
        );
        return {
          kind: 'conflict',
          current: stored.status,
          incoming: input.status,
          conflictId: conflict.rows[0]?.conflict_id ?? '',
        };
      }
      if (incoming < current) return { kind: 'stale', current: stored.status };

      const version = stored.version + 1;
      await client.query(
        `UPDATE venue_orders
            SET status = $6, version = $7, last_observed_at = now(),
                client_order_id = coalesce(client_order_id, $8)
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4 AND venue_order_id = $5`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.symbol,
          input.venueOrderId,
          input.status,
          version,
          input.clientOrderId ?? null,
        ],
      );
      return { kind: 'progressed', from: stored.status, to: input.status, version };
    });
  }

  recordFill(input: RecordFillInput): Promise<RecordFillOutcome> {
    return serializable(this.pool, async (client): Promise<RecordFillOutcome> => {
      const order = await client.query(
        `SELECT 1 FROM venue_orders
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND symbol = $4 AND venue_order_id = $5`,
        [input.workspaceId, input.poolId, input.epoch, input.symbol, input.venueOrderId],
      );
      if (order.rowCount !== 1) return { kind: 'unknown-order' };
      const inserted = await client.query(
        `INSERT INTO venue_fills
           (workspace_id, pool_id, epoch, symbol, venue_order_id, venue_trade_id, observation_id,
            base_atoms, quote_atoms, commission_asset, commission_atoms, traded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, $11::numeric, $12)
         ON CONFLICT (workspace_id, pool_id, epoch, symbol, venue_order_id, venue_trade_id) DO NOTHING`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.symbol,
          input.venueOrderId,
          input.venueTradeId,
          input.observationId,
          input.baseAtoms.toString(),
          input.quoteAtoms.toString(),
          `${input.commission.asset.code}:${input.commission.asset.scale}`,
          input.commission.atoms.toString(),
          input.tradedAt,
        ],
      );
      return inserted.rowCount === 1 ? { kind: 'recorded' } : { kind: 'already-recorded' };
    });
  }
}
