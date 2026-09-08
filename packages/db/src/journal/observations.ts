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
  { readonly kind: 'recorded' } | { readonly kind: 'duplicate'; readonly observationId: string };

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

  /** Persist a source fact. The same fact from the same source is recorded once. */
  record(input: RecordObservationInput): Promise<RecordObservationOutcome> {
    return serializable(this.pool, async (client): Promise<RecordObservationOutcome> => {
      const existing = await client.query<{ observation_id: string }>(
        `SELECT observation_id FROM raw_observations
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3 AND source = $4 AND kind = $5 AND source_ref = $6`,
        [input.workspaceId, input.poolId, input.epoch, input.source, input.kind, input.sourceRef],
      );
      const duplicate = existing.rows[0];
      if (duplicate !== undefined)
        return { kind: 'duplicate', observationId: duplicate.observation_id };
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
          digestOf(input.payload, input.rawText),
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

  async recordOrder(input: RecordOrderInput): Promise<RecordOutcome> {
    const inserted = await this.pool.query(
      `INSERT INTO venue_orders (workspace_id, pool_id, epoch, symbol, venue_order_id, client_order_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, pool_id, epoch, symbol, venue_order_id) DO NOTHING`,
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
    return inserted.rowCount === 1 ? { kind: 'recorded' } : { kind: 'already-recorded' };
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
