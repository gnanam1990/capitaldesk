import type { Pool } from 'pg';
import {
  DISPATCH_ATTEMPT_TRANSITIONS,
  PLAN_TRANSITIONS,
  type DispatchAttemptState,
  type PlanState,
} from '@capitaldesk/contracts';
import { OutboxRepository } from './outbox.js';
import { serializable, type Queryable } from './transaction.js';

/**
 * Sealed plans and dispatch attempts.
 *
 * A plan's payload never changes after it is written; its state advances along the contract's
 * transition table with an expected version. An attempt is the marker: its identity is written
 * before any network byte, in the same transaction as the outbox message that will carry the
 * send, and it only ever moves forward (INV-09; ADR-0001).
 */

const IN_FLIGHT_STATES: readonly PlanState[] = [
  'SEALED_AWAITING_APPROVAL',
  'APPROVED',
  'DISPATCH_PENDING',
  'EXECUTING',
  'RECONCILING',
  'MANUAL_REVIEW',
];

export type SealPlanOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'PLAN_IN_FLIGHT'; readonly inFlightPlanId: string };

export type TransitionPlanOutcome =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: 'UNKNOWN_PLAN' }
  | { readonly ok: false; readonly reason: 'VERSION_MISMATCH'; readonly currentVersion: number }
  | { readonly ok: false; readonly reason: 'TRANSITION_REFUSED'; readonly from: PlanState };

export type PrepareOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'CLIENT_ORDER_ID_REUSED' }
  | { readonly ok: false; readonly reason: 'DISPATCH_TOKEN_REUSED' };

export type MarkOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'NOT_PREPARED' };

export type SendAttemptedOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'NOT_MARKED' };

export type ResolveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'UNKNOWN_ATTEMPT' }
  | {
      readonly ok: false;
      readonly reason: 'TRANSITION_REFUSED';
      readonly from: DispatchAttemptState;
    };

export interface MarkHooks {
  /** Test seam: runs after the marker row is written and before the outbox message. */
  readonly afterMarkerWrite?: () => Promise<void>;
}

const TERMINAL_ATTEMPT_STATES: readonly DispatchAttemptState[] = [
  'ACKNOWLEDGED',
  'REJECTED',
  'NOT_SENT_PROVEN',
  'IRRECOVERABLE_UNCERTAINTY',
];

export class DispatchRepository {
  constructor(private readonly pool: Pool) {}

  /** Write a plan. One in flight per pool: a second is refused, naming the first. */
  sealPlan(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly planId: string;
    readonly payload: unknown;
    readonly payloadDigest: string;
    readonly state: PlanState;
  }): Promise<SealPlanOutcome> {
    return serializable(this.pool, async (client): Promise<SealPlanOutcome> => {
      await client.query(
        'SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
        [input.workspaceId, input.poolId],
      );
      if (IN_FLIGHT_STATES.includes(input.state)) {
        const inFlight = await client.query<{ plan_id: string }>(
          `SELECT plan_id FROM plans WHERE workspace_id = $1 AND pool_id = $2 AND state = ANY($3::text[])`,
          [input.workspaceId, input.poolId, IN_FLIGHT_STATES],
        );
        const existing = inFlight.rows[0];
        if (existing !== undefined)
          return { ok: false, reason: 'PLAN_IN_FLIGHT', inFlightPlanId: existing.plan_id };
      }
      await client.query(
        `INSERT INTO plans (workspace_id, pool_id, epoch, plan_id, state, payload, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.planId,
          input.state,
          JSON.stringify(input.payload),
          input.payloadDigest,
        ],
      );
      return { ok: true };
    });
  }

  transitionPlan(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly to: PlanState;
    readonly expectedVersion: number;
  }): Promise<TransitionPlanOutcome> {
    return serializable(this.pool, async (client): Promise<TransitionPlanOutcome> => {
      const plan = await client.query<{ state: PlanState; version: number }>(
        'SELECT state, version FROM plans WHERE workspace_id = $1 AND pool_id = $2 AND plan_id = $3 FOR UPDATE',
        [input.workspaceId, input.poolId, input.planId],
      );
      const row = plan.rows[0];
      if (row === undefined) return { ok: false, reason: 'UNKNOWN_PLAN' };
      if (row.version !== input.expectedVersion)
        return { ok: false, reason: 'VERSION_MISMATCH', currentVersion: row.version };
      if (!PLAN_TRANSITIONS[row.state].includes(input.to))
        return { ok: false, reason: 'TRANSITION_REFUSED', from: row.state };
      const next = row.version + 1;
      await client.query(
        `UPDATE plans SET state = $4, version = $5, updated_at = now()
          WHERE workspace_id = $1 AND pool_id = $2 AND plan_id = $3`,
        [input.workspaceId, input.poolId, input.planId, input.to, next],
      );
      return { ok: true, version: next };
    });
  }

  /**
   * Create an attempt with its identity, unsent.
   *
   * The client order id is unique across the table forever. Local history is what prevents
   * reuse, not the venue's behaviour with closed orders (TDD section 4).
   */
  prepare(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly planId: string;
    readonly attemptId: string;
    readonly clientOrderId: string;
    readonly dispatchToken: string;
  }): Promise<PrepareOutcome> {
    return serializable(this.pool, async (client): Promise<PrepareOutcome> => {
      const reused = await client.query<{ client_order_id: string; dispatch_token: string }>(
        'SELECT client_order_id, dispatch_token FROM dispatch_attempts WHERE client_order_id = $1 OR dispatch_token = $2',
        [input.clientOrderId, input.dispatchToken],
      );
      const clash = reused.rows[0];
      if (clash !== undefined) {
        return clash.client_order_id === input.clientOrderId
          ? { ok: false, reason: 'CLIENT_ORDER_ID_REUSED' }
          : { ok: false, reason: 'DISPATCH_TOKEN_REUSED' };
      }
      await client.query(
        `INSERT INTO dispatch_attempts
           (workspace_id, pool_id, epoch, attempt_id, plan_id, client_order_id, dispatch_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.attemptId,
          input.planId,
          input.clientOrderId,
          input.dispatchToken,
        ],
      );
      return { ok: true };
    });
  }

  /**
   * Commit the marker.
   *
   * One transaction: the attempt becomes DISPATCH_MARKED with its signed request and host
   * fence evidence, and the single-attempt outbox message that will carry the send is written
   * beside it. Nothing here touches the network; the executor consumes the message.
   */
  mark(
    input: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly attemptId: string;
      readonly outboxId: string;
      readonly signedRequest: unknown;
      readonly host: { readonly bootId: string; readonly pid: number };
    },
    hooks: MarkHooks = {},
  ): Promise<MarkOutcome> {
    return serializable(this.pool, async (client): Promise<MarkOutcome> => {
      const marked = await client.query<{
        client_order_id: string;
        dispatch_token: string;
        plan_id: string;
        epoch: number;
      }>(
        `UPDATE dispatch_attempts
            SET state = 'DISPATCH_MARKED', marked_at = now(), signed_request = $4::jsonb,
                marker_host_boot_id = $5, marker_pid = $6
          WHERE workspace_id = $1 AND pool_id = $2 AND attempt_id = $3 AND state = 'PREPARED'
          RETURNING client_order_id, dispatch_token, plan_id, epoch`,
        [
          input.workspaceId,
          input.poolId,
          input.attemptId,
          JSON.stringify(input.signedRequest),
          input.host.bootId,
          input.host.pid,
        ],
      );
      const row = marked.rows[0];
      if (row === undefined) return { ok: false, reason: 'NOT_PREPARED' };
      await hooks.afterMarkerWrite?.();
      await OutboxRepository.enqueueOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        outboxId: input.outboxId,
        kind: 'dispatch.send',
        payload: {
          attemptId: input.attemptId,
          clientOrderId: row.client_order_id,
          dispatchToken: row.dispatch_token,
          planId: row.plan_id,
          epoch: row.epoch,
        },
        maxAttempts: 1,
      });
      return { ok: true };
    });
  }

  /** The second durable write, immediately before the first network byte (ADR-0001). */
  recordSendAttempted(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly attemptId: string;
  }): Promise<SendAttemptedOutcome> {
    return serializable(this.pool, async (client): Promise<SendAttemptedOutcome> => {
      const updated = await client.query(
        `UPDATE dispatch_attempts SET state = 'SEND_ATTEMPTED', send_attempted_at = now()
          WHERE workspace_id = $1 AND pool_id = $2 AND attempt_id = $3 AND state = 'DISPATCH_MARKED'`,
        [input.workspaceId, input.poolId, input.attemptId],
      );
      return updated.rowCount === 1 ? { ok: true } : { ok: false, reason: 'NOT_MARKED' };
    });
  }

  /** Advance an attempt along the contract's table. There is no way back. */
  resolve(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly attemptId: string;
    readonly to: DispatchAttemptState;
  }): Promise<ResolveOutcome> {
    return serializable(this.pool, async (client): Promise<ResolveOutcome> => {
      const attempt = await client.query<{ state: DispatchAttemptState }>(
        'SELECT state FROM dispatch_attempts WHERE workspace_id = $1 AND pool_id = $2 AND attempt_id = $3 FOR UPDATE',
        [input.workspaceId, input.poolId, input.attemptId],
      );
      const row = attempt.rows[0];
      if (row === undefined) return { ok: false, reason: 'UNKNOWN_ATTEMPT' };
      if (!DISPATCH_ATTEMPT_TRANSITIONS[row.state].includes(input.to))
        return { ok: false, reason: 'TRANSITION_REFUSED', from: row.state };
      await client.query(
        `UPDATE dispatch_attempts
            SET state = $4, resolved_at = CASE WHEN $5::boolean THEN now() ELSE resolved_at END
          WHERE workspace_id = $1 AND pool_id = $2 AND attempt_id = $3`,
        [
          input.workspaceId,
          input.poolId,
          input.attemptId,
          input.to,
          TERMINAL_ATTEMPT_STATES.includes(input.to),
        ],
      );
      return { ok: true };
    });
  }

  async attempt(scope: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly attemptId: string;
  }): Promise<{
    state: DispatchAttemptState;
    clientOrderId: string;
    markedAt: Date | null;
    sendAttemptedAt: Date | null;
  } | null> {
    const result = await this.pool.query<{
      state: DispatchAttemptState;
      client_order_id: string;
      marked_at: Date | null;
      send_attempted_at: Date | null;
    }>(
      'SELECT state, client_order_id, marked_at, send_attempted_at FROM dispatch_attempts WHERE workspace_id = $1 AND pool_id = $2 AND attempt_id = $3',
      [scope.workspaceId, scope.poolId, scope.attemptId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      state: row.state,
      clientOrderId: row.client_order_id,
      markedAt: row.marked_at,
      sendAttemptedAt: row.send_attempted_at,
    };
  }
}

export { IN_FLIGHT_STATES as PLAN_IN_FLIGHT_STATES, type Queryable as JournalQueryable };
