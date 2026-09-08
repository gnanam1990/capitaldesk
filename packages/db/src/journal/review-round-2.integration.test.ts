import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DispatchRepository } from './dispatch.js';
import { JobLeaseRepository } from './leases.js';
import { LedgerRepository, type AssetRef } from './ledger.js';
import { ObservationRepository } from './observations.js';
import { OutboxRepository } from './outbox.js';
import { enterRestorePosture, enterRestorePostureOn } from './restore.js';
import { serializable } from './transaction.js';
import {
  BTC,
  DATABASE_URL,
  JournalHarness,
  POOL,
  USDT,
  WORKSPACE,
  sqlState,
} from './test-harness.js';

/**
 * Regressions from the maintainer's exact-head review of bcd48de.
 *
 * Each case below reproduced a defect the green suite had not caught. They are kept together
 * so the reproduction reads as one record; the behaviours they pin are also described in the
 * files they exercise.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

/** Poll until `probe` returns a value, bounded. Elapsed-time conditions, never interleavings. */
async function until<T>(
  probe: () => Promise<T | null>,
  what: string,
  deadlineMs = 5000,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeIfDatabase(
  '1. a dispatch message is delivered at most once, even across a crashed holder',
  () => {
    const harness = new JournalHarness();
    let outbox: OutboxRepository;

    beforeAll(async () => {
      await harness.open();
    });
    afterAll(async () => {
      await harness.close();
    });
    beforeEach(async () => {
      await harness.reset();
      await harness.seedPool();
      outbox = new OutboxRepository(harness.pool);
    });
    afterEach(async () => {
      await harness.cleanup();
    });

    it('never returns a claimed dispatch message again after its holder vanishes', async () => {
      await serializable(harness.pool, (client) =>
        OutboxRepository.enqueueOn(client, {
          workspaceId: WORKSPACE,
          poolId: POOL,
          outboxId: 'ob-d',
          kind: 'dispatch.send',
          payload: {},
          maxAttempts: 1,
        }),
      );
      const first = await outbox.claim({
        workspaceId: WORKSPACE,
        poolId: POOL,
        consumerId: 'worker-a',
        leaseMs: 300,
      });
      expect(first).toMatchObject({ outboxId: 'ob-d', attempt: 1 });
      // worker-a neither acknowledges nor fails: it crashed. Its lease lapses.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // The defect: worker-b received the same message as attempt 2.
      expect(
        await outbox.claim({
          workspaceId: WORKSPACE,
          poolId: POOL,
          consumerId: 'worker-b',
          leaseMs: 300,
        }),
      ).toBeNull();

      // And the posture is explicit and durable, not a row left pending forever: the single
      // attempt was consumed and its outcome is unknown. Nothing here authorises a send.
      const row = await harness.admin.query<{
        attempts: number;
        dead_lettered_at: Date | null;
        dead_letter_reason: string | null;
        published_at: Date | null;
      }>(
        `SELECT attempts, dead_lettered_at, dead_letter_reason, published_at FROM outbox WHERE outbox_id = 'ob-d'`,
      );
      expect(row.rows[0]?.attempts).toBe(1);
      expect(row.rows[0]?.published_at).toBeNull();
      expect(row.rows[0]?.dead_lettered_at).not.toBeNull();
      expect(row.rows[0]?.dead_letter_reason).toContain('unknown');
      // Still nothing claimable afterwards.
      expect(
        await outbox.claim({
          workspaceId: WORKSPACE,
          poolId: POOL,
          consumerId: 'worker-c',
          leaseMs: 300,
        }),
      ).toBeNull();
    });

    it('refuses a fail from a holder whose own lease has lapsed', async () => {
      await serializable(harness.pool, (client) =>
        OutboxRepository.enqueueOn(client, {
          workspaceId: WORKSPACE,
          poolId: POOL,
          outboxId: 'ob-e',
          kind: 'pool.event',
          payload: {},
          maxAttempts: 3,
        }),
      );
      expect(
        await outbox.claim({
          workspaceId: WORKSPACE,
          poolId: POOL,
          consumerId: 'worker-a',
          leaseMs: 300,
        }),
      ).toMatchObject({ attempt: 1 });

      // worker-a stalls past its lease and resumes. Nobody else has claimed the message, so
      // it is still recorded as the holder - which is why the check has to be that the lease
      // is live, not merely that the name matches. An earlier version of this test had
      // another worker take the message first, so `leased_by` alone already excluded the
      // stale holder and the liveness clause was never exercised.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(
        await outbox.fail({
          workspaceId: WORKSPACE,
          poolId: POOL,
          outboxId: 'ob-e',
          consumerId: 'worker-a',
          reason: 'late',
        }),
      ).toEqual({ kind: 'not-held' });

      // The late report consumed nothing: the attempt count did not move, the message was not
      // dead-lettered, and it is still deliverable on its remaining attempts.
      const row = await harness.admin.query<{ attempts: number; dead_lettered_at: Date | null }>(
        `SELECT attempts, dead_lettered_at FROM outbox WHERE outbox_id = 'ob-e'`,
      );
      expect(row.rows[0]).toMatchObject({ attempts: 1, dead_lettered_at: null });
      expect(
        await outbox.claim({
          workspaceId: WORKSPACE,
          poolId: POOL,
          consumerId: 'worker-b',
          leaseMs: 5000,
        }),
      ).toMatchObject({ attempt: 2 });
    });

    it('refuses a fail from a worker that never held the message', async () => {
      await serializable(harness.pool, (client) =>
        OutboxRepository.enqueueOn(client, {
          workspaceId: WORKSPACE,
          poolId: POOL,
          outboxId: 'ob-f',
          kind: 'pool.event',
          payload: {},
          maxAttempts: 3,
        }),
      );
      await outbox.claim({
        workspaceId: WORKSPACE,
        poolId: POOL,
        consumerId: 'worker-a',
        leaseMs: 5000,
      });
      expect(
        await outbox.fail({
          workspaceId: WORKSPACE,
          poolId: POOL,
          outboxId: 'ob-f',
          consumerId: 'worker-b',
          reason: 'not mine',
        }),
      ).toEqual({ kind: 'not-held' });
      const row = await harness.admin.query<{ leased_by: string | null }>(
        `SELECT leased_by FROM outbox WHERE outbox_id = 'ob-f'`,
      );
      expect(row.rows[0]?.leased_by).toBe('worker-a');
    });
  },
);

describeIfDatabase('2. restore and marking are mutually safe', () => {
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
    // Marking validates the whole authority chain, so the fixture provides all of it.
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
          deltaAtoms: 10_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 10_000n,
        },
      ],
    });
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
      atoms: 4_000n,
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'attempt-1',
      clientOrderId: 'cd-1',
      dispatchToken: 'tok-1',
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  const mark = (repo: DispatchRepository = dispatch) =>
    repo.mark({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      outboxId: 'ob-1',
      signedRequest: {},
      host: { bootId: 'b', pid: 1 },
    });

  it('cannot mark a prepared attempt whose plan was invalidated by restore', async () => {
    // The exact reproduction: restore first, then mark. On bcd48de the pool was HALTED, the
    // plan INVALIDATED and the reservation RELEASED - and mark still returned ok and wrote a
    // marker with a new send message.
    const posture = await enterRestorePosture(harness.pool, {
      reason: 'restored',
      now: new Date(),
    });
    expect(posture).toMatchObject({
      poolsHalted: 1,
      plansInvalidated: 1,
      reservationsReleased: 1,
      attemptsVoided: 1,
    });

    const marked = await mark();
    expect(marked.ok).toBe(false);
    const attempt = await harness.admin.query<{ state: string; voided_reason: string | null }>(
      `SELECT state, voided_reason FROM dispatch_attempts`,
    );
    expect(attempt.rows[0]?.state).toBe('PREPARED');
    // The honest durable posture: never marked, and recorded as void with the reason.
    expect(attempt.rows[0]?.voided_reason).not.toBeNull();
    expect(
      (await harness.admin.query(`SELECT 1 FROM outbox WHERE kind = 'dispatch.send'`)).rowCount,
    ).toBe(0);

    // A writer that bypasses the repository is refused by the database too.
    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `UPDATE dispatch_attempts SET state = 'DISPATCH_MARKED', marked_at = now()`,
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23001');
  });

  it('refuses to mark while the pool is halted, the plan is not pending, or the lease is gone', async () => {
    await harness.admin.query(`UPDATE pools SET state = 'HALTED'`);
    expect(await mark()).toEqual({ ok: false, reason: 'POOL_NOT_DISPATCHABLE', state: 'HALTED' });
    await harness.admin.query(`UPDATE pools SET state = 'READY'`);

    await harness.admin.query(`UPDATE plans SET state = 'APPROVED'`);
    expect(await mark()).toEqual({ ok: false, reason: 'PLAN_NOT_DISPATCHABLE', state: 'APPROVED' });
    await harness.admin.query(`UPDATE plans SET state = 'DISPATCH_PENDING'`);

    await harness.admin.query(
      `UPDATE governance_leases SET released_at = now(), released_reason = 'closed'`,
    );
    expect(await mark()).toEqual({ ok: false, reason: 'NO_ACTIVE_LEASE' });
  });

  it('under a race, either the marker wins and the reservation stays held, or restore wins and mark is refused', async () => {
    const [marker, restorer, barrier] = await Promise.all([
      harness.connect(),
      harness.connect(),
      harness.connect(),
    ]);
    // Both paths lock the pool row first. Hold it, so they are provably in flight together.
    await barrier.client.query('BEGIN');
    await barrier.client.query(
      `SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE`,
      [WORKSPACE, POOL],
    );

    const both = Promise.all([
      DispatchRepository.markOn(marker.client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'attempt-1',
        outboxId: 'ob-1',
        signedRequest: {},
        host: { bootId: 'b', pid: 1 },
      }),
      enterRestorePostureOn(restorer.client, { reason: 'restored', now: new Date() }),
    ]);
    both.catch(() => undefined);
    try {
      await harness.waitUntilBlockedBy(barrier.pid, [marker.pid, restorer.pid]);
    } finally {
      await barrier.client.query('ROLLBACK').catch(() => undefined);
    }
    const [marked, posture] = await both;

    const attempt = (
      await harness.admin.query<{ state: string; voided_reason: string | null }>(
        'SELECT state, voided_reason FROM dispatch_attempts',
      )
    ).rows[0]!;
    const plan = (await harness.admin.query<{ state: string }>('SELECT state FROM plans')).rows[0]!;
    const reservation = (
      await harness.admin.query<{ state: string }>('SELECT state FROM reservations')
    ).rows[0]!;
    const sends = (await harness.admin.query(`SELECT 1 FROM outbox WHERE kind = 'dispatch.send'`))
      .rowCount;

    if (marked.ok) {
      // (a) the marker won: restore found a marked attempt and left the plan and its
      // reservation exactly as they were - a liability, not a release candidate.
      expect(attempt).toEqual({ state: 'DISPATCH_MARKED', voided_reason: null });
      expect(plan.state).toBe('DISPATCH_PENDING');
      expect(reservation.state).toBe('HELD');
      expect(sends).toBe(1);
      expect(posture).toMatchObject({
        plansInvalidated: 0,
        reservationsReleased: 0,
        liabilitiesRetained: 1,
      });
    } else {
      // (b) restore won: the plan is invalidated, the reservation released, the attempt
      // void, and the marker refused. No send message exists.
      expect(attempt.state).toBe('PREPARED');
      expect(attempt.voided_reason).not.toBeNull();
      expect(plan.state).toBe('INVALIDATED');
      expect(reservation.state).toBe('RELEASED');
      expect(sends).toBe(0);
      expect(posture).toMatchObject({ plansInvalidated: 1, reservationsReleased: 1 });
    }
    // Never both, never neither.
    expect(
      (await harness.admin.query<{ state: string }>('SELECT state FROM pools')).rows[0]?.state,
    ).toBe('HALTED');
  });
});

describeIfDatabase(
  '3. changed evidence under one source key is a conflict, not a duplicate',
  () => {
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

    const base = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      source: 'rest' as const,
      kind: 'trade',
      sourceRef: 'trade-77',
      sourceEventTime: null,
    };

    it('deduplicates an exact repeat and keeps one row', async () => {
      expect(
        await observations.record({
          ...base,
          observationId: 'obs-1',
          payload: { tradeId: 77, qty: '10' },
        }),
      ).toEqual({ kind: 'recorded' });
      expect(
        await observations.record({
          ...base,
          observationId: 'obs-2',
          payload: { tradeId: 77, qty: '10' },
        }),
      ).toEqual({ kind: 'duplicate', observationId: 'obs-1' });
      expect((await harness.admin.query('SELECT 1 FROM raw_observations')).rowCount).toBe(1);
      expect((await harness.admin.query('SELECT 1 FROM evidence_conflicts')).rowCount).toBe(0);
    });

    it('records a conflict, durably, when the payload under the same key differs', async () => {
      await observations.record({
        ...base,
        observationId: 'obs-1',
        payload: { tradeId: 77, qty: '10' },
      });
      // The earlier test called this a duplicate and kept the first. It is not a duplicate: the
      // source has said two different things about one fact.
      const outcome = await observations.record({
        ...base,
        observationId: 'obs-2',
        payload: { tradeId: 77, qty: '11' },
      });
      expect(outcome).toMatchObject({ kind: 'conflict', observationId: 'obs-1' });

      const stored = await harness.admin.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM raw_observations',
      );
      expect(stored.rowCount).toBe(1);
      expect(stored.rows[0]?.payload).toEqual({ tradeId: 77, qty: '10' });
      const conflicts = await harness.admin.query<{
        subject_kind: string;
        subject_ref: string;
        incoming: Record<string, unknown>;
      }>('SELECT subject_kind, subject_ref, incoming FROM evidence_conflicts');
      expect(conflicts.rowCount).toBe(1);
      expect(conflicts.rows[0]).toMatchObject({
        subject_kind: 'observation',
        subject_ref: 'obs-1',
      });
      expect(conflicts.rows[0]?.incoming).toMatchObject({ payload: { tradeId: 77, qty: '11' } });
      // Conflict evidence is append-only.
      let refusal = 'accepted';
      try {
        await harness.admin.query('DELETE FROM evidence_conflicts');
      } catch (error) {
        refusal = sqlState(error);
      }
      expect(refusal).toBe('23001');
    });

    it('compares raw bytes when the adapter supplies them', async () => {
      await observations.record({
        ...base,
        observationId: 'obs-1',
        payload: { tradeId: 77 },
        rawText: '{"tradeId":77}',
      });
      expect(
        await observations.record({
          ...base,
          observationId: 'obs-2',
          payload: { tradeId: 77 },
          rawText: '{"tradeId":77}',
        }),
      ).toEqual({ kind: 'duplicate', observationId: 'obs-1' });
      expect(
        await observations.record({
          ...base,
          observationId: 'obs-3',
          payload: { tradeId: 77 },
          rawText: '{"tradeId":77,"qty":"1"}',
        }),
      ).toMatchObject({ kind: 'conflict' });
    });
  },
);

describeIfDatabase(
  '4. venue order observations progress forward and contradictions are evidence',
  () => {
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

    const order = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: '5001',
    };

    it('advances NEW -> PARTIALLY_FILLED -> FILLED, versioning each step', async () => {
      expect(await observations.recordOrder({ ...order, status: 'NEW' })).toEqual({
        kind: 'recorded',
      });
      expect(await observations.recordOrder({ ...order, status: 'PARTIALLY_FILLED' })).toEqual({
        kind: 'progressed',
        from: 'NEW',
        to: 'PARTIALLY_FILLED',
        version: 2,
      });
      expect(await observations.recordOrder({ ...order, status: 'FILLED' })).toEqual({
        kind: 'progressed',
        from: 'PARTIALLY_FILLED',
        to: 'FILLED',
        version: 3,
      });
      const row = await harness.admin.query<{
        status: string;
        version: number;
        first_observed_at: Date;
        last_observed_at: Date;
      }>('SELECT status, version, first_observed_at, last_observed_at FROM venue_orders');
      expect(row.rows[0]).toMatchObject({ status: 'FILLED', version: 3 });
      expect(row.rows[0]!.last_observed_at.getTime()).toBeGreaterThanOrEqual(
        row.rows[0]!.first_observed_at.getTime(),
      );
    });

    it('treats a repeated status as a duplicate and an older status as stale, without rewriting', async () => {
      await observations.recordOrder({ ...order, status: 'PARTIALLY_FILLED' });
      expect(await observations.recordOrder({ ...order, status: 'PARTIALLY_FILLED' })).toEqual({
        kind: 'duplicate',
      });
      // An older status arriving late is out of order, not a contradiction.
      expect(await observations.recordOrder({ ...order, status: 'NEW' })).toEqual({
        kind: 'stale',
        current: 'PARTIALLY_FILLED',
      });
      expect(
        (await harness.admin.query<{ version: number }>('SELECT version FROM venue_orders')).rows[0]
          ?.version,
      ).toBe(1);
    });

    it('records a terminal contradiction as conflict evidence and keeps the stored status', async () => {
      await observations.recordOrder({ ...order, status: 'FILLED' });
      const outcome = await observations.recordOrder({ ...order, status: 'CANCELED' });
      expect(outcome).toMatchObject({ kind: 'conflict', current: 'FILLED', incoming: 'CANCELED' });
      expect(
        (await harness.admin.query<{ status: string }>('SELECT status FROM venue_orders')).rows[0]
          ?.status,
      ).toBe('FILLED');
      const conflicts = await harness.admin.query<{ subject_kind: string; subject_ref: string }>(
        'SELECT subject_kind, subject_ref FROM evidence_conflicts',
      );
      expect(conflicts.rows).toEqual([
        { subject_kind: 'order-status', subject_ref: 'BTCUSDT/5001' },
      ]);
    });

    it('still accepts a late fill after the terminal status, and a fill needs its order', async () => {
      await harness.admin.query(
        `INSERT INTO raw_observations (workspace_id, pool_id, epoch, observation_id, source, kind, source_ref, payload, payload_digest)
       VALUES ($1, $2, 1, 'obs-late', 'rest', 'trade', 'trade-9', '{}'::jsonb, 'x')`,
        [WORKSPACE, POOL],
      );
      await observations.recordOrder({ ...order, status: 'EXPIRED' });
      expect(
        await observations.recordFill({
          ...order,
          venueTradeId: '9',
          observationId: 'obs-late',
          baseAtoms: 1n,
          quoteAtoms: 10n,
          commission: { asset: USDT, atoms: 0n },
          tradedAt: new Date(),
        }),
      ).toEqual({ kind: 'recorded' });
    });
  },
);

describeIfDatabase('5. job lease races and the clock', () => {
  const harness = new JournalHarness();
  let leases: JobLeaseRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    leases = new JobLeaseRepository(harness.pool);
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it('gives one typed winner and one typed HELD when two acquirers race for a lease that does not exist yet', async () => {
    const [left, right, barrier] = await Promise.all([
      harness.connect(),
      harness.connect(),
      harness.connect(),
    ]);
    // No row exists to lock, so the barrier is the table: an EXCLUSIVE lock blocks the
    // acquirers' first statement until it is released.
    await barrier.client.query('BEGIN');
    await barrier.client.query('LOCK TABLE job_leases IN EXCLUSIVE MODE');
    const both = Promise.all([
      JobLeaseRepository.acquireOn(left.client, {
        leaseKey: 'fresh',
        holderId: 'L',
        ttlMs: 10_000,
      }),
      JobLeaseRepository.acquireOn(right.client, {
        leaseKey: 'fresh',
        holderId: 'R',
        ttlMs: 10_000,
      }),
    ]);
    both.catch(() => undefined);
    try {
      await harness.waitUntilBlockedBy(barrier.pid, [left.pid, right.pid]);
    } finally {
      await barrier.client.query('ROLLBACK').catch(() => undefined);
    }
    // The defect: the loser surfaced a raw unique violation instead of a decision.
    const [a, b] = await both;
    const winners = [a, b].filter((o) => o.ok);
    const held = [a, b].filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ ok: false, reason: 'HELD' });
    expect(winners[0]).toMatchObject({ ok: true, fencingToken: 1n });
  });

  it('decides expiry on the database clock, so a caller cannot take over early by its own watch', async () => {
    const first = await leases.acquire({ leaseKey: 'k', holderId: 'A', ttlMs: 600 });
    expect(first).toMatchObject({ ok: true, fencingToken: 1n });
    // There is no `now` to pass: a worker with a fast clock has no way to claim the lease has
    // lapsed. Immediately after acquisition it is held.
    expect(await leases.acquire({ leaseKey: 'k', holderId: 'B', ttlMs: 600 })).toMatchObject({
      ok: false,
      reason: 'HELD',
      holderId: 'A',
    });
    // And after the database says it lapsed, it is taken over with the next token.
    const takeover = await until(async () => {
      const outcome = await leases.acquire({ leaseKey: 'k', holderId: 'B', ttlMs: 600 });
      return outcome.ok ? outcome : null;
    }, 'lease takeover after expiry');
    expect(takeover).toMatchObject({ ok: true, fencingToken: 2n });
    expect(
      await leases.renew({ leaseKey: 'k', holderId: 'A', fencingToken: 1n, ttlMs: 600 }),
    ).toEqual({ ok: false, reason: 'STALE_TOKEN', currentToken: 2n });
  });
});

describeIfDatabase('6. a committed ledger transaction has a final entry set', () => {
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
    const ledger = new LedgerRepository(harness.pool);
    await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-1',
      source: { kind: 'bootstrap', ref: 'b' },
      description: 'baseline',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 10n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 10n,
        },
      ],
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  const append = async (
    seq: number,
    owner: string,
    atoms: number,
    kind = 'STRATEGY',
    claim = 'AVAILABLE',
  ) => {
    try {
      await harness.admin.query(
        `INSERT INTO ledger_entries VALUES ($1,$2,'txn-1',$3,$4,$5,$6,'USDT','v1',$7::numeric)`,
        [WORKSPACE, POOL, seq, kind, owner, claim, atoms],
      );
      return 'accepted';
    } catch (error) {
      return sqlState(error);
    }
  };

  it('refuses an unbalancing entry appended after the posting committed', async () => {
    // The defect: the balance check is a deferred trigger on ledger_transactions, so it fires
    // at the commit that inserted the parent and never again. A later entry against that same
    // transaction left control at 10 against claims of 1009.
    expect(await append(3, 'strategy-a', 999)).toBe('23001');
    const totals = await harness.admin.query<{ control: string; claims: string }>(
      `SELECT sum(delta_atoms) FILTER (WHERE account_kind = 'ASSET_CONTROL')::text AS control,
              sum(delta_atoms) FILTER (WHERE account_kind <> 'ASSET_CONTROL')::text AS claims
         FROM ledger_entries`,
    );
    expect(totals.rows[0]).toEqual({ control: '10', claims: '10' });
  });

  it('refuses a later append even when the appended pair would balance', async () => {
    // Making only unbalanced appends fail would leave the record editable after the fact. A
    // committed posting is final, balanced or not.
    expect(await append(4, 'ASSET_CONTROL', 5, 'ASSET_CONTROL', 'CONTROL')).toBe('23001');
    expect(await append(5, 'strategy-a', 5)).toBe('23001');
    expect((await harness.admin.query('SELECT 1 FROM ledger_entries')).rowCount).toBe(2);
  });

  it('still creates a posting and all its entries atomically', async () => {
    const ledger = new LedgerRepository(harness.pool);
    const posted = await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-2',
      source: { kind: 'fill', ref: 'f1' },
      description: 'fill',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 3n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 3n,
        },
      ],
    });
    expect(posted).toMatchObject({ ok: true });
    expect(
      (await harness.admin.query(`SELECT 1 FROM ledger_entries WHERE ledger_txn_id = 'txn-2'`))
        .rowCount,
    ).toBe(2);
  });
});

describeIfDatabase('7. economic references cannot cross workspace, pool or epoch', () => {
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
    await harness.admin.query(
      `INSERT INTO plans (workspace_id, pool_id, epoch, plan_id, state, payload, payload_digest)
       VALUES ($1,$2,1,'pl1','DISPATCH_PENDING','{}','d')`,
      [WORKSPACE, POOL],
    );
    await harness.admin.query(
      `INSERT INTO dispatch_attempts (workspace_id, pool_id, epoch, attempt_id, plan_id, client_order_id, dispatch_token)
       VALUES ($1,$2,1,'a1','pl1','cd-A','tok-A')`,
      [WORKSPACE, POOL],
    );
    await harness.admin.query(
      `INSERT INTO raw_observations (workspace_id, pool_id, epoch, observation_id, source, kind, source_ref, payload, payload_digest)
       VALUES ($1,$2,1,'obs-1','rest','trade','t1','{}','x')`,
      [WORKSPACE, POOL],
    );
    await harness.admin.query(
      `INSERT INTO venue_orders (workspace_id, pool_id, epoch, symbol, venue_order_id, status)
       VALUES ($1,$2,1,'BTCUSDT','5001','FILLED')`,
      [WORKSPACE, POOL],
    );
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  async function attempt(sql: string, values: readonly unknown[]): Promise<string> {
    try {
      await harness.admin.query(sql, values as unknown[]);
      return 'accepted';
    } catch (error) {
      return sqlState(error);
    }
  }

  it('refuses a fill citing evidence from another epoch, and accepts one from its own', async () => {
    await harness.admin.query(
      `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'`,
    );
    await harness.admin.query(
      `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1,$2,2)`,
      [WORKSPACE, POOL],
    );
    await harness.admin.query(
      `INSERT INTO venue_orders (workspace_id, pool_id, epoch, symbol, venue_order_id, status) VALUES ($1,$2,2,'BTCUSDT','7001','FILLED')`,
      [WORKSPACE, POOL],
    );
    const fill = `INSERT INTO venue_fills VALUES ($1,$2,$3,'BTCUSDT',$4,$5,'obs-1',1,1,'USDT:v1',0,now(),now())`;
    expect(await attempt(fill, [WORKSPACE, POOL, 2, '7001', 'tr-cross'])).toBe('23503');
    expect(await attempt(fill, [WORKSPACE, POOL, 1, '5001', 'tr-same'])).toBe('accepted');
  });

  it('refuses an order correlating to a client id marked in another workspace and pool', async () => {
    await harness.admin.query(
      `INSERT INTO workspaces (workspace_id, display_name) VALUES ('ws-other','Other')`,
    );
    await harness.admin.query(
      `INSERT INTO venue_accounts (venue, environment, stable_account_id) VALUES ('binance-spot','local','acct-other')`,
    );
    await harness.admin.query(
      `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id, state)
       VALUES ('ws-other','pool-other','binance-spot','local','acct-other','READY')`,
    );
    await harness.admin.query(
      `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ('ws-other','pool-other',1)`,
    );

    const order = `INSERT INTO venue_orders (workspace_id, pool_id, epoch, symbol, venue_order_id, client_order_id, status) VALUES ($1,$2,1,'BTCUSDT',$3,$4,'NEW')`;
    expect(await attempt(order, ['ws-other', 'pool-other', '9001', 'cd-A'])).toBe('23503');
    // Its own scope correlates, and an order we never marked is external activity with no
    // correlation rather than an invented one.
    expect(await attempt(order, [WORKSPACE, POOL, '5002', 'cd-A'])).toBe('accepted');
    expect(await attempt(order, ['ws-other', 'pool-other', '9002', null])).toBe('accepted');
  });

  it('refuses an applied observation naming a ledger transaction that does not exist', async () => {
    expect(
      await attempt(`UPDATE raw_observations SET applied_ledger_txn_id = 'does-not-exist'`, []),
    ).toBe('23503');
    const ledger = new LedgerRepository(harness.pool);
    await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-real',
      source: { kind: 'fill', ref: 'f' },
      description: 'fill',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 1n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 1n,
        },
      ],
    });
    expect(
      await attempt(`UPDATE raw_observations SET applied_ledger_txn_id = 'txn-real'`, []),
    ).toBe('accepted');
  });

  it('refuses economic ownership by a strategy that is not in this pool', async () => {
    const reservation = `INSERT INTO reservations (workspace_id, pool_id, epoch, reservation_id, strategy_id, plan_id, asset_code, asset_scale, reserved_atoms)
                         VALUES ($1,$2,1,$3,$4,'pl1','USDT','v1',1)`;
    expect(await attempt(reservation, [WORKSPACE, POOL, 'r-ghost', 'ghost'])).toBe('23503');
    expect(await attempt(reservation, [WORKSPACE, POOL, 'r-real', 'strategy-a'])).toBe('accepted');

    // The ledger's owner column carries HOUSE and ASSET_CONTROL too, so it cannot be a key;
    // the same guarantee comes from a trigger over the same scope tuple.
    const ledger = new LedgerRepository(harness.pool);
    await expect(
      ledger.postTransaction({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        ledgerTxnId: 'txn-ghost',
        source: { kind: 'fill', ref: 'g' },
        description: 'ghost owner',
        entries: [
          {
            accountKind: 'ASSET_CONTROL',
            owner: 'ASSET_CONTROL',
            claimState: 'CONTROL',
            asset: USDT,
            deltaAtoms: 1n,
          },
          {
            accountKind: 'STRATEGY',
            owner: 'ghost',
            claimState: 'AVAILABLE',
            asset: USDT,
            deltaAtoms: 1n,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describeIfDatabase('8. a reservation cannot be released beyond what it still holds', () => {
  const harness = new JournalHarness();
  let ledger: LedgerRepository;
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
    ledger = new LedgerRepository(harness.pool);
    dispatch = new DispatchRepository(harness.pool);
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
      atoms: 15_000n,
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  /** A fill consuming part of the reservation, as the executor's reconciliation would post it. */
  const consume = (atoms: bigint) =>
    ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: `txn-fill-${atoms}`,
      source: { kind: 'fill', ref: `fill-${atoms}` },
      description: 'fill',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: -atoms,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'RESERVED',
          asset: USDT,
          deltaAtoms: -atoms,
          reservationId: 'res-1',
        },
      ],
    });

  it('refuses a release larger than the remainder after a fill consumed part of it', async () => {
    // The exact reproduction: reserve 15,000, let a fill consume 14,000, then release the
    // full 15,000. It returned ok, leaving AVAILABLE at 20,000 and RESERVED at -14,000, and
    // only the projection rebuild noticed - afterwards.
    expect(await consume(14_000n)).toMatchObject({ ok: true });
    expect(
      await ledger.remainingOf({ workspaceId: WORKSPACE, poolId: POOL, reservationId: 'res-1' }),
    ).toBe(1_000n);

    expect(
      await ledger.release({
        workspaceId: WORKSPACE,
        poolId: POOL,
        reservationId: 'res-1',
        atoms: 15_000n,
        source: { kind: 'release', ref: 'res-1' },
      }),
    ).toEqual({ ok: false, reason: 'EXCEEDS_REMAINING', remainingAtoms: 1_000n });

    // Nothing moved, and the claims are exactly where the postings put them.
    const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
    expect(balances).toContainEqual({
      owner: 'strategy-a',
      asset: USDT,
      availableAtoms: 5_000n,
      reservedAtoms: 1_000n,
      quarantinedAtoms: 0n,
    });
    expect(
      (await harness.admin.query(`SELECT 1 FROM reservations WHERE state = 'HELD'`)).rowCount,
    ).toBe(1);
  });

  it('releases exactly the proven remainder, and refuses a second release', async () => {
    expect(await consume(14_000n)).toMatchObject({ ok: true });
    expect(
      await ledger.release({
        workspaceId: WORKSPACE,
        poolId: POOL,
        reservationId: 'res-1',
        atoms: 1_000n,
        source: { kind: 'release', ref: 'res-1' },
      }),
    ).toMatchObject({ ok: true });

    const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
    expect(balances).toContainEqual({
      owner: 'strategy-a',
      asset: USDT,
      availableAtoms: 6_000n,
      reservedAtoms: 0n,
      quarantinedAtoms: 0n,
    });
    expect(
      await ledger.remainingOf({ workspaceId: WORKSPACE, poolId: POOL, reservationId: 'res-1' }),
    ).toBe(0n);
    // The reservation is closed, so a second release is refused on its state.
    expect(
      await ledger.release({
        workspaceId: WORKSPACE,
        poolId: POOL,
        reservationId: 'res-1',
        atoms: 1n,
        source: { kind: 'release', ref: 'res-1-again' },
      }),
    ).toEqual({ ok: false, reason: 'NOT_HELD', state: 'RELEASED' });
  });

  it('refuses a fill that would consume more than the reservation holds', async () => {
    await expect(consume(15_001n)).rejects.toMatchObject({ code: '23000' });
    expect(
      await ledger.remainingOf({ workspaceId: WORKSPACE, poolId: POOL, reservationId: 'res-1' }),
    ).toBe(15_000n);
  });

  it('refuses a balanced posting that would drive any claim aggregate negative', async () => {
    // Balancing per asset is not the same guarantee: this posting balances and still leaves a
    // claim below zero. Direct postTransaction callers are held to it too, at COMMIT.
    await expect(
      ledger.postTransaction({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        ledgerTxnId: 'txn-negative',
        source: { kind: 'adjust', ref: 'n1' },
        description: 'quarantine more than is held',
        entries: [
          {
            accountKind: 'STRATEGY',
            owner: 'strategy-b',
            claimState: 'AVAILABLE',
            asset: USDT,
            deltaAtoms: -1n,
          },
          {
            accountKind: 'STRATEGY',
            owner: 'strategy-b',
            claimState: 'QUARANTINED',
            asset: USDT,
            deltaAtoms: 1n,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: '23000' });

    // And the raw path, which is how the defect was first demonstrated. A fill has consumed
    // 14,000 of the 15,000 reserved, so releasing another 14,000 by hand takes the
    // reservation - and the strategy's RESERVED claim - below zero.
    expect(await consume(14_000n)).toMatchObject({ ok: true });
    let refusal = 'accepted';
    try {
      await harness.admin.query('BEGIN');
      await harness.admin.query(
        `INSERT INTO ledger_transactions (workspace_id, pool_id, epoch, ledger_txn_id, revision, source_kind, source_ref, description)
         VALUES ($1, $2, 1, 'txn-raw', 99, 'adjust', 'raw', 'x')`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query(
        `INSERT INTO ledger_entries VALUES ($1,$2,'txn-raw',1,'STRATEGY','strategy-a','RESERVED','USDT','v1',-14000,'res-1')`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query(
        `INSERT INTO ledger_entries VALUES ($1,$2,'txn-raw',2,'STRATEGY','strategy-a','AVAILABLE','USDT','v1',14000,NULL)`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query('COMMIT');
    } catch (error) {
      refusal = sqlState(error);
      await harness.admin.query('ROLLBACK').catch(() => undefined);
    }
    expect(refusal).toBe('23000');
  });

  it('requires a RESERVED movement to name its reservation, and only a RESERVED one', async () => {
    let unattributed = 'accepted';
    try {
      await harness.admin.query('BEGIN');
      await harness.admin.query(
        `INSERT INTO ledger_transactions (workspace_id, pool_id, epoch, ledger_txn_id, revision, source_kind, source_ref, description)
         VALUES ($1, $2, 1, 'txn-anon', 98, 'adjust', 'anon', 'x')`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query(
        `INSERT INTO ledger_entries VALUES ($1,$2,'txn-anon',1,'STRATEGY','strategy-a','RESERVED','USDT','v1',-1,NULL)`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query('COMMIT');
    } catch (error) {
      unattributed = sqlState(error);
      await harness.admin.query('ROLLBACK').catch(() => undefined);
    }
    expect(unattributed).toBe('23514');
  });
});

describeIfDatabase(
  '9. contradictory fill and correlation evidence is a conflict, never a duplicate',
  () => {
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
      await harness.seedGovernanceLease();
      observations = new ObservationRepository(harness.pool);
      await harness.admin.query(
        `INSERT INTO raw_observations (workspace_id, pool_id, epoch, observation_id, source, kind, source_ref, payload, payload_digest)
       VALUES ($1,$2,1,'obs-1','rest','trade','t1','{}','x'), ($1,$2,1,'obs-2','stream','trade','t2','{}','y')`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query(
        `INSERT INTO plans (workspace_id, pool_id, epoch, plan_id, state, payload, payload_digest)
       VALUES ($1,$2,1,'pl1','DISPATCH_PENDING','{}','d')`,
        [WORKSPACE, POOL],
      );
      await harness.admin.query(
        `INSERT INTO dispatch_attempts (workspace_id, pool_id, epoch, attempt_id, plan_id, client_order_id, dispatch_token)
       VALUES ($1,$2,1,'a1','pl1','cd-1','tok-1'), ($1,$2,1,'a2','pl1','cd-2','tok-2')`,
        [WORKSPACE, POOL],
      );
      await observations.recordOrder({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        symbol: 'BTCUSDT',
        venueOrderId: '5001',
        status: 'PARTIALLY_FILLED',
      });
    });
    afterEach(async () => {
      await harness.cleanup();
    });

    const fill = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: '5001',
      venueTradeId: '77',
      observationId: 'obs-1',
      baseAtoms: 10n,
      quoteAtoms: 100n,
      commission: { asset: USDT as AssetRef, atoms: 1n },
      tradedAt: new Date('2026-09-08T00:00:00.000Z'),
    };

    it('dedupes an exact repeat of a fill', async () => {
      expect(await observations.recordFill(fill)).toEqual({ kind: 'recorded' });
      expect(await observations.recordFill({ ...fill })).toEqual({ kind: 'already-recorded' });
      expect((await harness.admin.query('SELECT 1 FROM venue_fills')).rowCount).toBe(1);
      expect((await harness.admin.query('SELECT 1 FROM evidence_conflicts')).rowCount).toBe(0);
    });

    it('records a conflict for every changed economic field, without rewriting the stored fill', async () => {
      await observations.recordFill(fill);
      const changes: Array<[string, Partial<typeof fill>]> = [
        ['baseAtoms', { baseAtoms: 11n }],
        ['quoteAtoms', { quoteAtoms: 101n }],
        ['commissionAtoms', { commission: { asset: USDT, atoms: 2n } }],
        ['commissionAsset', { commission: { asset: BTC, atoms: 1n } }],
        ['tradedAt', { tradedAt: new Date('2026-09-08T00:00:01.000Z') }],
        ['observationId', { observationId: 'obs-2' }],
      ];
      for (const [field, change] of changes) {
        const outcome = await observations.recordFill({ ...fill, ...change });
        expect(outcome, field).toMatchObject({ kind: 'conflict' });
        expect((outcome as unknown as { changed: string[] }).changed, field).toContain(field);
      }

      // The stored evidence is exactly what was first recorded.
      const stored = await harness.admin.query<{
        observation_id: string;
        base_atoms: string;
        quote_atoms: string;
        commission_asset: string;
        commission_atoms: string;
      }>(
        `SELECT observation_id, base_atoms::text, quote_atoms::text, commission_asset, commission_atoms::text FROM venue_fills`,
      );
      expect(stored.rowCount).toBe(1);
      expect(stored.rows[0]).toEqual({
        observation_id: 'obs-1',
        base_atoms: '10',
        quote_atoms: '100',
        commission_asset: 'USDT:v1',
        commission_atoms: '1',
      });
      const conflicts = await harness.admin.query<{ subject_kind: string; subject_ref: string }>(
        `SELECT subject_kind, subject_ref FROM evidence_conflicts`,
      );
      expect(conflicts.rowCount).toBe(changes.length);
      expect(
        conflicts.rows.every(
          (row) => row.subject_kind === 'fill' && row.subject_ref === 'BTCUSDT/5001/77',
        ),
      ).toBe(true);
    });

    it('refuses to rewrite a stored fill even by direct SQL', async () => {
      await observations.recordFill(fill);
      for (const statement of [
        `UPDATE venue_fills SET base_atoms = 11`,
        `DELETE FROM venue_fills`,
      ]) {
        let refusal = 'accepted';
        try {
          await harness.admin.query(statement);
        } catch (error) {
          refusal = sqlState(error);
        }
        expect(refusal, statement).toBe('23001');
      }
    });

    it('learns a correlation it did not have, and refuses a different one', async () => {
      const order = {
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        symbol: 'BTCUSDT',
        venueOrderId: '5001',
      };
      // Nothing correlated yet, so the first client id is new information on the duplicate path.
      expect(
        await observations.recordOrder({
          ...order,
          status: 'PARTIALLY_FILLED',
          clientOrderId: 'cd-1',
        }),
      ).toEqual({ kind: 'duplicate' });
      expect(
        (
          await harness.admin.query<{ client_order_id: string }>(
            'SELECT client_order_id FROM venue_orders',
          )
        ).rows[0]?.client_order_id,
      ).toBe('cd-1');

      // A second, different attempt claiming the same venue order is a conflict on both paths -
      // the duplicate-status path and the progressed-status path. `coalesce` had silently kept
      // the first on both.
      expect(
        await observations.recordOrder({
          ...order,
          status: 'PARTIALLY_FILLED',
          clientOrderId: 'cd-2',
        }),
      ).toMatchObject({
        kind: 'correlation-conflict',
        current: 'cd-1',
        incoming: 'cd-2',
      });
      expect(
        await observations.recordOrder({ ...order, status: 'FILLED', clientOrderId: 'cd-2' }),
      ).toMatchObject({
        kind: 'correlation-conflict',
        current: 'cd-1',
        incoming: 'cd-2',
      });

      // Neither the correlation nor the status moved.
      const row = await harness.admin.query<{
        client_order_id: string;
        status: string;
        version: number;
      }>('SELECT client_order_id, status, version FROM venue_orders');
      expect(row.rows[0]).toMatchObject({
        client_order_id: 'cd-1',
        status: 'PARTIALLY_FILLED',
        version: 1,
      });
      const conflicts = await harness.admin.query<{ subject_kind: string }>(
        'SELECT subject_kind FROM evidence_conflicts',
      );
      expect(conflicts.rows.map((r) => r.subject_kind)).toEqual([
        'order-correlation',
        'order-correlation',
      ]);

      // An observation carrying no correlation still advances the status.
      expect(await observations.recordOrder({ ...order, status: 'FILLED' })).toMatchObject({
        kind: 'progressed',
        to: 'FILLED',
      });
    });
  },
);
