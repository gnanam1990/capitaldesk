import type { Pool } from 'pg';
import {
  DISPATCH_ATTEMPT_TRANSITIONS,
  PLAN_TRANSITIONS,
  type DispatchAttemptState,
  type PlanState,
} from '@capitaldesk/contracts';
import { OutboxRepository } from './outbox.js';
import { serializable, serializableOn, type Queryable } from './transaction.js';

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
  | { readonly ok: false; readonly reason: 'PLAN_IN_FLIGHT'; readonly inFlightPlanId: string }
  /** The epoch named is not the pool's current open one, so its baseline no longer governs. */
  | {
      readonly ok: false;
      readonly reason: 'EPOCH_NOT_CURRENT';
      readonly currentEpoch: number | null;
    }
  | AuthorityRefusal;

/**
 * The pool's open epoch, read under the caller's lock.
 *
 * Every path that creates economic authority - sealing, reserving, preparing, marking - takes
 * the pool row lock and then calls this. Rotation takes the same lock, so an epoch cannot
 * close between the check and the write.
 */
export async function currentEpochOf(
  client: Queryable,
  scope: { readonly workspaceId: string; readonly poolId: string },
): Promise<number | null> {
  const result = await client.query<{ epoch: number }>(
    `SELECT epoch FROM baseline_epochs
      WHERE workspace_id = $1 AND pool_id = $2 AND closed_at IS NULL`,
    [scope.workspaceId, scope.poolId],
  );
  return result.rows[0]?.epoch ?? null;
}

export type TransitionPlanOutcome =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: 'UNKNOWN_PLAN' }
  | { readonly ok: false; readonly reason: 'VERSION_MISMATCH'; readonly currentVersion: number }
  | { readonly ok: false; readonly reason: 'TRANSITION_REFUSED'; readonly from: PlanState };

export type PrepareOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'CLIENT_ORDER_ID_REUSED' }
  | { readonly ok: false; readonly reason: 'DISPATCH_TOKEN_REUSED' }
  | {
      readonly ok: false;
      readonly reason: 'EPOCH_NOT_CURRENT';
      readonly currentEpoch: number | null;
    }
  | AuthorityRefusal;

export type MarkOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'NOT_PREPARED' }
  | { readonly ok: false; readonly reason: 'ATTEMPT_VOIDED'; readonly voidedReason: string }
  | { readonly ok: false; readonly reason: 'PLAN_NOT_DISPATCHABLE'; readonly state: PlanState }
  | { readonly ok: false; readonly reason: 'SIGNED_REQUEST_MISSING' }
  | {
      readonly ok: false;
      readonly reason: 'EPOCH_NOT_CURRENT';
      readonly currentEpoch: number | null;
    }
  | AuthorityRefusal;

export interface MarkInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly attemptId: string;
  readonly outboxId: string;
  readonly signedRequest: unknown;
  readonly host: {
    readonly bootId: string;
    readonly pid: number;
    /**
     * When the marking process started. PIDs are reused without a reboot, so boot id and pid
     * together do not identify a process; the start time is what distinguishes a live holder
     * from a new process that inherited its pid (ADR-0001 condition 2).
     */
    readonly processStartedAt: Date;
  };
}

/**
 * The only pool states in which new economic or dispatch authority may be created.
 *
 * BOOTSTRAPPING has no baseline yet; HALTED and QUARANTINED are the states an operator or the
 * reconciler put the pool into precisely to stop new authority. Recording reconciliation and
 * compensating evidence is deliberately *not* gated on this: a halted pool still has to be
 * able to account for the liabilities it already carries.
 */
export const AUTHORITY_POOL_STATES: readonly string[] = ['READY', 'AWAITING_APPROVAL', 'IN_FLIGHT'];

export type AuthorityRefusal =
  | { readonly ok: false; readonly reason: 'POOL_NOT_DISPATCHABLE'; readonly state: string }
  | { readonly ok: false; readonly reason: 'NO_ACTIVE_LEASE' }
  | { readonly ok: false; readonly reason: 'UNKNOWN_POOL' };

/**
 * Lock the pool and require that it may create authority right now.
 *
 * Every path that creates approval, reservation or dispatch authority calls this under the
 * same lock that release and rotation take. Marking checked it; sealing, reserving and
 * preparing did not, so after a lease was released a probe still sealed a plan, reserved 500
 * atoms and prepared an attempt in a halted, ungoverned pool.
 */
export async function requireAuthorityPool(
  client: Queryable,
  scope: { readonly workspaceId: string; readonly poolId: string },
): Promise<AuthorityRefusal | { readonly ok: true; readonly state: string }> {
  const pool = await client.query<{
    state: string;
    venue: string;
    environment: string;
    stable_account_id: string;
  }>(
    `SELECT state, venue, environment, stable_account_id FROM pools
      WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE`,
    [scope.workspaceId, scope.poolId],
  );
  const row = pool.rows[0];
  if (row === undefined) return { ok: false, reason: 'UNKNOWN_POOL' };
  if (!AUTHORITY_POOL_STATES.includes(row.state)) {
    return { ok: false, reason: 'POOL_NOT_DISPATCHABLE', state: row.state };
  }
  const lease = await client.query(
    `SELECT 1 FROM governance_leases
      WHERE venue = $1 AND environment = $2 AND stable_account_id = $3
        AND workspace_id = $4 AND pool_id = $5 AND released_at IS NULL`,
    [row.venue, row.environment, row.stable_account_id, scope.workspaceId, scope.poolId],
  );
  if (lease.rowCount !== 1) return { ok: false, reason: 'NO_ACTIVE_LEASE' };
  return { ok: true, state: row.state };
}

export type SendAttemptedOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'NOT_MARKED' };

export type ResolveOutcome =
  | { readonly ok: true }
  /**
   * `NOT_SENT_PROVEN` is in the domain state machine but unreachable in module 04.
   *
   * It is the one dispatch outcome that releases a held reservation, so it is the one that
   * must not be reachable on a caller's word. This method used to take four booleans -
   * `senderFenced`, `openOrderScanClear`, `tradeBackfillClear`, `coverageComplete` - check
   * they were all true, and then discard them: nothing was stored, nothing referenced a real
   * observation, and no later reader could audit why the capital was released.
   *
   * The evidence ADR-0001 requires is produced by the reconciler in module 15: a fenced
   * sender, an account-wide open-order scan and trade backfill covering the whole uncertainty
   * window with no record of the client order id, and COMPLETE coverage over that window.
   * Until a forward migration adds columns binding this attempt to those durable evidence
   * rows, the honest answer is that module 04 cannot prove a non-send, so it refuses. The
   * database refuses the same transition independently, including from a raw UPDATE.
   *
   * When module 15 lands, reinstating this must also reinstate the rule that an attempt which
   * recorded `SEND_ATTEMPTED` can never be proven unsent, by any route including
   * `SEND_ATTEMPTED -> UNKNOWN -> NOT_SENT_PROVEN`.
   */
  | { readonly ok: false; readonly reason: 'NOT_SENT_PROVEN_UNAVAILABLE' }
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
      const authority = await requireAuthorityPool(client, input);
      if (!authority.ok) return authority;
      const currentEpoch = await currentEpochOf(client, input);
      if (currentEpoch !== input.epoch) {
        return { ok: false, reason: 'EPOCH_NOT_CURRENT', currentEpoch };
      }
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
      // Same lock, authority check and epoch check as sealing, so neither rotation nor a
      // lease release can slip between them.
      const authority = await requireAuthorityPool(client, input);
      if (!authority.ok) return authority;
      const currentEpoch = await currentEpochOf(client, input);
      if (currentEpoch !== input.epoch) {
        return { ok: false, reason: 'EPOCH_NOT_CURRENT', currentEpoch };
      }
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
   * One transaction, and it validates the whole authority chain before writing anything: the
   * pool row is locked and must be dispatchable, the plan must still be DISPATCH_PENDING, the
   * attempt must be PREPARED and not voided, and the account's governance lease must be
   * active. Only then does the attempt become DISPATCH_MARKED with its signed request and
   * host fence evidence, beside the single-attempt outbox message that will carry the send.
   *
   * Checking only the attempt's own state was not enough. A restore could halt the pool,
   * invalidate the plan and release its reservation, and a `mark` arriving afterwards still
   * succeeded — producing a marker, and a send message, for a plan whose authority had been
   * withdrawn and whose funds had been returned. Locking the pool first is also what makes
   * this and `enterRestorePosture` mutually exclusive rather than interleaved.
   *
   * Nothing here touches the network; the executor consumes the message.
   */
  mark(input: MarkInput, hooks: MarkHooks = {}): Promise<MarkOutcome> {
    return serializable(this.pool, (client) => markBody(client, input, hooks));
  }

  /** The same marking pinned to one connection, for a race proven on independent backends. */
  static markOn(client: Queryable, input: MarkInput, hooks: MarkHooks = {}): Promise<MarkOutcome> {
    return serializableOn(client, (c) => markBody(c, input, hooks));
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
    // Refused before the row is even read, so no caller can believe an evidence argument
    // would change the answer. See ResolveOutcome for why, and what module 15 must supply.
    if (input.to === 'NOT_SENT_PROVEN') {
      return Promise.resolve({ ok: false, reason: 'NOT_SENT_PROVEN_UNAVAILABLE' });
    }
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

async function markBody(
  client: Queryable,
  input: MarkInput,
  hooks: MarkHooks,
): Promise<MarkOutcome> {
  // The marker's whole purpose is to commit what will be sent before sending it. A null or
  // non-object signed request is nothing to commit, and the marked-state CHECK refuses it at
  // the table too.
  if (
    input.signedRequest === null ||
    input.signedRequest === undefined ||
    typeof input.signedRequest !== 'object' ||
    Array.isArray(input.signedRequest)
  ) {
    return { ok: false, reason: 'SIGNED_REQUEST_MISSING' };
  }

  // The same gate sealing, reserving and preparing use, in the same lock order.
  const authority = await requireAuthorityPool(client, input);
  if (!authority.ok) return authority;

  const attempt = await client.query<{
    state: DispatchAttemptState;
    plan_id: string;
    epoch: number;
    voided_reason: string | null;
  }>(
    `SELECT state, plan_id, epoch, voided_reason FROM dispatch_attempts
      WHERE workspace_id = $1 AND pool_id = $2 AND attempt_id = $3 FOR UPDATE`,
    [input.workspaceId, input.poolId, input.attemptId],
  );
  const attemptRow = attempt.rows[0];
  if (attemptRow === undefined || attemptRow.state !== 'PREPARED')
    return { ok: false, reason: 'NOT_PREPARED' };
  if (attemptRow.voided_reason !== null) {
    return { ok: false, reason: 'ATTEMPT_VOIDED', voidedReason: attemptRow.voided_reason };
  }

  const plan = await client.query<{ state: PlanState }>(
    `SELECT state FROM plans WHERE workspace_id = $1 AND pool_id = $2 AND plan_id = $3 FOR UPDATE`,
    [input.workspaceId, input.poolId, attemptRow.plan_id],
  );
  const planRow = plan.rows[0];
  if (planRow === undefined) return { ok: false, reason: 'NOT_PREPARED' };
  if (planRow.state !== 'DISPATCH_PENDING') {
    return { ok: false, reason: 'PLAN_NOT_DISPATCHABLE', state: planRow.state };
  }

  const marked = await client.query<{ client_order_id: string; dispatch_token: string }>(
    `UPDATE dispatch_attempts
        SET state = 'DISPATCH_MARKED', marked_at = now(), signed_request = $4::jsonb,
            marker_host_boot_id = $5, marker_pid = $6, marker_process_started_at = $7
      WHERE workspace_id = $1 AND pool_id = $2 AND attempt_id = $3 AND state = 'PREPARED'
      RETURNING client_order_id, dispatch_token`,
    [
      input.workspaceId,
      input.poolId,
      input.attemptId,
      JSON.stringify(input.signedRequest),
      input.host.bootId,
      input.host.pid,
      input.host.processStartedAt,
    ],
  );
  const row = marked.rows[0];
  /* c8 ignore next -- the row was locked and checked above. */
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
      planId: attemptRow.plan_id,
      epoch: attemptRow.epoch,
    },
    maxAttempts: 1,
  });
  return { ok: true };
}

export { IN_FLIGHT_STATES as PLAN_IN_FLIGHT_STATES, type Queryable as JournalQueryable };
