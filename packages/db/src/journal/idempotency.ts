import type { Pool } from 'pg';
import type { Queryable } from './transaction.js';

/**
 * Idempotency records and economic tombstones (INV-11; TDD section 11).
 *
 * One row per scope and key, forever. The same request body replays the stored response; a
 * different body under the same key is a durable conflict. The stored response may be
 * discarded after its retention lapses, but the row - the tombstone - is never removed, so an
 * expired response can never let the same key perform a second economic action.
 */

export type IdempotencyScopeKind = 'pool' | 'workspace' | 'strategyTarget' | 'credential';

export interface IdempotencyScope {
  readonly scopeKind: IdempotencyScopeKind;
  readonly scopeId: string;
  readonly key: string;
}

export type BeginOutcome =
  /** No record: the caller may perform the action, and must record it in the same transaction. */
  | { readonly kind: 'fresh' }
  /** Same body, response still retained: return it, perform nothing. */
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown }
  /** Same body, response discarded: the action already happened; perform nothing, return this. */
  | {
      readonly kind: 'replay-expired';
      readonly action: string;
      readonly economicRef: string | null;
    }
  /** Different body under a used key: a durable conflict. */
  | { readonly kind: 'conflict'; readonly action: string };

export class IdempotencyRepository {
  constructor(private readonly pool: Pool) {}

  /** Decide, before acting, what this key permits. */
  async begin(
    input: IdempotencyScope & { readonly requestDigest: string; readonly now: Date },
  ): Promise<BeginOutcome> {
    const result = await this.pool.query<{
      request_digest: string;
      action: string;
      economic_ref: string | null;
      response_status: number;
      response_body: unknown;
      response_expires_at: Date;
    }>(
      `SELECT request_digest, action, economic_ref, response_status, response_body, response_expires_at
         FROM idempotency_results WHERE scope_kind = $1 AND scope_id = $2 AND idempotency_key = $3`,
      [input.scopeKind, input.scopeId, input.key],
    );
    const row = result.rows[0];
    if (row === undefined) return { kind: 'fresh' };
    if (row.request_digest !== input.requestDigest) return { kind: 'conflict', action: row.action };
    if (row.response_body === null || row.response_expires_at.getTime() <= input.now.getTime()) {
      return { kind: 'replay-expired', action: row.action, economicRef: row.economic_ref };
    }
    return { kind: 'replay', status: row.response_status, body: row.response_body };
  }

  /**
   * Record the outcome, inside the transaction that performed the action, so the response and
   * the action commit together or not at all.
   */
  static async recordOn(
    client: Queryable,
    input: IdempotencyScope & {
      readonly requestDigest: string;
      readonly action: string;
      readonly economicRef: string | null;
      readonly status: number;
      readonly body: unknown;
      readonly retentionMs: number;
      readonly now: Date;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO idempotency_results
         (scope_kind, scope_id, idempotency_key, request_digest, action, economic_ref,
          response_status, response_body, created_at, response_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        input.scopeKind,
        input.scopeId,
        input.key,
        input.requestDigest,
        input.action,
        input.economicRef,
        input.status,
        JSON.stringify(input.body),
        input.now,
        new Date(input.now.getTime() + input.retentionMs),
      ],
    );
  }

  /** Discard stored responses past their retention. Rows stay; only the body goes. */
  async discardExpiredResponses(input: { readonly now: Date }): Promise<number> {
    const result = await this.pool.query(
      `UPDATE idempotency_results SET response_body = NULL
        WHERE response_expires_at <= $1 AND response_body IS NOT NULL`,
      [input.now],
    );
    return result.rowCount ?? 0;
  }
}
