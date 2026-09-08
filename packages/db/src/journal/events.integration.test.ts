import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { principal } from '@capitaldesk/domain';
import { EventRepository, PublicReadRepository, WorkerQueueRepository } from './events.js';
import { OutboxRepository } from './outbox.js';
import { DATABASE_URL, JournalHarness, POOL, WORKSPACE } from './test-harness.js';

const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER = principal({
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'owner-events',
  scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
});
const AGENT = principal({
  kind: 'agent-credential',
  role: 'agent',
  subjectId: 'agent-events',
  scope: { workspaceId: WORKSPACE, poolId: POOL, strategyId: 'strategy-a' },
});

describeIfDatabase('durable events and worker jobs', () => {
  const harness = new JournalHarness();
  let events: EventRepository;
  let queue: WorkerQueueRepository;

  beforeAll(() => harness.open());
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    events = new EventRepository(harness.pool);
    queue = new WorkerQueueRepository(harness.pool);
  });
  afterEach(() => harness.cleanup());

  it('streams tenant-scoped append-only events after an exact cursor', async () => {
    const first = await EventRepository.appendOn(harness.admin, {
      workspaceId: WORKSPACE,
      poolId: POOL,
      type: 'plan.sealed',
      subjectRef: 'plan-a',
      payload: { state: 'SEALED_AWAITING_APPROVAL' },
    });
    const second = await EventRepository.appendOn(harness.admin, {
      workspaceId: WORKSPACE,
      poolId: POOL,
      type: 'plan.approved',
      subjectRef: 'plan-a',
      payload: { state: 'APPROVED' },
    });
    await expect(
      events.list({
        workspaceId: WORKSPACE,
        poolId: POOL,
        afterEventId: first,
        limit: 50,
        actor: OWNER,
      }),
    ).resolves.toMatchObject([{ eventId: second, type: 'plan.approved' }]);
    await expect(
      harness.admin.query(`UPDATE domain_events SET event_type='plan.changed'`),
    ).rejects.toThrow(/append-only/);
  });

  it('replays a duplicate job without duplicating its event and rejects a changed body', async () => {
    const enqueue = (reason: string) =>
      events.enqueueJob({
        workspaceId: WORKSPACE,
        poolId: POOL,
        jobId: 'rec-same',
        kind: 'job.reconcile',
        payload: { reason },
        actor: OWNER,
      });
    await expect(enqueue('check drift')).resolves.toEqual({ replayed: false });
    await expect(enqueue('check drift')).resolves.toEqual({ replayed: true });
    await expect(enqueue('different request')).rejects.toThrow(/idempotency/);
    expect((await harness.admin.query(`SELECT 1 FROM domain_events`)).rowCount).toBe(1);
  });

  it('prioritizes unresolved reconciliation over older notification work', async () => {
    for (const [id, kind] of [
      ['export-old', 'job.export'],
      ['webhook-old', 'job.webhook'],
      ['reconcile-new', 'job.reconcile'],
    ] as const) {
      await OutboxRepository.enqueueOn(harness.admin, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: id,
        kind,
        payload: { id },
      });
    }
    await expect(
      queue.claim({ workspaceId: WORKSPACE, poolId: POOL, workerId: 'worker-a', leaseMs: 5000 }),
    ).resolves.toMatchObject({ jobId: 'reconcile-new', kind: 'job.reconcile', attempt: 1 });
  });

  it('never claims a dispatch marker as a retryable worker job', async () => {
    await OutboxRepository.enqueueOn(harness.admin, {
      workspaceId: WORKSPACE,
      poolId: POOL,
      outboxId: 'dispatch-one-shot',
      kind: 'dispatch.send',
      payload: { attemptId: 'attempt-1' },
      maxAttempts: 1,
    });
    await expect(
      queue.claim({ workspaceId: WORKSPACE, poolId: POOL, workerId: 'worker-a', leaseMs: 5000 }),
    ).resolves.toBeNull();
  });

  it('lets concurrent workers claim distinct jobs', async () => {
    for (const id of ['rec-a', 'rec-b']) {
      await OutboxRepository.enqueueOn(harness.admin, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: id,
        kind: 'job.reconcile',
        payload: { id },
      });
    }
    const [a, b] = await Promise.all([
      queue.claim({ workspaceId: WORKSPACE, poolId: POOL, workerId: 'worker-a', leaseMs: 5000 }),
      queue.claim({ workspaceId: WORKSPACE, poolId: POOL, workerId: 'worker-b', leaseMs: 5000 }),
    ]);
    expect(new Set([a?.jobId, b?.jobId])).toEqual(new Set(['rec-a', 'rec-b']));
  });

  it('returns a plan only through a participating strategy scope', async () => {
    await harness.admin.query(
      `INSERT INTO strategy_intents
        (workspace_id,pool_id,epoch,intent_id,strategy_id,symbol,base_asset_code,base_asset_scale,
         quote_asset_code,quote_asset_scale,target_base_atoms,max_buy_price,max_quote_debit_atoms,
         expires_at,strategy_revision,policy_version,idempotency_key,request_digest,state)
       VALUES ($1,$2,1,'intent-agent','strategy-a','BTCUSDT','BTC','v1','USDT','v1',100,
               '65000',1000,'2030-01-01',1,1,'agent-plan-test',$3,'PLANNED')`,
      [WORKSPACE, POOL, `sha256:${'1'.repeat(64)}`],
    );
    await harness.admin.query(
      `INSERT INTO plans (workspace_id,pool_id,epoch,plan_id,state,payload,payload_digest)
       VALUES ($1,$2,1,'plan-agent','COMPLETED','{}',$3)`,
      [WORKSPACE, POOL, `sha256:${'2'.repeat(64)}`],
    );
    await harness.admin.query(
      `INSERT INTO intent_plan_bindings
        (workspace_id,pool_id,epoch,intent_id,plan_id,base_direction,base_atoms)
       VALUES ($1,$2,1,'intent-agent','plan-agent','BUY',100)`,
      [WORKSPACE, POOL],
    );
    const reads = new PublicReadRepository(harness.pool);
    await expect(
      reads.strategyPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-a',
        planId: 'plan-agent',
        actor: AGENT,
      }),
    ).resolves.toMatchObject({ planId: 'plan-agent', state: 'COMPLETED' });
    await expect(
      reads.strategyPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-b',
        planId: 'plan-agent',
        actor: AGENT,
      }),
    ).rejects.toMatchObject({ reason: 'IDENTITY_SCOPE_MISMATCH' });
  });
});
