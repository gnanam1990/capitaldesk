import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { digestOf, violate } from '@capitaldesk/contracts';
import { assertAuthorized, type Principal } from '@capitaldesk/domain';
import { requireAuthorityPool } from './dispatch.js';
import { IdempotencyRepository } from './idempotency.js';
import { LedgerRepository } from './ledger.js';
import { serializable, type Queryable } from './transaction.js';

export type ExecutionMode = 'BROKER_KEY' | 'APPROVED_HOST';

export type ApprovalOutcome =
  | { readonly ok: true; readonly approvalId: string; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'UNKNOWN_PLAN'
        | 'PLAN_NOT_AWAITING_APPROVAL'
        | 'APPROVAL_DIGEST_MISMATCH'
        | 'APPROVAL_EXPIRED'
        | 'AUTHORITY_UNAVAILABLE'
        | 'IDEMPOTENCY_CONFLICT'
        | 'ALREADY_DECIDED';
    };

export type RevokeOutcome =
  | {
      readonly ok: true;
      readonly revocationId: string;
      readonly effect: 'INVALIDATED_UNMARKED' | 'HALT_REQUESTED_IN_FLIGHT';
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'UNKNOWN_APPROVAL' | 'APPROVAL_DIGEST_MISMATCH' | 'IDEMPOTENCY_CONFLICT';
    };

export type EligibilityOutcome =
  | {
      readonly ok: true;
      readonly approvalId: string;
      readonly approvalExpiresAt: Date;
      readonly submissionDeadlineAt: Date;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'UNKNOWN_PLAN'
        | 'PLAN_NOT_APPROVED'
        | 'APPROVAL_DIGEST_MISMATCH'
        | 'APPROVAL_REVOKED'
        | 'APPROVAL_EXPIRED'
        | 'SUBMISSION_DEADLINE_PASSED'
        | 'POLICY_MANDATE_VERSION_STALE'
        | 'LEDGER_REVISION_STALE'
        | 'STRATEGY_AUTHORITY_REVOKED'
        | 'EXECUTION_MODE_MISMATCH'
        | 'DISPATCH_NATIVE_CONFIRMATION_MISSING';
    };

export interface ApprovalView {
  readonly approvalId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly decision: 'APPROVED' | 'DECLINED';
  readonly executionMode: ExecutionMode;
  readonly actorSubjectId: string;
  readonly allocationAlgorithmVersion: string;
  readonly feePolicyVersion: string;
  readonly intentRevisions: unknown;
  readonly allocation: unknown;
  readonly strategyCaps: unknown;
  readonly fifoConsequence: string;
  readonly approvalExpiresAt: Date;
  readonly submissionDeadlineAt: Date;
  readonly revoked: boolean;
  readonly nativeConfirmation: null | {
    readonly provider: string;
    readonly confirmationRef: string;
    readonly confirmedAt: Date;
  };
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

function scopeId(input: { workspaceId: string; poolId: string; planId: string }): string {
  return `${input.workspaceId}/${input.poolId}/${input.planId}/approval`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    violate('CANONICAL_ENCODING_REJECTED', `sealed plan field ${key} is not a string`);
  }
  return value;
}

async function releasePlanReservations(
  client: Queryable,
  input: { workspaceId: string; poolId: string; planId: string; reason: string },
): Promise<void> {
  const held = await client.query<{ reservation_id: string; reserved_atoms: string }>(
    `SELECT reservation_id,reserved_atoms::text FROM reservations
      WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3 AND state='HELD'
      ORDER BY reservation_id FOR UPDATE`,
    [input.workspaceId, input.poolId, input.planId],
  );
  for (const reservation of held.rows) {
    const released = await LedgerRepository.releaseOn(client, {
      workspaceId: input.workspaceId,
      poolId: input.poolId,
      reservationId: reservation.reservation_id,
      atoms: BigInt(reservation.reserved_atoms),
      source: { kind: input.reason, ref: reservation.reservation_id },
    });
    if (!released.ok) throw new Error(`approval release failed: ${released.reason}`);
  }
  await client.query(
    `UPDATE policy_budget_holds SET state='RELEASED',updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND pool_id=$2 AND budget_ref IN
        (SELECT reservation_id FROM reservations WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3)
        AND state='HELD'`,
    [input.workspaceId, input.poolId, input.planId],
  );
  await client.query(
    `UPDATE dispatch_attempts SET voided_at=clock_timestamp(),voided_reason=$4
      WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3 AND state='PREPARED' AND voided_at IS NULL`,
    [input.workspaceId, input.poolId, input.planId, input.reason],
  );
}

export class ApprovalRepository {
  constructor(private readonly pool: Pool) {}

  decide(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly planDigest: string;
    readonly decision: 'APPROVED' | 'DECLINED';
    readonly executionMode: ExecutionMode;
    readonly idempotencyKey: string;
    readonly actor: Principal;
    readonly now?: Date;
  }): Promise<ApprovalOutcome> {
    assertAuthorized(
      input.actor,
      input.decision === 'APPROVED' ? 'plan.approve' : 'plan.decline',
      input,
    );
    const requestDigest = digestOf({
      action: input.decision,
      planId: input.planId,
      planDigest: input.planDigest,
      executionMode: input.executionMode,
    });
    return serializable(this.pool, async (client): Promise<ApprovalOutcome> => {
      if (input.decision === 'APPROVED') {
        const authority = await requireAuthorityPool(client, input);
        if (!authority.ok) return { ok: false, reason: 'AUTHORITY_UNAVAILABLE' };
      } else {
        const locked = await client.query(
          'SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE',
          [input.workspaceId, input.poolId],
        );
        if (locked.rowCount !== 1) return { ok: false, reason: 'UNKNOWN_PLAN' };
      }
      const idempotency = await IdempotencyRepository.beginOn(client, {
        scopeKind: 'pool',
        scopeId: scopeId(input),
        key: input.idempotencyKey,
        requestDigest,
      });
      if (idempotency.kind === 'conflict') return { ok: false, reason: 'IDEMPOTENCY_CONFLICT' };
      if (idempotency.kind === 'replay') {
        const prior = idempotency.body as ApprovalOutcome;
        return prior.ok ? { ...prior, replayed: true } : prior;
      }
      if (idempotency.kind === 'replay-expired') {
        return { ok: true, approvalId: idempotency.economicRef ?? input.planId, replayed: true };
      }

      const existing = await client.query<{
        approval_id: string;
        decision: 'APPROVED' | 'DECLINED';
        plan_digest: string;
        execution_mode: ExecutionMode;
      }>(
        `SELECT approval_id,decision,plan_digest,execution_mode FROM plan_approval_decisions
          WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3`,
        [input.workspaceId, input.poolId, input.planId],
      );
      const decided = existing.rows[0];
      if (decided !== undefined) {
        if (
          decided.decision !== input.decision ||
          decided.plan_digest !== input.planDigest ||
          decided.execution_mode !== input.executionMode
        ) {
          return { ok: false, reason: 'ALREADY_DECIDED' };
        }
        const outcome = { ok: true, approvalId: decided.approval_id, replayed: true } as const;
        await IdempotencyRepository.recordOn(client, {
          scopeKind: 'pool',
          scopeId: scopeId(input),
          key: input.idempotencyKey,
          requestDigest,
          action: `plan.${input.decision.toLowerCase()}`,
          economicRef: decided.approval_id,
          status: 200,
          body: outcome,
          retentionMs: 86_400_000,
        });
        return outcome;
      }

      const plan = await client.query<{
        epoch: number;
        state: string;
        payload: unknown;
        payload_digest: string;
        policy_version: string;
        source_ledger_revision: string;
        approval_ledger_revision: string;
        db_now: Date;
      }>(
        `SELECT p.epoch,p.state,p.payload,p.payload_digest,s.policy_version::text,
                s.source_ledger_revision::text,po.ledger_revision::text approval_ledger_revision,
                clock_timestamp() db_now
           FROM plans p JOIN plan_seals s USING (workspace_id,pool_id,epoch,plan_id)
           JOIN pools po USING (workspace_id,pool_id)
          WHERE p.workspace_id=$1 AND p.pool_id=$2 AND p.plan_id=$3 FOR UPDATE OF p`,
        [input.workspaceId, input.poolId, input.planId],
      );
      const row = plan.rows[0];
      if (row === undefined) return { ok: false, reason: 'UNKNOWN_PLAN' };
      if (row.state !== 'SEALED_AWAITING_APPROVAL') {
        return { ok: false, reason: 'PLAN_NOT_AWAITING_APPROVAL' };
      }
      if (row.payload_digest !== input.planDigest) {
        return { ok: false, reason: 'APPROVAL_DIGEST_MISMATCH' };
      }
      const payload = asRecord(row.payload);
      const expiresAt = requiredString(payload, 'approvalExpiresAt');
      const deadlineAt = requiredString(payload, 'submissionDeadlineAt');
      const now = input.now ?? row.db_now;
      if (
        input.decision === 'APPROVED' &&
        (!(now < new Date(expiresAt)) || !(now < new Date(deadlineAt)))
      ) {
        await releasePlanReservations(client, { ...input, reason: 'approval-expired' });
        await client.query(
          `UPDATE plans SET state='EXPIRED',version=version+1,updated_at=$4
            WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3`,
          [input.workspaceId, input.poolId, input.planId, now],
        );
        return { ok: false, reason: 'APPROVAL_EXPIRED' };
      }
      const approvalId = newId(input.decision === 'APPROVED' ? 'approval' : 'decline');
      const allocation = Array.isArray(payload['allocation']) ? payload['allocation'] : [];
      const strategyCaps = Array.isArray(payload['strategyCaps']) ? payload['strategyCaps'] : [];
      const intentRevisions = allocation.map((entry) => {
        const record = asRecord(entry);
        return {
          strategyId: requiredString(record, 'strategyId'),
          intentId: requiredString(record, 'intentId'),
          intentRevision: requiredString(record, 'intentRevision'),
        };
      });
      await client.query(
        `INSERT INTO plan_approval_decisions
          (workspace_id,pool_id,epoch,approval_id,plan_id,decision,plan_digest,
           actor_subject_id,actor_role,execution_mode,policy_version,source_ledger_revision,
           approval_ledger_revision,allocation_algorithm_version,fee_policy_version,
           intent_revisions,allocation,strategy_caps,approval_expires_at,submission_deadline_at,
           decided_at,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 $16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21,$22)`,
        [
          input.workspaceId,
          input.poolId,
          row.epoch,
          approvalId,
          input.planId,
          input.decision,
          input.planDigest,
          input.actor.subjectId,
          input.actor.role,
          input.executionMode,
          row.policy_version,
          row.source_ledger_revision,
          row.approval_ledger_revision,
          requiredString(payload, 'allocationAlgorithmVersion'),
          requiredString(payload, 'feePolicyVersion'),
          JSON.stringify(intentRevisions),
          JSON.stringify(allocation),
          JSON.stringify(strategyCaps),
          expiresAt,
          deadlineAt,
          now,
          input.idempotencyKey,
        ],
      );
      if (input.decision === 'APPROVED') {
        await client.query(
          `UPDATE plans SET state='APPROVED',version=version+1,updated_at=$4
            WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3`,
          [input.workspaceId, input.poolId, input.planId, now],
        );
      } else {
        await releasePlanReservations(client, { ...input, reason: 'approval-declined' });
        await client.query(
          `UPDATE plans SET state='DECLINED',version=version+1,updated_at=$4
            WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3`,
          [input.workspaceId, input.poolId, input.planId, now],
        );
      }
      const outcome = { ok: true, approvalId, replayed: false } as const;
      await IdempotencyRepository.recordOn(client, {
        scopeKind: 'pool',
        scopeId: scopeId(input),
        key: input.idempotencyKey,
        requestDigest,
        action: `plan.${input.decision.toLowerCase()}`,
        economicRef: approvalId,
        status: 201,
        body: outcome,
        retentionMs: 86_400_000,
      });
      return outcome;
    });
  }

  revoke(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly planDigest: string;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly actor: Principal;
    readonly now?: Date;
  }): Promise<RevokeOutcome> {
    assertAuthorized(input.actor, 'plan.decline', input);
    const requestDigest = digestOf({
      action: 'REVOKE',
      planId: input.planId,
      planDigest: input.planDigest,
      reason: input.reason,
    });
    return serializable(this.pool, async (client): Promise<RevokeOutcome> => {
      await client.query('SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE', [
        input.workspaceId,
        input.poolId,
      ]);
      const idempotency = await IdempotencyRepository.beginOn(client, {
        scopeKind: 'pool',
        scopeId: `${scopeId(input)}/revoke`,
        key: input.idempotencyKey,
        requestDigest,
      });
      if (idempotency.kind === 'conflict') return { ok: false, reason: 'IDEMPOTENCY_CONFLICT' };
      if (idempotency.kind === 'replay') {
        const prior = idempotency.body as RevokeOutcome;
        return prior.ok ? { ...prior, replayed: true } : prior;
      }
      const approval = await client.query<{
        approval_id: string;
        plan_digest: string;
        effect: 'INVALIDATED_UNMARKED' | 'HALT_REQUESTED_IN_FLIGHT' | null;
        revocation_id: string | null;
      }>(
        `SELECT d.approval_id,d.plan_digest,r.effect,r.revocation_id
           FROM plan_approval_decisions d LEFT JOIN plan_approval_revocations r
             USING (workspace_id,pool_id,approval_id)
          WHERE d.workspace_id=$1 AND d.pool_id=$2 AND d.plan_id=$3 AND d.decision='APPROVED'`,
        [input.workspaceId, input.poolId, input.planId],
      );
      const row = approval.rows[0];
      if (row === undefined) return { ok: false, reason: 'UNKNOWN_APPROVAL' };
      if (row.plan_digest !== input.planDigest) {
        return { ok: false, reason: 'APPROVAL_DIGEST_MISMATCH' };
      }
      if (row.effect !== null && row.revocation_id !== null) {
        return { ok: true, revocationId: row.revocation_id, effect: row.effect, replayed: true };
      }
      const marked = await client.query(
        `SELECT 1 FROM dispatch_attempts WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3
          AND state IN ('DISPATCH_MARKED','SEND_ATTEMPTED','ACKNOWLEDGED','REJECTED','UNKNOWN',
                        'NOT_SENT_PROVEN','IRRECOVERABLE_UNCERTAINTY')`,
        [input.workspaceId, input.poolId, input.planId],
      );
      const effect =
        (marked.rowCount ?? 0) > 0 ? 'HALT_REQUESTED_IN_FLIGHT' : 'INVALIDATED_UNMARKED';
      const revocationId = newId('revocation');
      const now = input.now ?? new Date();
      await client.query(
        `INSERT INTO plan_approval_revocations
          (workspace_id,pool_id,revocation_id,approval_id,plan_id,plan_digest,
           actor_subject_id,actor_role,reason,effect,revoked_at,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          input.workspaceId,
          input.poolId,
          revocationId,
          row.approval_id,
          input.planId,
          input.planDigest,
          input.actor.subjectId,
          input.actor.role,
          input.reason,
          effect,
          now,
          input.idempotencyKey,
        ],
      );
      if (effect === 'INVALIDATED_UNMARKED') {
        await releasePlanReservations(client, { ...input, reason: 'approval-revoked' });
        await client.query(
          `UPDATE plans SET state='INVALIDATED',version=version+1,updated_at=$4
            WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3`,
          [input.workspaceId, input.poolId, input.planId, now],
        );
      } else {
        await client.query(
          `UPDATE pools SET state='HALTED',version=version+1,updated_at=$3
            WHERE workspace_id=$1 AND pool_id=$2 AND state<>'HALTED'`,
          [input.workspaceId, input.poolId, now],
        );
      }
      const outcome = { ok: true, revocationId, effect, replayed: false } as const;
      await IdempotencyRepository.recordOn(client, {
        scopeKind: 'pool',
        scopeId: `${scopeId(input)}/revoke`,
        key: input.idempotencyKey,
        requestDigest,
        action: 'plan.revoke',
        economicRef: revocationId,
        status: 201,
        body: outcome,
        retentionMs: 86_400_000,
      });
      return outcome;
    });
  }

  recordNativeConfirmation(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly planDigest: string;
    readonly confirmationRef: string;
    readonly confirmedPayloadDigest: string;
    readonly confirmedAt: Date;
  }): Promise<
    | { readonly ok: true; readonly confirmationId: string; readonly replayed: boolean }
    | {
        readonly ok: false;
        readonly reason:
          'UNKNOWN_APPROVAL' | 'APPROVAL_DIGEST_MISMATCH' | 'EXECUTION_MODE_MISMATCH';
      }
  > {
    return serializable(this.pool, async (client) => {
      const approval = await client.query<{
        approval_id: string;
        plan_digest: string;
        execution_mode: ExecutionMode;
        confirmation_id: string | null;
        confirmation_ref: string | null;
        confirmed_payload_digest: string | null;
      }>(
        `SELECT d.approval_id,d.plan_digest,d.execution_mode,c.confirmation_id,
                c.confirmation_ref,c.confirmed_payload_digest
           FROM plan_approval_decisions d LEFT JOIN plan_native_confirmations c
             USING (workspace_id,pool_id,approval_id)
          WHERE d.workspace_id=$1 AND d.pool_id=$2 AND d.plan_id=$3 AND d.decision='APPROVED'
          FOR UPDATE OF d`,
        [input.workspaceId, input.poolId, input.planId],
      );
      const row = approval.rows[0];
      if (row === undefined) return { ok: false, reason: 'UNKNOWN_APPROVAL' } as const;
      if (
        row.plan_digest !== input.planDigest ||
        input.confirmedPayloadDigest !== input.planDigest
      ) {
        return { ok: false, reason: 'APPROVAL_DIGEST_MISMATCH' } as const;
      }
      if (row.execution_mode !== 'APPROVED_HOST') {
        return { ok: false, reason: 'EXECUTION_MODE_MISMATCH' } as const;
      }
      if (row.confirmation_id !== null) {
        if (
          row.confirmation_ref !== input.confirmationRef ||
          row.confirmed_payload_digest !== input.confirmedPayloadDigest
        ) {
          return { ok: false, reason: 'APPROVAL_DIGEST_MISMATCH' } as const;
        }
        return { ok: true, confirmationId: row.confirmation_id, replayed: true } as const;
      }
      const confirmationId = newId('confirmation');
      await client.query(
        `INSERT INTO plan_native_confirmations
          (workspace_id,pool_id,confirmation_id,approval_id,plan_id,plan_digest,provider,
           confirmation_ref,confirmed_payload_digest,confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'BINANCE_AGENTIC_MCP',$7,$8,$9)`,
        [
          input.workspaceId,
          input.poolId,
          confirmationId,
          row.approval_id,
          input.planId,
          input.planDigest,
          input.confirmationRef,
          input.confirmedPayloadDigest,
          input.confirmedAt,
        ],
      );
      return { ok: true, confirmationId, replayed: false } as const;
    });
  }

  eligibility(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly digest: string;
    readonly executionMode: ExecutionMode;
    readonly now?: Date;
  }): Promise<EligibilityOutcome> {
    return serializable(this.pool, (client) => ApprovalRepository.eligibilityOn(client, input));
  }

  static async eligibilityOn(
    client: Queryable,
    input: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly planId: string;
      readonly digest: string;
      readonly executionMode: ExecutionMode;
      readonly now?: Date;
    },
  ): Promise<EligibilityOutcome> {
    const result = await client.query<{
      approval_id: string;
      plan_state: string;
      plan_digest: string;
      approval_digest: string;
      execution_mode: ExecutionMode;
      policy_version: string;
      active_policy_version: string | null;
      approval_ledger_revision: string;
      current_ledger_revision: string;
      approval_expires_at: Date;
      submission_deadline_at: Date;
      revoked: boolean;
      native_digest: string | null;
      inactive_strategies: string;
      db_now: Date;
    }>(
      `SELECT d.approval_id,p.state plan_state,p.payload_digest plan_digest,
              d.plan_digest approval_digest,d.execution_mode,d.policy_version::text,
              po.active_policy_version::text,d.approval_ledger_revision::text,
              po.ledger_revision::text current_ledger_revision,d.approval_expires_at,
              d.submission_deadline_at,(r.revocation_id IS NOT NULL) revoked,
              c.confirmed_payload_digest native_digest,clock_timestamp() db_now,
              (SELECT count(*)::text FROM jsonb_array_elements(d.intent_revisions) i
                LEFT JOIN strategies s ON s.workspace_id=d.workspace_id AND s.pool_id=d.pool_id
                 AND s.strategy_id=i->>'strategyId'
                WHERE s.strategy_id IS NULL OR s.archived_at IS NOT NULL) inactive_strategies
         FROM plan_approval_decisions d JOIN plans p USING (workspace_id,pool_id,plan_id)
         JOIN pools po USING (workspace_id,pool_id)
         LEFT JOIN plan_approval_revocations r USING (workspace_id,pool_id,approval_id)
         LEFT JOIN plan_native_confirmations c USING (workspace_id,pool_id,approval_id)
        WHERE d.workspace_id=$1 AND d.pool_id=$2 AND d.plan_id=$3 AND d.decision='APPROVED'
        FOR UPDATE OF p,po`,
      [input.workspaceId, input.poolId, input.planId],
    );
    const row = result.rows[0];
    if (row === undefined) return { ok: false, reason: 'UNKNOWN_PLAN' };
    const now = input.now ?? row.db_now;
    let refusal: Exclude<EligibilityOutcome, { ok: true }>['reason'] | null = null;
    if (row.plan_state !== 'APPROVED' && row.plan_state !== 'DISPATCH_PENDING')
      refusal = 'PLAN_NOT_APPROVED';
    else if (row.plan_digest !== input.digest || row.approval_digest !== input.digest)
      refusal = 'APPROVAL_DIGEST_MISMATCH';
    else if (row.revoked) refusal = 'APPROVAL_REVOKED';
    else if (!(now < row.approval_expires_at)) refusal = 'APPROVAL_EXPIRED';
    else if (!(now < row.submission_deadline_at)) refusal = 'SUBMISSION_DEADLINE_PASSED';
    else if (row.active_policy_version !== row.policy_version)
      refusal = 'POLICY_MANDATE_VERSION_STALE';
    else if (row.current_ledger_revision !== row.approval_ledger_revision)
      refusal = 'LEDGER_REVISION_STALE';
    else if (row.inactive_strategies !== '0') refusal = 'STRATEGY_AUTHORITY_REVOKED';
    else if (row.execution_mode !== input.executionMode) refusal = 'EXECUTION_MODE_MISMATCH';
    else if (input.executionMode === 'APPROVED_HOST' && row.native_digest !== input.digest)
      refusal = 'DISPATCH_NATIVE_CONFIRMATION_MISSING';
    await client.query(
      `INSERT INTO plan_dispatch_eligibility_checks
        (workspace_id,pool_id,approval_id,plan_id,plan_digest,execution_mode,eligible,reason,checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.workspaceId,
        input.poolId,
        row.approval_id,
        input.planId,
        input.digest,
        input.executionMode,
        refusal === null,
        refusal,
        now,
      ],
    );
    if (refusal !== null) return { ok: false, reason: refusal };
    return {
      ok: true,
      approvalId: row.approval_id,
      approvalExpiresAt: row.approval_expires_at,
      submissionDeadlineAt: row.submission_deadline_at,
    };
  }

  async view(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly actor: Principal;
  }): Promise<ApprovalView | null> {
    assertAuthorized(input.actor, 'plan.read', input);
    const result = await this.pool.query<{
      approval_id: string;
      plan_id: string;
      plan_digest: string;
      decision: 'APPROVED' | 'DECLINED';
      execution_mode: ExecutionMode;
      actor_subject_id: string;
      allocation_algorithm_version: string;
      fee_policy_version: string;
      intent_revisions: unknown;
      allocation: unknown;
      strategy_caps: unknown;
      approval_expires_at: Date;
      submission_deadline_at: Date;
      revoked: boolean;
      provider: string | null;
      confirmation_ref: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT d.approval_id,d.plan_id,d.plan_digest,d.decision,d.execution_mode,
              d.actor_subject_id,d.allocation_algorithm_version,d.fee_policy_version,
              d.intent_revisions,d.allocation,d.strategy_caps,d.approval_expires_at,
              d.submission_deadline_at,(r.revocation_id IS NOT NULL) revoked,
              c.provider,c.confirmation_ref,c.confirmed_at
         FROM plan_approval_decisions d
         LEFT JOIN plan_approval_revocations r USING (workspace_id,pool_id,approval_id)
         LEFT JOIN plan_native_confirmations c USING (workspace_id,pool_id,approval_id)
        WHERE d.workspace_id=$1 AND d.pool_id=$2 AND d.plan_id=$3`,
      [input.workspaceId, input.poolId, input.planId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      approvalId: row.approval_id,
      planId: row.plan_id,
      planDigest: row.plan_digest,
      decision: row.decision,
      executionMode: row.execution_mode,
      actorSubjectId: row.actor_subject_id,
      allocationAlgorithmVersion: row.allocation_algorithm_version,
      feePolicyVersion: row.fee_policy_version,
      intentRevisions: row.intent_revisions,
      allocation: row.allocation,
      strategyCaps: row.strategy_caps,
      fifoConsequence:
        'Partial fills allocate in displayed FIFO order; later strategies receive only the remaining filled base.',
      approvalExpiresAt: row.approval_expires_at,
      submissionDeadlineAt: row.submission_deadline_at,
      revoked: row.revoked,
      nativeConfirmation:
        row.provider === null || row.confirmation_ref === null || row.confirmed_at === null
          ? null
          : {
              provider: row.provider,
              confirmationRef: row.confirmation_ref,
              confirmedAt: row.confirmed_at,
            },
    };
  }
}
