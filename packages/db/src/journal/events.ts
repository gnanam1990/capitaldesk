import type { Pool } from 'pg';
import type { Principal } from '@capitaldesk/domain';
import { assertAuthorized } from '@capitaldesk/domain';
import { OutboxRepository } from './outbox.js';
import { transactional, type Queryable } from './transaction.js';

export const WORKER_JOB_KINDS = [
  'job.reconcile',
  'job.ingest',
  'job.export',
  'job.webhook',
] as const;
export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

export interface DomainEvent {
  readonly eventId: string;
  readonly type: string;
  readonly subjectRef: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

export class EventRepository {
  constructor(private readonly pool: Pool) {}

  static async appendOn(
    client: Queryable,
    input: {
      readonly workspaceId: string;
      readonly poolId: string;
      readonly type: string;
      readonly subjectRef: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<string> {
    const inserted = await client.query<{ event_id: string }>(
      `INSERT INTO domain_events (workspace_id,pool_id,event_type,subject_ref,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING event_id::text`,
      [
        input.workspaceId,
        input.poolId,
        input.type,
        input.subjectRef,
        JSON.stringify(input.payload),
      ],
    );
    const id = inserted.rows[0]?.event_id;
    if (id === undefined) throw new Error('domain event insert returned no identity');
    return id;
  }

  async list(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly afterEventId: string;
    readonly limit: number;
    readonly actor: Principal;
  }): Promise<readonly DomainEvent[]> {
    assertAuthorized(input.actor, 'pool.read', input);
    if (!/^(0|[1-9][0-9]{0,18})$/.test(input.afterEventId)) {
      throw new TypeError('afterEventId must be a nonnegative decimal cursor');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError('event limit must be between 1 and 100');
    }
    const rows = await this.pool.query<{
      event_id: string;
      event_type: string;
      subject_ref: string;
      payload: unknown;
      occurred_at: Date;
    }>(
      `SELECT event_id::text,event_type,subject_ref,payload,occurred_at FROM domain_events
        WHERE workspace_id=$1 AND pool_id=$2 AND event_id>$3::bigint
        ORDER BY event_id LIMIT $4`,
      [input.workspaceId, input.poolId, input.afterEventId, input.limit],
    );
    return rows.rows.map((row) => ({
      eventId: row.event_id,
      type: row.event_type,
      subjectRef: row.subject_ref,
      payload: row.payload,
      occurredAt: row.occurred_at,
    }));
  }

  enqueueJob(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly jobId: string;
    readonly kind: WorkerJobKind;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly actor: Principal;
  }): Promise<{ readonly replayed: boolean }> {
    assertAuthorized(
      input.actor,
      input.kind === 'job.reconcile' ? 'pool.reconcile' : 'export.create',
      input,
    );
    return transactional(this.pool, async (client) => {
      const prior = await client.query<{ kind: string; payload: unknown }>(
        `SELECT kind,payload FROM outbox WHERE workspace_id=$1 AND pool_id=$2 AND outbox_id=$3
          FOR UPDATE`,
        [input.workspaceId, input.poolId, input.jobId],
      );
      const existing = prior.rows[0];
      if (existing !== undefined) {
        if (
          existing.kind !== input.kind ||
          JSON.stringify(existing.payload) !== JSON.stringify(input.payload)
        ) {
          throw new TypeError('idempotency key was already used for a different job request');
        }
        return { replayed: true };
      }
      await OutboxRepository.enqueueOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        outboxId: input.jobId,
        kind: input.kind,
        payload: input.payload,
        maxAttempts: input.kind === 'job.reconcile' ? 12 : 8,
      });
      await EventRepository.appendOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        type: `${input.kind}.queued`,
        subjectRef: input.jobId,
        payload: { jobId: input.jobId },
      });
      return { replayed: false };
    });
  }
}

export interface PoolOperationalState {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly state: string;
  readonly environment: string;
  readonly epoch: string | null;
  readonly ledgerRevision: string;
  readonly activePolicyVersion: string | null;
  readonly selectedSymbol: string | null;
  readonly pendingJobs: string;
  readonly oldestPendingJobAt: Date | null;
}

export class PublicReadRepository {
  constructor(private readonly pool: Pool) {}

  async poolState(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly actor: Principal;
  }): Promise<PoolOperationalState | null> {
    assertAuthorized(input.actor, 'pool.read', input);
    const result = await this.pool.query<{
      workspace_id: string;
      pool_id: string;
      state: string;
      environment: string;
      epoch: string | null;
      ledger_revision: string;
      active_policy_version: string | null;
      selected_symbol: string | null;
      pending_jobs: string;
      oldest_pending_job_at: Date | null;
    }>(
      `SELECT p.workspace_id,p.pool_id,p.state,p.environment,e.epoch::text,
              p.ledger_revision::text,p.active_policy_version::text,p.selected_symbol,
              (SELECT count(*)::text FROM outbox o WHERE o.workspace_id=p.workspace_id
                 AND o.pool_id=p.pool_id AND o.kind LIKE 'job.%' AND o.published_at IS NULL
                 AND o.dead_lettered_at IS NULL AND o.quarantined_at IS NULL) pending_jobs,
              (SELECT min(created_at) FROM outbox o WHERE o.workspace_id=p.workspace_id
                 AND o.pool_id=p.pool_id AND o.kind LIKE 'job.%' AND o.published_at IS NULL
                 AND o.dead_lettered_at IS NULL AND o.quarantined_at IS NULL) oldest_pending_job_at
         FROM pools p LEFT JOIN baseline_epochs e ON e.workspace_id=p.workspace_id
           AND e.pool_id=p.pool_id AND e.closed_at IS NULL
        WHERE p.workspace_id=$1 AND p.pool_id=$2`,
      [input.workspaceId, input.poolId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          workspaceId: row.workspace_id,
          poolId: row.pool_id,
          state: row.state,
          environment: row.environment,
          epoch: row.epoch,
          ledgerRevision: row.ledger_revision,
          activePolicyVersion: row.active_policy_version,
          selectedSymbol: row.selected_symbol,
          pendingJobs: row.pending_jobs,
          oldestPendingJobAt: row.oldest_pending_job_at,
        };
  }

  async plans(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly afterPlanId: string;
    readonly limit: number;
    readonly actor: Principal;
  }): Promise<readonly Readonly<Record<string, string | null>>[]> {
    assertAuthorized(input.actor, 'plan.read', input);
    const rows = await this.pool.query<{
      plan_id: string;
      epoch: string;
      state: string;
      payload_digest: string;
      version: string;
      created_at: Date;
    }>(
      `SELECT plan_id,epoch::text,state,payload_digest,version::text,created_at FROM plans
        WHERE workspace_id=$1 AND pool_id=$2 AND plan_id>$3
        ORDER BY plan_id LIMIT $4`,
      [input.workspaceId, input.poolId, input.afterPlanId, input.limit],
    );
    return rows.rows.map((row) => ({
      planId: row.plan_id,
      epoch: row.epoch,
      state: row.state,
      planDigest: row.payload_digest,
      version: row.version,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async ledger(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly afterRevision: string;
    readonly limit: number;
    readonly actor: Principal;
  }): Promise<readonly Readonly<Record<string, unknown>>[]> {
    assertAuthorized(input.actor, 'ledger.read', input);
    const rows = await this.pool.query<{
      revision: string;
      ledger_txn_id: string;
      epoch: string;
      source_kind: string;
      source_ref: string;
      posted_at: Date;
      entries: unknown;
    }>(
      `SELECT t.revision::text,t.ledger_txn_id,t.epoch::text,t.source_kind,t.source_ref,t.posted_at,
              jsonb_agg(jsonb_build_object('sequence',e.entry_seq::text,'accountKind',e.account_kind,
                'owner',e.account_owner,'claimState',e.claim_state,'asset',e.asset_code||'@'||e.asset_scale,
                'deltaAtoms',e.delta_atoms::text) ORDER BY e.entry_seq) entries
         FROM ledger_transactions t JOIN ledger_entries e USING (workspace_id,pool_id,ledger_txn_id)
        WHERE t.workspace_id=$1 AND t.pool_id=$2 AND t.revision>$3::bigint
        GROUP BY t.workspace_id,t.pool_id,t.ledger_txn_id,t.revision,t.epoch,t.source_kind,
                 t.source_ref,t.posted_at
        ORDER BY t.revision LIMIT $4`,
      [input.workspaceId, input.poolId, input.afterRevision, input.limit],
    );
    return rows.rows.map((row) => ({
      revision: row.revision,
      transactionId: row.ledger_txn_id,
      epoch: row.epoch,
      source: { kind: row.source_kind, ref: row.source_ref },
      postedAt: row.posted_at.toISOString(),
      entries: row.entries,
    }));
  }

  async strategyPlan(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly planId: string;
    readonly actor: Principal;
  }): Promise<Readonly<Record<string, string>> | null> {
    assertAuthorized(input.actor, 'plan.read', input);
    const result = await this.pool.query<{
      plan_id: string;
      state: string;
      payload_digest: string;
      version: string;
      created_at: Date;
    }>(
      `SELECT DISTINCT p.plan_id,p.state,p.payload_digest,p.version::text,p.created_at
         FROM plans p JOIN intent_plan_bindings b
           ON b.workspace_id=p.workspace_id AND b.pool_id=p.pool_id AND b.plan_id=p.plan_id
         JOIN strategy_intents i
           ON i.workspace_id=b.workspace_id AND i.pool_id=b.pool_id AND i.intent_id=b.intent_id
        WHERE p.workspace_id=$1 AND p.pool_id=$2 AND i.strategy_id=$3 AND p.plan_id=$4`,
      [input.workspaceId, input.poolId, input.strategyId, input.planId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          planId: row.plan_id,
          state: row.state,
          planDigest: row.payload_digest,
          version: row.version,
          createdAt: row.created_at.toISOString(),
        };
  }
}

export interface WorkerJob {
  readonly jobId: string;
  readonly kind: WorkerJobKind;
  readonly payload: unknown;
  readonly attempt: number;
}

export class WorkerQueueRepository {
  constructor(private readonly pool: Pool) {}

  claim(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<WorkerJob | null> {
    return transactional(this.pool, async (client) => {
      const candidate = await client.query<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox
          WHERE workspace_id=$1 AND pool_id=$2 AND kind=ANY($3::text[])
            AND published_at IS NULL AND dead_lettered_at IS NULL AND quarantined_at IS NULL
            AND attempts<max_attempts AND (leased_until IS NULL OR leased_until<=now())
          ORDER BY CASE kind WHEN 'job.reconcile' THEN 0 WHEN 'job.ingest' THEN 1
                             WHEN 'job.export' THEN 2 ELSE 3 END,
                   created_at,outbox_id
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [input.workspaceId, input.poolId, WORKER_JOB_KINDS],
      );
      const jobId = candidate.rows[0]?.outbox_id;
      if (jobId === undefined) return null;
      const claimed = await client.query<{
        kind: WorkerJobKind;
        payload: unknown;
        attempts: number;
      }>(
        `UPDATE outbox SET leased_by=$4,
                           leased_until=now()+($5::bigint*interval '1 millisecond'),
                           attempts=attempts+1
          WHERE workspace_id=$1 AND pool_id=$2 AND outbox_id=$3
          RETURNING kind,payload,attempts`,
        [input.workspaceId, input.poolId, jobId, input.workerId, input.leaseMs],
      );
      const row = claimed.rows[0];
      return row === undefined
        ? null
        : { jobId, kind: row.kind, payload: row.payload, attempt: row.attempts };
    });
  }
}
