import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContractViolation, digestOf } from '@capitaldesk/contracts';
import { principal } from '@capitaldesk/domain';
import { IntentRepository } from './intents.js';
import { LedgerRepository } from './ledger.js';
import { BTC, DATABASE_URL, JournalHarness, POOL, WORKSPACE, sqlState } from './test-harness.js';

const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER = principal({
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'owner-1',
  scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
});
const AGENT = principal({
  kind: 'agent-credential',
  role: 'agent',
  subjectId: 'credential-a',
  scope: { workspaceId: WORKSPACE, poolId: POOL, strategyId: 'strategy-a' },
});

function proposal(revision: string, target = '600', intentId = `intent-${revision}`) {
  return {
    intentId,
    symbol: 'BTCUSDT',
    targetBaseQtyAtoms: target,
    maxBuyPrice: '62000',
    minSellPrice: '59000',
    maxQuoteDebitAtoms: '5000000',
    expiresAt: '2030-01-01T00:00:00.000Z',
    strategyRevision: revision,
    policyVersion: '1',
  } as const;
}

describeIfDatabase('strategy intent journal', () => {
  const harness = new JournalHarness();
  let repository: IntentRepository;

  beforeAll(() => harness.open());
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await harness.seedPolicyVersion();
    repository = new IntentRepository(harness.pool);
  });
  afterEach(() => harness.cleanup());

  it('uses durable idempotency for strategy create and archive lifecycle', async () => {
    const create = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-c',
      displayName: 'Strategy C',
      idempotencyKey: 'create-c',
      actor: OWNER,
    } as const;
    expect(await repository.createStrategy(create)).toEqual({
      created: true,
      version: 1,
      replayed: false,
    });
    expect(await repository.createStrategy(create)).toEqual({
      created: true,
      version: 1,
      replayed: true,
    });
    await expect(
      repository.createStrategy({ ...create, displayName: 'Different C' }),
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_BODY_CONFLICT' });

    const archive = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-c',
      expectedVersion: 1,
      idempotencyKey: 'archive-c',
      actor: OWNER,
    } as const;
    expect(await repository.archiveStrategy(archive)).toMatchObject({
      archived: true,
      version: 2,
      replayed: false,
    });
    expect(await repository.archiveStrategy(archive)).toMatchObject({
      archived: true,
      version: 2,
      replayed: true,
    });
  });

  it('replays one absolute target 100 times without another row or accepted sequence', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        repository.propose({
          workspaceId: WORKSPACE,
          poolId: POOL,
          strategyId: 'strategy-a',
          idempotencyKey: 'target-once',
          proposal: proposal('1'),
          actor: AGENT,
          now: new Date('2029-01-01T00:00:00Z'),
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      new Set(results.map((result) => (result.ok ? result.intent.acceptedSequence : 'x'))),
    ).toEqual(new Set(['1']));
    const rows = await harness.admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM strategy_intents',
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('makes idempotency and revision-content conflicts durable', async () => {
    const base = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    } as const;
    expect(
      await repository.propose({ ...base, idempotencyKey: 'key-a', proposal: proposal('1') }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await repository.propose({
        ...base,
        idempotencyKey: 'key-a',
        proposal: proposal('2', '700'),
      }),
    ).toEqual({ ok: false, reason: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await repository.propose({
        ...base,
        idempotencyKey: 'key-b',
        proposal: proposal('1', '601', 'other-id'),
      }),
    ).toEqual({ ok: false, reason: 'REVISION_CONFLICT' });
    expect(
      await repository.propose({
        ...base,
        idempotencyKey: 'key-b',
        proposal: proposal('3', '800'),
      }),
    ).toEqual({ ok: false, reason: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await repository.propose({
        ...base,
        idempotencyKey: 'key-c',
        proposal: proposal('3', '800'),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await repository.propose({
        ...base,
        idempotencyKey: 'key-d',
        proposal: proposal('2', '700'),
      }),
    ).toEqual({ ok: false, reason: 'REVISION_NOT_MONOTONIC', currentRevision: '3' });
  });

  it('converges simultaneous revisions on the highest accepted revision', async () => {
    const common = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    } as const;
    await Promise.all([
      repository.propose({ ...common, idempotencyKey: 'r2', proposal: proposal('2', '620') }),
      repository.propose({ ...common, idempotencyKey: 'r3', proposal: proposal('3', '630') }),
    ]);
    const current = await harness.admin.query<{ strategy_revision: string; current_count: string }>(
      `SELECT max(strategy_revision)::text AS strategy_revision,
              count(*) FILTER (WHERE is_current)::text AS current_count
         FROM strategy_intents`,
    );
    expect(current.rows[0]).toEqual({ strategy_revision: '3', current_count: '1' });
    const currentRevision = await harness.admin.query<{ strategy_revision: string }>(
      'SELECT strategy_revision::text FROM strategy_intents WHERE is_current',
    );
    expect(currentRevision.rows[0]?.strategy_revision).toBe('3');
  });

  it('queues a revision behind a sealed predecessor without replacing it', async () => {
    await repository.propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'r1',
      proposal: proposal('1'),
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    });
    await harness.admin.query(
      `INSERT INTO plans (workspace_id,pool_id,epoch,plan_id,state,payload,payload_digest)
       VALUES ($1,$2,1,'plan-1','SEALED_AWAITING_APPROVAL','{}',$3)`,
      [WORKSPACE, POOL, digestOf({ plan: 'one' })],
    );
    await harness.admin.query(
      `INSERT INTO intent_plan_bindings
        (workspace_id,pool_id,epoch,intent_id,plan_id,base_direction,base_atoms)
       VALUES ($1,$2,1,'intent-1','plan-1','BUY',100)`,
      [WORKSPACE, POOL],
    );
    const result = await repository.propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'r2',
      proposal: proposal('2', '700'),
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    });
    expect(result).toMatchObject({ ok: true, intent: { disposition: 'QUEUED_NEXT_COHORT' } });
    const rows = await harness.admin.query<{
      intent_id: string;
      is_current: boolean;
      is_next_cohort: boolean;
    }>(
      `SELECT intent_id,is_current,is_next_cohort FROM strategy_intents ORDER BY accepted_sequence`,
    );
    expect(rows.rows).toEqual([
      { intent_id: 'intent-1', is_current: true, is_next_cohort: false },
      { intent_id: 'intent-2', is_current: false, is_next_cohort: true },
    ]);
    expect(
      await IntentRepository.promoteQueuedOn(harness.admin, {
        workspaceId: WORKSPACE,
        poolId: POOL,
      }),
    ).toBe(0);
    await harness.admin.query(
      `UPDATE plans SET state='COMPLETED',version=version+1,updated_at=now() WHERE plan_id='plan-1'`,
    );
    expect(
      await IntentRepository.promoteQueuedOn(harness.admin, {
        workspaceId: WORKSPACE,
        poolId: POOL,
      }),
    ).toBe(1);
    const promoted = await harness.admin.query<{ intent_id: string }>(
      'SELECT intent_id FROM strategy_intents WHERE is_current',
    );
    expect(promoted.rows[0]?.intent_id).toBe('intent-2');
  });

  it('lets an unsealed planner read finish before atomically superseding its revision', async () => {
    await repository.propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'r1',
      proposal: proposal('1'),
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    });
    const planner = await harness.connect();
    await planner.client.query('BEGIN');
    await planner.client.query(
      'SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE',
      [WORKSPACE, POOL],
    );
    await planner.client.query(
      `INSERT INTO plans (workspace_id,pool_id,epoch,plan_id,state,payload,payload_digest)
       VALUES ($1,$2,1,'preview-1','PREVIEW','{}',$3)`,
      [WORKSPACE, POOL, digestOf({ plan: 'preview' })],
    );
    await planner.client.query(
      `INSERT INTO intent_plan_bindings
        (workspace_id,pool_id,epoch,intent_id,plan_id,base_direction,base_atoms)
       VALUES ($1,$2,1,'intent-1','preview-1','BUY',100)`,
      [WORKSPACE, POOL],
    );
    let settled = false;
    const next = repository
      .propose({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-a',
        idempotencyKey: 'r2',
        proposal: proposal('2', '700'),
        actor: AGENT,
        now: new Date('2029-01-01T00:00:00Z'),
      })
      .finally(() => {
        settled = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await planner.client.query('COMMIT');
    expect(await next).toMatchObject({ ok: true, intent: { disposition: 'CURRENT' } });
  });

  it('binds owner deferral to the target key across newer revisions', async () => {
    const deferred = await repository.defer({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      symbol: 'BTCUSDT',
      expectedVersion: 0,
      untilAt: null,
      idempotencyKey: 'defer-1',
      actor: OWNER,
    });
    expect(deferred).toMatchObject({ ok: true, state: 'DEFERRED', version: 1 });
    const proposed = await repository.propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'r9',
      proposal: proposal('9'),
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    });
    expect(proposed).toMatchObject({ ok: true, intent: { disposition: 'DEFERRED' } });
    expect(
      await repository.reinstate({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-a',
        symbol: 'BTCUSDT',
        expectedVersion: 1,
        idempotencyKey: 'reinstate-1',
        actor: OWNER,
      }),
    ).toMatchObject({ ok: true, state: 'ACTIVE', version: 2 });
    let mutation = 'accepted';
    try {
      await harness.admin.query(
        `UPDATE strategy_target_controls SET version=version+1 WHERE strategy_id='strategy-a'`,
      );
    } catch (error) {
      mutation = sqlState(error);
    }
    expect(mutation).toBe('23000');
  });

  it('derives progress from eligible claims and leaves partial residual visible', async () => {
    const ledger = new LedgerRepository(harness.pool);
    await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'opening-progress',
      source: { kind: 'bootstrap', ref: 'progress' },
      description: 'strategy owns 590 base atoms',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: BTC,
          deltaAtoms: 590n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: BTC,
          deltaAtoms: 590n,
        },
      ],
    });
    await repository.propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'r1',
      proposal: proposal('1'),
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    });
    await harness.admin.query(
      `INSERT INTO plans (workspace_id,pool_id,epoch,plan_id,state,payload,payload_digest)
       VALUES ($1,$2,1,'partial-progress','SEALED_AWAITING_APPROVAL','{}',$3)`,
      [WORKSPACE, POOL, digestOf({ plan: 'partial-progress' })],
    );
    await harness.admin.query(
      `INSERT INTO intent_plan_bindings
        (workspace_id,pool_id,epoch,intent_id,plan_id,base_direction,base_atoms)
       VALUES ($1,$2,1,'intent-1','partial-progress','BUY',5)`,
      [WORKSPACE, POOL],
    );
    expect(
      await repository.progress({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-a',
        actor: AGENT,
      }),
    ).toMatchObject({
      direction: 'BUY',
      remainingAtoms: 5n,
      replannable: false,
    });
  });

  it('enforces immutable intent content at the database boundary', async () => {
    await repository.propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'r1',
      proposal: proposal('1'),
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00Z'),
    });
    let state = 'accepted';
    try {
      await harness.admin.query('UPDATE strategy_intents SET target_base_atoms=601');
    } catch (error) {
      state = sqlState(error);
    }
    expect(state).toBe('23001');
  });

  it('refuses another strategy through the principal scope', async () => {
    await expect(
      repository.propose({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-b',
        idempotencyKey: 'cross-scope',
        proposal: proposal('1'),
        actor: AGENT,
        now: new Date('2029-01-01T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(ContractViolation);
  });
});
