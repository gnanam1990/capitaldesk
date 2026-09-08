import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DispatchRepository } from './dispatch.js';
import { GovernanceRepository } from './governance.js';
import { LedgerRepository } from './ledger.js';
import { ObservationRepository } from './observations.js';
import { OutboxRepository } from './outbox.js';
import { enterRestorePosture } from './restore.js';
import { serializable } from './transaction.js';
import {
  ACCOUNT,
  DATABASE_URL,
  JournalHarness,
  POOL,
  USDT,
  WORKSPACE,
  sqlState,
} from './test-harness.js';

/**
 * The maintainer's third exact-head review of PR #2.
 *
 * Each case is the reproduction from one review thread. They are kept together so the round
 * reads as a record; the behaviours they pin are described in the files they exercise.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const HOST = { bootId: 'boot-1', pid: 42, processStartedAt: new Date('2026-09-08T00:00:00Z') };

describeIfDatabase('epoch currency is required wherever authority is created', () => {
  const harness = new JournalHarness();
  let dispatch: DispatchRepository;
  let ledger: LedgerRepository;
  let governance: GovernanceRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await harness.seedGovernanceLease();
    dispatch = new DispatchRepository(harness.pool);
    ledger = new LedgerRepository(harness.pool);
    governance = new GovernanceRepository(harness.pool);
    await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-bootstrap',
      source: { kind: 'bootstrap', ref: 'b' },
      description: 'baseline',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 20_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 20_000n,
        },
      ],
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  /** Close epoch 1 and open epoch 2 directly, as a verified reset would. */
  async function rotateTo2(): Promise<void> {
    await harness.admin.query(
      `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'`,
    );
    await harness.admin.query(
      `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1,$2,2)`,
      [WORKSPACE, POOL],
    );
  }

  it('refuses to rotate while a sealed plan has no terminal outcome, even with no attempt', async () => {
    // The reproduction: an APPROVED plan that never prepared an attempt counted zero
    // unresolved attempts, so rotation closed its epoch and left the plan dispatchable
    // against a baseline that no longer existed.
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: {},
      payloadDigest: 'd',
      state: 'APPROVED',
    });
    expect(
      await governance.rotateEpoch({ workspaceId: WORKSPACE, poolId: POOL, reason: 'reset' }),
    ).toMatchObject({
      ok: false,
      reason: 'PLAN_IN_FLIGHT',
      planIds: ['plan-1'],
    });
    const epochs = await harness.admin.query<{ epoch: number; closed_at: Date | null }>(
      'SELECT epoch, closed_at FROM baseline_epochs ORDER BY epoch',
    );
    expect(epochs.rows).toEqual([{ epoch: 1, closed_at: null }]);
  });

  it('refuses to seal, reserve or prepare against a closed epoch', async () => {
    await rotateTo2();
    expect(
      await dispatch.sealPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        planId: 'plan-old',
        payload: {},
        payloadDigest: 'd',
        state: 'APPROVED',
      }),
    ).toEqual({ ok: false, reason: 'EPOCH_NOT_CURRENT', currentEpoch: 2 });

    // A plan that exists in the closed epoch cannot gain a reservation or an attempt either.
    await harness.admin.query(
      `INSERT INTO plans (workspace_id, pool_id, epoch, plan_id, state, payload, payload_digest)
       VALUES ($1,$2,1,'plan-old','APPROVED','{}','d')`,
      [WORKSPACE, POOL],
    );
    expect(
      await ledger.reserve({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        reservationId: 'res-old',
        strategyId: 'strategy-a',
        planId: 'plan-old',
        asset: USDT,
        atoms: 1_000n,
      }),
    ).toEqual({ ok: false, reason: 'EPOCH_NOT_CURRENT', currentEpoch: 2 });
    expect(
      await dispatch.prepare({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        planId: 'plan-old',
        attemptId: 'attempt-old',
        clientOrderId: 'cd-old',
        dispatchToken: 'tok-old',
      }),
    ).toEqual({ ok: false, reason: 'EPOCH_NOT_CURRENT', currentEpoch: 2 });

    expect((await harness.admin.query('SELECT 1 FROM reservations')).rowCount).toBe(0);
    expect((await harness.admin.query('SELECT 1 FROM dispatch_attempts')).rowCount).toBe(0);
  });

  it('still permits the current epoch', async () => {
    expect(
      await dispatch.sealPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        planId: 'plan-1',
        payload: {},
        payloadDigest: 'd',
        state: 'DISPATCH_PENDING',
      }),
    ).toEqual({ ok: true });
    expect(
      await ledger.reserve({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        reservationId: 'res-1',
        strategyId: 'strategy-a',
        planId: 'plan-1',
        asset: USDT,
        atoms: 1_000n,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await dispatch.prepare({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        planId: 'plan-1',
        attemptId: 'attempt-1',
        clientOrderId: 'cd-1',
        dispatchToken: 'tok-1',
      }),
    ).toEqual({ ok: true });
  });

  it('halts the pool when its lease is released, so nothing economic continues', async () => {
    // Retiring the lease alone left the pool READY, and an approved plan could still mark.
    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' }),
    ).toEqual({ ok: true, plansInvalidated: 0, reservationsReleased: 0, attemptsVoided: 0 });
    const pool = await harness.admin.query<{ state: string }>('SELECT state FROM pools');
    expect(pool.rows[0]?.state).toBe('HALTED');

    await harness.admin.query(
      `INSERT INTO plans (workspace_id, pool_id, epoch, plan_id, state, payload, payload_digest)
       VALUES ($1,$2,1,'plan-1','DISPATCH_PENDING','{}','d')`,
      [WORKSPACE, POOL],
    );
    await harness.admin.query(
      `INSERT INTO dispatch_attempts (workspace_id, pool_id, epoch, attempt_id, plan_id, client_order_id, dispatch_token)
       VALUES ($1,$2,1,'a1','plan-1','cd-1','tok-1')`,
      [WORKSPACE, POOL],
    );
    // Both guards refuse independently: the pool is halted, and the lease is gone.
    expect(
      await dispatch.mark({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'a1',
        outboxId: 'ob-1',
        signedRequest: { t: 1 },
        host: HOST,
      }),
    ).toEqual({ ok: false, reason: 'POOL_NOT_DISPATCHABLE', state: 'HALTED' });
  });
});

describeIfDatabase('a send attempt can never be proven unsent', () => {
  const harness = new JournalHarness();
  let dispatch: DispatchRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await harness.seedGovernanceLease();
    dispatch = new DispatchRepository(harness.pool);
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: {},
      payloadDigest: 'd',
      state: 'DISPATCH_PENDING',
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'a1',
      clientOrderId: 'cd-1',
      dispatchToken: 'tok-1',
    });
    await dispatch.mark({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'a1',
      outboxId: 'ob-1',
      signedRequest: { timestamp: 1 },
      host: HOST,
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  const resolve = (to: 'UNKNOWN' | 'NOT_SENT_PROVEN') =>
    dispatch.resolve({ workspaceId: WORKSPACE, poolId: POOL, attemptId: 'a1', to });

  it('refuses NOT_SENT_PROVEN from a marked attempt, because it cannot prove a non-send', async () => {
    // The fourth review round removed the four caller-supplied booleans this used to accept
    // and discard. Module 04 records no authoritative non-send evidence, so the honest answer
    // is a refusal. review-round-4-not-sent.integration.test.ts holds the full case.
    expect(await resolve('NOT_SENT_PROVEN')).toEqual({
      ok: false,
      reason: 'NOT_SENT_PROVEN_UNAVAILABLE',
    });
    expect(
      (await harness.admin.query<{ state: string }>('SELECT state FROM dispatch_attempts')).rows[0]
        ?.state,
    ).toBe('DISPATCH_MARKED');
  });

  it('refuses it from UNKNOWN too, whichever route the caller takes', async () => {
    await dispatch.recordSendAttempted({ workspaceId: WORKSPACE, poolId: POOL, attemptId: 'a1' });
    await resolve('UNKNOWN');
    expect(await resolve('NOT_SENT_PROVEN')).toEqual({
      ok: false,
      reason: 'NOT_SENT_PROVEN_UNAVAILABLE',
    });
    expect(
      (await harness.admin.query<{ state: string }>('SELECT state FROM dispatch_attempts')).rows[0]
        ?.state,
    ).toBe('UNKNOWN');
  });

  it('refuses a marker with no signed request, and the table refuses one too', async () => {
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'a2',
      clientOrderId: 'cd-2',
      dispatchToken: 'tok-2',
    });
    for (const signedRequest of [null, undefined, 'a string', [1, 2]]) {
      expect(
        await dispatch.mark({
          workspaceId: WORKSPACE,
          poolId: POOL,
          attemptId: 'a2',
          outboxId: 'ob-2',
          signedRequest,
          host: HOST,
        }),
      ).toEqual({ ok: false, reason: 'SIGNED_REQUEST_MISSING' });
    }
    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `UPDATE dispatch_attempts SET state = 'DISPATCH_MARKED', marked_at = now() WHERE attempt_id = 'a2'`,
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23514');
  });

  it('persists the marker process start time, so a reused pid is distinguishable', async () => {
    const row = await harness.admin.query<{
      marker_process_started_at: Date | null;
      marker_pid: number;
    }>(
      `SELECT marker_process_started_at, marker_pid FROM dispatch_attempts WHERE attempt_id = 'a1'`,
    );
    expect(row.rows[0]?.marker_pid).toBe(42);
    expect(row.rows[0]?.marker_process_started_at?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});

describeIfDatabase('restore covers every nonterminal plan without a marker', () => {
  const harness = new JournalHarness();
  let dispatch: DispatchRepository;
  let ledger: LedgerRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await harness.seedGovernanceLease();
    dispatch = new DispatchRepository(harness.pool);
    ledger = new LedgerRepository(harness.pool);
    await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-bootstrap',
      source: { kind: 'bootstrap', ref: 'b' },
      description: 'baseline',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 9_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 9_000n,
        },
      ],
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  for (const state of ['EXECUTING', 'RECONCILING', 'MANUAL_REVIEW'] as const) {
    it(`invalidates a ${state} plan that never reached a marker, and releases its reservation`, async () => {
      // These states look post-marker, which is why they were excluded. A plan can hold them
      // with no attempt that ever marked, and restore then left its reservations live.
      await dispatch.sealPlan({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        planId: 'plan-1',
        payload: {},
        payloadDigest: 'd',
        state: 'DISPATCH_PENDING',
      });
      await ledger.reserve({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        reservationId: 'res-1',
        strategyId: 'strategy-a',
        planId: 'plan-1',
        asset: USDT,
        atoms: 3_000n,
      });
      await harness.admin.query(`UPDATE plans SET state = $1 WHERE plan_id = 'plan-1'`, [state]);

      const posture = await enterRestorePosture(harness.pool, {
        reason: 'restored',
        now: new Date(),
      });
      expect(posture).toMatchObject({ plansInvalidated: 1, reservationsReleased: 1 });
      expect(
        (await harness.admin.query<{ state: string }>('SELECT state FROM plans')).rows[0]?.state,
      ).toBe('INVALIDATED');
      expect(
        (await harness.admin.query<{ state: string }>('SELECT state FROM reservations')).rows[0]
          ?.state,
      ).toBe('RELEASED');
    });
  }

  it('leaves a plan with a real marker exactly as it was', async () => {
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: {},
      payloadDigest: 'd',
      state: 'DISPATCH_PENDING',
    });
    await ledger.reserve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reservationId: 'res-1',
      strategyId: 'strategy-a',
      planId: 'plan-1',
      asset: USDT,
      atoms: 3_000n,
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'a1',
      clientOrderId: 'cd-1',
      dispatchToken: 'tok-1',
    });
    await dispatch.mark({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'a1',
      outboxId: 'ob-1',
      signedRequest: { t: 1 },
      host: HOST,
    });
    await harness.admin.query(`UPDATE plans SET state = 'EXECUTING' WHERE plan_id = 'plan-1'`);

    const posture = await enterRestorePosture(harness.pool, {
      reason: 'restored',
      now: new Date(),
    });
    expect(posture).toMatchObject({
      plansInvalidated: 0,
      reservationsReleased: 0,
      liabilitiesRetained: 1,
    });
    expect(
      (await harness.admin.query<{ state: string }>('SELECT state FROM reservations')).rows[0]
        ?.state,
    ).toBe('HELD');
  });
});

describeIfDatabase('schema guards from the third review', () => {
  const harness = new JournalHarness();

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await harness.seedGovernanceLease();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  async function refusal(sql: string, values: readonly unknown[] = []): Promise<string> {
    try {
      await harness.admin.query(sql, values as unknown[]);
      return 'accepted';
    } catch (error) {
      return sqlState(error);
    }
  }

  it('keeps an outbox message immutable in identity and contents', async () => {
    await serializable(harness.pool, (client) =>
      OutboxRepository.enqueueOn(client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        kind: 'dispatch.send',
        payload: { a: 1 },
        maxAttempts: 1,
      }),
    );
    for (const statement of [
      `UPDATE outbox SET kind = 'pool.event'`,
      `UPDATE outbox SET payload = '{"a":2}'::jsonb`,
      `UPDATE outbox SET max_attempts = 5`,
      `UPDATE outbox SET outbox_id = 'ob-2'`,
      `UPDATE outbox SET attempts = attempts - 1`,
    ]) {
      expect(await refusal(statement), statement).toBe('23001');
    }
    // The lifecycle columns still move.
    expect(
      await refusal(
        `UPDATE outbox SET leased_by = 'w', leased_until = now() + interval '1 minute'`,
      ),
    ).toBe('accepted');
  });

  it('refuses a lease whose account is not its pool account', async () => {
    await harness.admin.query(
      `INSERT INTO venue_accounts (venue, environment, stable_account_id) VALUES ('binance-spot','local','other')`,
    );
    // Retire the seeded lease first, so the single-active index is not what refuses this
    // and the foreign key is genuinely the guard under test.
    await harness.admin.query(
      `UPDATE governance_leases SET released_at = now(), released_reason = 'x'`,
    );
    expect(
      await refusal(
        `INSERT INTO governance_leases (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
         VALUES ('l-bad','binance-spot','local','other',$1,$2)`,
        [WORKSPACE, POOL],
      ),
    ).toBe('23503');
    // Its own account is accepted.
    await harness.admin.query(
      `UPDATE governance_leases SET released_at = now(), released_reason = 'x'`,
    );
    expect(
      await refusal(
        `INSERT INTO governance_leases (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
         VALUES ('l-ok',$3,$4,$5,$1,$2)`,
        [WORKSPACE, POOL, ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId],
      ),
    ).toBe('accepted');
  });

  it('refuses moving an idempotency tombstone to another scope or key', async () => {
    await harness.admin.query(
      `INSERT INTO idempotency_results
         (scope_kind, scope_id, idempotency_key, request_digest, action, response_status, response_body, response_expires_at)
       VALUES ('pool', $1, 'k1', 'digest', 'POOL_HALT', 200, '{}'::jsonb, now() + interval '1 hour')`,
      [`${WORKSPACE}/${POOL}`],
    );
    for (const statement of [
      `UPDATE idempotency_results SET idempotency_key = 'k2'`,
      `UPDATE idempotency_results SET scope_id = 'elsewhere'`,
      `UPDATE idempotency_results SET scope_kind = 'workspace'`,
      // Clearing the body before its retention lapses would lose a replay still owed.
      `UPDATE idempotency_results SET response_body = NULL`,
    ]) {
      expect(await refusal(statement), statement).toBe('23001');
    }
  });

  it('lets the response body be cleared once retention has lapsed', async () => {
    await harness.admin.query(
      `INSERT INTO idempotency_results
         (scope_kind, scope_id, idempotency_key, request_digest, action, response_status, response_body, response_expires_at)
       VALUES ('pool', $1, 'k2', 'digest', 'POOL_HALT', 200, '{}'::jsonb, now() - interval '1 second')`,
      [`${WORKSPACE}/${POOL}`],
    );
    expect(
      await refusal(
        `UPDATE idempotency_results SET response_body = NULL WHERE idempotency_key = 'k2'`,
      ),
    ).toBe('accepted');
  });

  it('refuses a strategy that names a pool which does not exist', async () => {
    expect(
      await refusal(
        `INSERT INTO strategies (workspace_id, pool_id, strategy_id, display_name) VALUES ($1,'pool-ghost','s-ghost','G')`,
        [WORKSPACE],
      ),
    ).toBe('23503');
    expect(
      await refusal(
        `INSERT INTO strategies (workspace_id, pool_id, strategy_id, display_name) VALUES ($1,$2,'s-real','R')`,
        [WORKSPACE, POOL],
      ),
    ).toBe('accepted');
  });
});

describeIfDatabase('retry bounds and JSON null replay', () => {
  const harness = new JournalHarness();

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it('refuses a non-integer or unbounded retry limit before it can loop forever', async () => {
    for (const maxAttempts of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 2.5]) {
      await expect(
        serializable(harness.pool, () => Promise.resolve('unreachable'), { maxAttempts }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      serializable(harness.pool, () => Promise.resolve('ok'), { maxAttempts: 1 }),
    ).resolves.toBe('ok');
  });

  it('replays a stored response whose body is JSON null', async () => {
    const { IdempotencyRepository } = await import('./idempotency.js');
    const idempotency = new IdempotencyRepository(harness.pool);
    const scope = { scopeKind: 'pool' as const, scopeId: `${WORKSPACE}/${POOL}`, key: 'k-null' };
    expect(await idempotency.begin({ ...scope, requestDigest: 'd' })).toEqual({ kind: 'fresh' });
    await serializable(harness.pool, (client) =>
      IdempotencyRepository.recordOn(client, {
        ...scope,
        requestDigest: 'd',
        action: 'POOL_HALT',
        economicRef: null,
        status: 200,
        body: null,
        retentionMs: 60_000,
      }),
    );
    // A stored body of JSON `null` is a retained response, not a discarded one. Reading it
    // through the driver gives JavaScript null either way, so the SQL flag is what separates
    // them; without it this replay reported the response as expired.
    expect(await idempotency.begin({ ...scope, requestDigest: 'd' })).toEqual({
      kind: 'replay',
      status: 200,
      body: null,
    });
  });
});

describeIfDatabase('a fill cites evidence from its own epoch', () => {
  const harness = new JournalHarness();
  let observations: ObservationRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    observations = new ObservationRepository(harness.pool);
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it('refuses an observation from a closed epoch and accepts one from the open epoch', async () => {
    await observations.record({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      observationId: 'obs-1',
      source: 'rest',
      kind: 'trade',
      sourceRef: 't1',
      sourceEventTime: null,
      payload: { t: 1 },
    });
    await harness.admin.query(
      `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'`,
    );
    await harness.admin.query(
      `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1,$2,2)`,
      [WORKSPACE, POOL],
    );
    await observations.recordOrder({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 2,
      symbol: 'BTCUSDT',
      venueOrderId: '7001',
      status: 'FILLED',
    });

    const fill = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 2,
      symbol: 'BTCUSDT',
      venueOrderId: '7001',
      venueTradeId: '9',
      observationId: 'obs-1',
      baseAtoms: 1n,
      quoteAtoms: 10n,
      commission: { asset: USDT, atoms: 0n },
      tradedAt: new Date(),
    };
    // The composite key over (workspace, pool, epoch, observation) is what refuses this; the
    // order-scope check alone never looked at the observation's epoch.
    await expect(observations.recordFill(fill)).rejects.toMatchObject({ code: '23503' });

    await observations.record({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 2,
      observationId: 'obs-2',
      source: 'rest',
      kind: 'trade',
      sourceRef: 't2',
      sourceEventTime: null,
      payload: { t: 2 },
    });
    expect(await observations.recordFill({ ...fill, observationId: 'obs-2' })).toEqual({
      kind: 'recorded',
    });
  });
});
