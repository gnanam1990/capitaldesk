import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxRepository } from './outbox.js';
import { JobLeaseRepository } from './leases.js';
import { serializable } from './transaction.js';
import { DATABASE_URL, JournalHarness, POOL, WORKSPACE, sqlState } from './test-harness.js';

/**
 * The outbox and worker leases.
 *
 * An outbox row is written in the same transaction as the change it announces. A consumer
 * holds a message under a lease, acknowledges or fails it, and a message that fails too often
 * is dead-lettered rather than retried forever. A dispatch message is single-attempt by
 * constraint. Worker leases carry a fencing token that increases on every takeover.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describeIfDatabase('outbox', () => {
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

  const now = new Date('2026-09-08T12:00:00Z');
  const later = (ms: number) => new Date(now.getTime() + ms);

  it('commits with its economic change, or not at all', async () => {
    await expect(
      serializable(harness.pool, async (client) => {
        await client.query(
          `UPDATE pools SET state = 'HALTED' WHERE workspace_id = $1 AND pool_id = $2`,
          [WORKSPACE, POOL],
        );
        await OutboxRepository.enqueueOn(client, {
          workspaceId: WORKSPACE,
          poolId: POOL,
          outboxId: 'ob-halt',
          kind: 'pool.halted',
          payload: { reason: 'operator' },
        });
        throw new Error('injected failure');
      }),
    ).rejects.toThrow('injected failure');
    expect((await harness.admin.query('SELECT 1 FROM outbox')).rowCount).toBe(0);
    expect((await harness.admin.query(`SELECT 1 FROM pools WHERE state = 'HALTED'`)).rowCount).toBe(
      0,
    );

    await serializable(harness.pool, async (client) => {
      await client.query(
        `UPDATE pools SET state = 'HALTED' WHERE workspace_id = $1 AND pool_id = $2`,
        [WORKSPACE, POOL],
      );
      await OutboxRepository.enqueueOn(client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-halt',
        kind: 'pool.halted',
        payload: { reason: 'operator' },
      });
    });
    expect((await harness.admin.query('SELECT 1 FROM outbox')).rowCount).toBe(1);
  });

  it('hands a message to one consumer at a time, and to another only after the lease lapses', async () => {
    await serializable(harness.pool, (client) =>
      OutboxRepository.enqueueOn(client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        kind: 'pool.halted',
        payload: {},
      }),
    );
    const first = await outbox.claim({
      workspaceId: WORKSPACE,
      poolId: POOL,
      consumerId: 'worker-1',
      leaseMs: 30_000,
      now,
    });
    expect(first).toMatchObject({ outboxId: 'ob-1', attempt: 1 });
    expect(
      await outbox.claim({
        workspaceId: WORKSPACE,
        poolId: POOL,
        consumerId: 'worker-2',
        leaseMs: 30_000,
        now: later(1000),
      }),
    ).toBeNull();
    // The lease lapsed without an acknowledgement: another worker may take it.
    const second = await outbox.claim({
      workspaceId: WORKSPACE,
      poolId: POOL,
      consumerId: 'worker-2',
      leaseMs: 30_000,
      now: later(31_000),
    });
    expect(second).toMatchObject({ outboxId: 'ob-1', attempt: 2 });
    // The first worker's acknowledgement is stale and refused.
    expect(
      await outbox.acknowledge({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        consumerId: 'worker-1',
        now: later(32_000),
      }),
    ).toEqual({
      ok: false,
      reason: 'NOT_HELD',
    });
    expect(
      await outbox.acknowledge({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        consumerId: 'worker-2',
        now: later(32_000),
      }),
    ).toEqual({
      ok: true,
    });
    expect(
      await outbox.claim({
        workspaceId: WORKSPACE,
        poolId: POOL,
        consumerId: 'worker-3',
        leaseMs: 30_000,
        now: later(40_000),
      }),
    ).toBeNull();
  });

  it('dead-letters a message after its attempts are exhausted, and never deletes it', async () => {
    await serializable(harness.pool, (client) =>
      OutboxRepository.enqueueOn(client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        kind: 'pool.halted',
        payload: {},
        maxAttempts: 2,
      }),
    );
    await outbox.claim({
      workspaceId: WORKSPACE,
      poolId: POOL,
      consumerId: 'w',
      leaseMs: 1000,
      now,
    });
    expect(
      await outbox.fail({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        consumerId: 'w',
        reason: 'boom',
        now,
      }),
    ).toEqual({ kind: 'retry-later' });
    await outbox.claim({
      workspaceId: WORKSPACE,
      poolId: POOL,
      consumerId: 'w',
      leaseMs: 1000,
      now: later(2000),
    });
    expect(
      await outbox.fail({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        consumerId: 'w',
        reason: 'boom again',
        now: later(2000),
      }),
    ).toEqual({
      kind: 'dead-lettered',
    });
    expect(
      await outbox.claim({
        workspaceId: WORKSPACE,
        poolId: POOL,
        consumerId: 'w',
        leaseMs: 1000,
        now: later(5000),
      }),
    ).toBeNull();
    let refusal = 'accepted';
    try {
      await harness.admin.query('DELETE FROM outbox');
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23001');
  });

  it('cannot enqueue a dispatch message with more than one attempt', async () => {
    let refusal = 'accepted';
    try {
      await serializable(harness.pool, (client) =>
        OutboxRepository.enqueueOn(client, {
          workspaceId: WORKSPACE,
          poolId: POOL,
          outboxId: 'ob-d',
          kind: 'dispatch.send',
          payload: {},
          maxAttempts: 3,
        }),
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23514');
    // And a dispatch message that fails once is dead-lettered, never retried: a blind second
    // send is the one thing this table must make impossible.
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
    await outbox.claim({
      workspaceId: WORKSPACE,
      poolId: POOL,
      consumerId: 'exec',
      leaseMs: 1000,
      now,
    });
    expect(
      await outbox.fail({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-d',
        consumerId: 'exec',
        reason: 'socket reset',
        now,
      }),
    ).toEqual({
      kind: 'dead-lettered',
    });
  });
});

describeIfDatabase('job leases', () => {
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

  const now = new Date('2026-09-08T12:00:00Z');
  const later = (ms: number) => new Date(now.getTime() + ms);

  it('is held by one holder, taken over only after expiry, with a strictly increasing token', async () => {
    const first = await leases.acquire({
      leaseKey: 'reconciler',
      holderId: 'w1',
      ttlMs: 10_000,
      now,
    });
    expect(first).toEqual({ ok: true, fencingToken: 1n });
    expect(
      await leases.acquire({
        leaseKey: 'reconciler',
        holderId: 'w2',
        ttlMs: 10_000,
        now: later(5000),
      }),
    ).toEqual({
      ok: false,
      reason: 'HELD',
      holderId: 'w1',
      expiresAt: later(10_000),
    });
    // Renewal extends only for the holder presenting the current token.
    expect(
      await leases.renew({
        leaseKey: 'reconciler',
        holderId: 'w1',
        fencingToken: 1n,
        ttlMs: 10_000,
        now: later(6000),
      }),
    ).toEqual({ ok: true });
    expect(
      await leases.renew({
        leaseKey: 'reconciler',
        holderId: 'w2',
        fencingToken: 1n,
        ttlMs: 10_000,
        now: later(6000),
      }),
    ).toEqual({
      ok: false,
      reason: 'NOT_HELD',
    });
    // Expired: taken over with a new token.
    const takeover = await leases.acquire({
      leaseKey: 'reconciler',
      holderId: 'w2',
      ttlMs: 10_000,
      now: later(17_000),
    });
    expect(takeover).toEqual({ ok: true, fencingToken: 2n });
    // The old holder, resuming, presents a stale token and is refused.
    expect(
      await leases.renew({
        leaseKey: 'reconciler',
        holderId: 'w1',
        fencingToken: 1n,
        ttlMs: 10_000,
        now: later(18_000),
      }),
    ).toEqual({
      ok: false,
      reason: 'STALE_TOKEN',
      currentToken: 2n,
    });
  });

  it('lets exactly one of two racing acquirers win', async () => {
    const [left, right, barrier] = await Promise.all([
      harness.connect(),
      harness.connect(),
      harness.connect(),
    ]);
    // Barrier: hold the lease row's key by pre-creating an expired lease and locking it.
    await barrier.client.query(
      `INSERT INTO job_leases (lease_key, holder_id, fencing_token, acquired_at, expires_at) VALUES ('k','stale',1,$1,$2)`,
      [later(-20_000), later(-10_000)],
    );
    await barrier.client.query('BEGIN');
    await barrier.client.query(`SELECT 1 FROM job_leases WHERE lease_key = 'k' FOR UPDATE`);

    const both = Promise.all([
      JobLeaseRepository.acquireOn(left.client, {
        leaseKey: 'k',
        holderId: 'L',
        ttlMs: 10_000,
        now,
      }),
      JobLeaseRepository.acquireOn(right.client, {
        leaseKey: 'k',
        holderId: 'R',
        ttlMs: 10_000,
        now,
      }),
    ]);
    both.catch(() => undefined);
    try {
      await harness.waitUntilBlockedBy(barrier.pid, [left.pid, right.pid]);
    } finally {
      await barrier.client.query('ROLLBACK').catch(() => undefined);
    }
    const [a, b] = await both;
    expect([a, b].filter((outcome) => outcome.ok)).toHaveLength(1);
    expect([a, b].filter((outcome) => !outcome.ok)).toHaveLength(1);
    const row = await harness.admin.query<{ fencing_token: string }>(
      `SELECT fencing_token FROM job_leases WHERE lease_key='k'`,
    );
    expect(row.rows[0]?.fencing_token).toBe('2');
  });
});
