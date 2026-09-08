import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobLeaseRepository } from './leases.js';
import { OutboxRepository } from './outbox.js';
import { serializable } from './transaction.js';
import { DATABASE_URL, JournalHarness, POOL, WORKSPACE, sqlState } from './test-harness.js';

/**
 * The outbox and worker leases.
 *
 * A message is enqueued inside the transaction that makes the change it announces. A consumer
 * holds it under a lease, acknowledges or fails it, and a message that fails too often is
 * dead-lettered rather than retried forever. Worker leases carry a fencing token that
 * increases on every takeover.
 *
 * Expiry is decided by the database clock, so these tests wait for real short leases rather
 * than passing a `now` the code no longer accepts. A caller-supplied clock was itself the
 * hazard: a consumer whose watch ran fast could declare another's lease lapsed.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

/** Long enough that no test races it, short enough that expiry is quick to observe. */
const LEASE_MS = 300;
const AFTER_EXPIRY_MS = 450;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  const enqueue = (outboxId: string, kind: string, maxAttempts?: number) =>
    serializable(harness.pool, (client) =>
      OutboxRepository.enqueueOn(client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId,
        kind,
        payload: {},
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      }),
    );
  const claim = (consumerId: string, leaseMs = LEASE_MS) =>
    outbox.claim({ workspaceId: WORKSPACE, poolId: POOL, consumerId, leaseMs });

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
          payload: {},
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
        payload: {},
      });
    });
    expect((await harness.admin.query('SELECT 1 FROM outbox')).rowCount).toBe(1);
  });

  it('hands a message to one consumer at a time, and to another only after the lease lapses', async () => {
    await enqueue('ob-1', 'pool.halted');
    expect(await claim('worker-1')).toMatchObject({ outboxId: 'ob-1', attempt: 1 });
    expect(await claim('worker-2')).toBeNull();

    await sleep(AFTER_EXPIRY_MS);
    expect(await claim('worker-2', 5000)).toMatchObject({ outboxId: 'ob-1', attempt: 2 });

    // The first worker's acknowledgement is stale and refused.
    expect(
      await outbox.acknowledge({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        consumerId: 'worker-1',
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
      }),
    ).toEqual({ ok: true });
    expect(await claim('worker-3')).toBeNull();
  });

  it('dead-letters a message after its attempts are exhausted, and never deletes it', async () => {
    await enqueue('ob-1', 'pool.halted', 2);
    await claim('w');
    expect(
      await outbox.fail({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        consumerId: 'w',
        reason: 'boom',
      }),
    ).toEqual({ kind: 'retry-later' });
    await claim('w');
    expect(
      await outbox.fail({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-1',
        consumerId: 'w',
        reason: 'boom again',
      }),
    ).toEqual({ kind: 'dead-lettered' });
    expect(await claim('w')).toBeNull();

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
      await enqueue('ob-d', 'dispatch.send', 3);
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23514');

    // And a dispatch message that fails once is dead-lettered, never retried: a blind second
    // send is the one thing this table must make impossible.
    await enqueue('ob-d', 'dispatch.send', 1);
    await claim('exec');
    expect(
      await outbox.fail({
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-d',
        consumerId: 'exec',
        reason: 'socket reset',
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

  it('is held by one holder, taken over only after expiry, with a strictly increasing token', async () => {
    expect(await leases.acquire({ leaseKey: 'reconciler', holderId: 'w1', ttlMs: 5000 })).toEqual({
      ok: true,
      fencingToken: 1n,
    });
    expect(
      await leases.acquire({ leaseKey: 'reconciler', holderId: 'w2', ttlMs: 5000 }),
    ).toMatchObject({ ok: false, reason: 'HELD', holderId: 'w1' });

    // Renewal extends only for the holder presenting the current token.
    expect(
      await leases.renew({
        leaseKey: 'reconciler',
        holderId: 'w1',
        fencingToken: 1n,
        ttlMs: LEASE_MS,
      }),
    ).toEqual({ ok: true });
    expect(
      await leases.renew({
        leaseKey: 'reconciler',
        holderId: 'w2',
        fencingToken: 1n,
        ttlMs: LEASE_MS,
      }),
    ).toEqual({ ok: false, reason: 'NOT_HELD' });

    await sleep(AFTER_EXPIRY_MS);
    expect(await leases.acquire({ leaseKey: 'reconciler', holderId: 'w2', ttlMs: 5000 })).toEqual({
      ok: true,
      fencingToken: 2n,
    });
    // The old holder, resuming, presents a stale token and is refused.
    expect(
      await leases.renew({ leaseKey: 'reconciler', holderId: 'w1', fencingToken: 1n, ttlMs: 5000 }),
    ).toEqual({
      ok: false,
      reason: 'STALE_TOKEN',
      currentToken: 2n,
    });
  });

  it('releases by expiring the lease, keeping the token sequence', async () => {
    const held = await leases.acquire({ leaseKey: 'k', holderId: 'A', ttlMs: 5000 });
    expect(held).toMatchObject({ ok: true, fencingToken: 1n });
    expect(await leases.release({ leaseKey: 'k', holderId: 'A', fencingToken: 1n })).toBe(true);
    expect(await leases.acquire({ leaseKey: 'k', holderId: 'B', ttlMs: 5000 })).toEqual({
      ok: true,
      fencingToken: 2n,
    });
  });

  it('lets exactly one of two racing acquirers take over a lapsed lease', async () => {
    const [left, right, barrier] = await Promise.all([
      harness.connect(),
      harness.connect(),
      harness.connect(),
    ]);
    await barrier.client.query(
      `INSERT INTO job_leases (lease_key, holder_id, fencing_token, acquired_at, expires_at)
       VALUES ('k', 'stale', 1, now() - interval '20 seconds', now() - interval '10 seconds')`,
    );
    await barrier.client.query('BEGIN');
    await barrier.client.query(`SELECT 1 FROM job_leases WHERE lease_key = 'k' FOR UPDATE`);

    const both = Promise.all([
      JobLeaseRepository.acquireOn(left.client, { leaseKey: 'k', holderId: 'L', ttlMs: 5000 }),
      JobLeaseRepository.acquireOn(right.client, { leaseKey: 'k', holderId: 'R', ttlMs: 5000 }),
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
