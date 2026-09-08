import type { Pool } from 'pg';
import { transactional, type Queryable } from './transaction.js';

/**
 * The transactional outbox.
 *
 * A message is enqueued inside the transaction that makes the change it announces, so there
 * is no committed change without its message and no message without its change. Consumers
 * claim under a lease, then acknowledge or fail; a message that fails past its attempt bound
 * is dead-lettered rather than retried forever, and nothing is ever deleted.
 *
 * Every expiry decision reads the database clock. A caller's `now` was an argument, which
 * meant a consumer with a fast clock could declare another consumer's lease lapsed and take a
 * message that was still held. There is now no way to express that.
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
  /** 1 for the first delivery. Never exceeds the message's attempt bound. */
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
   * A message whose lease lapsed without an acknowledgement is only re-offered while it has
   * attempts left. When it does not, its holder consumed the last one and vanished, so the
   * outcome of that attempt is unknown: the message is dead-lettered with that reason rather
   * than delivered again or left pending forever.
   *
   * For a `dispatch.*` message the bound is one, so this is the rule that makes a second
   * delivery impossible. Before it, a crashed executor's send message was handed to the next
   * consumer as attempt 2 — the one thing an order-placement queue must never do.
   */
  claim(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly consumerId: string;
    readonly leaseMs: number;
  }): Promise<ClaimedMessage | null> {
    return transactional(this.pool, async (client) => {
      // Retire anything whose lease lapsed with no attempts left, before looking for work.
      await client.query(
        `UPDATE outbox
            SET dead_lettered_at = now(),
                dead_letter_reason = 'lease expired with no attempts remaining; the outcome of the last attempt is unknown',
                leased_by = NULL, leased_until = NULL
          WHERE workspace_id = $1 AND pool_id = $2
            AND published_at IS NULL AND dead_lettered_at IS NULL AND quarantined_at IS NULL
            AND attempts >= max_attempts
            AND (leased_until IS NULL OR leased_until <= now())`,
        [input.workspaceId, input.poolId],
      );

      const candidate = await client.query<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox
          WHERE workspace_id = $1 AND pool_id = $2
            AND published_at IS NULL AND dead_lettered_at IS NULL AND quarantined_at IS NULL
            AND attempts < max_attempts
            AND (leased_until IS NULL OR leased_until <= now())
          ORDER BY created_at, outbox_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [input.workspaceId, input.poolId],
      );
      const row = candidate.rows[0];
      if (row === undefined) return null;

      const claimed = await client.query<{ kind: string; payload: unknown; attempts: number }>(
        `UPDATE outbox
            SET leased_by = $3, leased_until = now() + ($5::bigint * interval '1 millisecond'),
                attempts = attempts + 1
          WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $4
          RETURNING kind, payload, attempts`,
        [input.workspaceId, input.poolId, input.consumerId, row.outbox_id, input.leaseMs],
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

  /** Only the consumer holding a live lease may acknowledge. */
  async acknowledge(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly outboxId: string;
    readonly consumerId: string;
  }): Promise<AcknowledgeOutcome> {
    const updated = await this.pool.query(
      `UPDATE outbox SET published_at = now(), leased_by = NULL, leased_until = NULL
        WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3
          AND leased_by = $4 AND leased_until > now() AND published_at IS NULL`,
      [input.workspaceId, input.poolId, input.outboxId, input.consumerId],
    );
    return updated.rowCount === 1 ? { ok: true } : { ok: false, reason: 'NOT_HELD' };
  }

  /**
   * Release the message for another attempt, or dead-letter it when the bound is reached.
   *
   * Refused for a holder whose lease has lapsed, exactly as `acknowledge` refuses one: a
   * resumed consumer must not disturb the lease another consumer now holds.
   */
  fail(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly outboxId: string;
    readonly consumerId: string;
    readonly reason: string;
  }): Promise<FailOutcome> {
    return transactional(this.pool, async (client): Promise<FailOutcome> => {
      const held = await client.query<{ attempts: number; max_attempts: number }>(
        `SELECT attempts, max_attempts FROM outbox
          WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3
            AND leased_by = $4 AND leased_until > now()
            AND published_at IS NULL AND dead_lettered_at IS NULL
          FOR UPDATE`,
        [input.workspaceId, input.poolId, input.outboxId, input.consumerId],
      );
      const row = held.rows[0];
      if (row === undefined) return { kind: 'not-held' };
      if (row.attempts >= row.max_attempts) {
        await client.query(
          `UPDATE outbox SET dead_lettered_at = now(), dead_letter_reason = $4, leased_by = NULL, leased_until = NULL
            WHERE workspace_id = $1 AND pool_id = $2 AND outbox_id = $3`,
          [input.workspaceId, input.poolId, input.outboxId, input.reason],
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
