import type { Pool } from 'pg';
import { transactional, type Queryable } from './transaction.js';

/**
 * The transactional outbox.
 *
 * A message is enqueued inside the transaction that makes the change it announces, so there
 * is no committed change without its message and no message without its change. Consumers
 * claim under a lease, then acknowledge or fail; failure past the attempt bound dead-letters
 * the message rather than retrying forever, and a dispatch message is single-attempt by
 * database constraint. Nothing is ever deleted.
 */

export interface EnqueueInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly outboxId: string;
  readonly kind: string;
  readonly payload: unknown;
  /** Default 5. Any `dispatch.*` kind must be 1, and the database refuses otherwise. */
  readonly maxAttempts?: number;
}

export interface ClaimedMessage {
  readonly outboxId: string;
  readonly kind: string;
  readonly payload: unknown;
  /** 1 for the first delivery. */
  readonly attempt: number;
}

export type AcknowledgeOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'NOT_HELD' };
export type FailOutcome =
  | { readonly kind: 'retry-later' }
  | { readonly kind: 'dead-lettered' }
  | { readonly kind: 'not-held' };

export class OutboxRepository {
  constructor(private readonly pool: Pool) {}

  /** Inside the caller's transaction, beside the change the message announces. */
  static async enqueueOn(client: Queryable, input: EnqueueInput): Promise<void> {
    await client.query(
      `INSERT INTO outbox (workspace_id, pool_id, outbox_id, kind, payload, max_attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        input.workspaceId,
        input.poolId,
        input.outboxId,
        input.kind,
        JSON.stringify(input.payload),
        input.maxAttempts ?? 5,
      ],
    );
  }

  /**
   * Claim the oldest deliverable message for this pool under a lease.
   *
   * SKIP LOCKED, so two consumers never contend on one row; a message whose lease has lapsed
   * without acknowledgement is deliverable again, and its attempt counter says so.
   */
  claim(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly consumerId: string;
    readonly leaseMs: number;
    readonly now: Date;
  }): Promise<ClaimedMessage | null> {
    return transactional(this.pool, async (client) => {
      const candidate = await client.query<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox
          WHERE workspace_id = $1 AND pool_id = $2
            AND published_at IS NULL AND dead_lettered_at IS NULL AND quarantined_at IS NULL
            AND (leased_until IS NULL OR leased_until <= $3)
          ORDER BY created_at, outbox_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [input.workspaceId, input.poolId, input.now],
      );
      const row = candidate.rows[0];
      if (row === undefined) return null;
      const leasedUntil = new Date(input.now.getTime() + input.leaseMs);
      const claimed = await client.query<{ kind: string; payload: unknown; attempts: number }>(
        `UPDATE outbox SET leased_by = $4, leased_until = $5, attempts = attempts + 1
          WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3
          RETURNING kind, payload, attempts`,
        [input.workspaceId, input.poolId, row.outbox_id, input.consumerId, leasedUntil],
      );
      const message = claimed.rows[0];
      if (message === undefined) return null;
      return {
        outboxId: row.outbox_id,
        kind: message.kind,
        payload: message.payload,
        attempt: message.attempts,
      };
    });
  }

  /** Only the consumer holding a live lease may acknowledge. A stale holder is refused. */
  async acknowledge(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly outboxId: string;
    readonly consumerId: string;
    readonly now: Date;
  }): Promise<AcknowledgeOutcome> {
    const updated = await this.pool.query(
      `UPDATE outbox SET published_at = $5, leased_by = NULL, leased_until = NULL
        WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3
          AND leased_by = $4 AND leased_until > $5 AND published_at IS NULL`,
      [input.workspaceId, input.poolId, input.outboxId, input.consumerId, input.now],
    );
    return updated.rowCount === 1 ? { ok: true } : { ok: false, reason: 'NOT_HELD' };
  }

  /** Release the message for another attempt, or dead-letter it when the bound is reached. */
  fail(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly outboxId: string;
    readonly consumerId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<FailOutcome> {
    return transactional(this.pool, async (client): Promise<FailOutcome> => {
      const held = await client.query<{ attempts: number; max_attempts: number }>(
        `SELECT attempts, max_attempts FROM outbox
          WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3
            AND leased_by = $4 AND published_at IS NULL AND dead_lettered_at IS NULL
          FOR UPDATE`,
        [input.workspaceId, input.poolId, input.outboxId, input.consumerId],
      );
      const row = held.rows[0];
      if (row === undefined) return { kind: 'not-held' };
      if (row.attempts >= row.max_attempts) {
        await client.query(
          `UPDATE outbox SET dead_lettered_at = $4, dead_letter_reason = $5, leased_by = NULL, leased_until = NULL
            WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3`,
          [input.workspaceId, input.poolId, input.outboxId, input.now, input.reason],
        );
        return { kind: 'dead-lettered' };
      }
      await client.query(
        `UPDATE outbox SET leased_by = NULL, leased_until = NULL
          WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3`,
        [input.workspaceId, input.poolId, input.outboxId],
      );
      return { kind: 'retry-later' };
    });
  }
}
