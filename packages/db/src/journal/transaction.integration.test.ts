import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SerializationRetriesExhausted, lockOrder, serializable } from './transaction.js';
import { DATABASE_URL, JournalHarness, POOL, WORKSPACE } from './test-harness.js';

/**
 * SERIALIZABLE helpers: bounded retries, only before an external effect, in a stable order.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describe('lock ordering', () => {
  it('orders pool keys deterministically whatever order they arrive in', () => {
    const a = { workspaceId: 'ws-b', poolId: 'p-1' };
    const b = { workspaceId: 'ws-a', poolId: 'p-9' };
    const c = { workspaceId: 'ws-a', poolId: 'p-2' };
    expect(lockOrder([a, b, c])).toEqual([c, b, a]);
    expect(lockOrder([c, a, b])).toEqual([c, b, a]);
  });
});

describeIfDatabase('serializable transactions', () => {
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

  it('runs at SERIALIZABLE and retries a serialization failure a bounded number of times', async () => {
    let attempts = 0;
    const result = await serializable(
      harness.pool,
      async (client) => {
        attempts += 1;
        const level = await client.query<{ transaction_isolation: string }>(
          'SHOW transaction_isolation',
        );
        expect(level.rows[0]?.transaction_isolation).toBe('serializable');
        if (attempts < 3) {
          // The exact error PostgreSQL raises on a serialization failure.
          const error = new Error('could not serialize access') as Error & { code: string };
          error.code = '40001';
          throw error;
        }
        return 'done';
      },
      { maxAttempts: 5 },
    );
    expect(result).toBe('done');
    expect(attempts).toBe(3);

    await expect(
      serializable(
        harness.pool,
        () => {
          const error = new Error('could not serialize access') as Error & { code: string };
          error.code = '40001';
          return Promise.reject(error);
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toBeInstanceOf(SerializationRetriesExhausted);
  });

  it('never retries once an external effect has started', async () => {
    let attempts = 0;
    await expect(
      serializable(
        harness.pool,
        (_client, effects) => {
          attempts += 1;
          // The send happened. A retry would send again.
          effects.externalEffectStarted();
          const error = new Error('could not serialize access') as Error & { code: string };
          error.code = '40001';
          return Promise.reject(error);
        },
        { maxAttempts: 5 },
      ),
    ).rejects.toMatchObject({ code: '40001' });
    expect(attempts).toBe(1);
  });

  it('does not retry an ordinary error', async () => {
    let attempts = 0;
    await expect(
      serializable(harness.pool, () => {
        attempts += 1;
        return Promise.reject(new Error('a bug'));
      }),
    ).rejects.toThrow('a bug');
    expect(attempts).toBe(1);
  });

  it('actually detects a write skew between two independent connections', async () => {
    // Two transactions each read the pool's revision and write based on it. Under
    // SERIALIZABLE one of them must fail with 40001; under READ COMMITTED both would commit
    // and one update would be lost.
    const [left, right] = await Promise.all([harness.connect(), harness.connect()]);
    for (const backend of [left, right]) {
      await backend.client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await backend.client.query(
        `SELECT ledger_revision FROM pools WHERE workspace_id=$1 AND pool_id=$2`,
        [WORKSPACE, POOL],
      );
    }
    await left.client.query(
      `UPDATE pools SET ledger_revision = ledger_revision + 1 WHERE workspace_id=$1 AND pool_id=$2`,
      [WORKSPACE, POOL],
    );
    const outcomes: string[] = [];
    await left.client.query('COMMIT').then(() => outcomes.push('left-committed'));
    try {
      await right.client.query(
        `UPDATE pools SET ledger_revision = ledger_revision + 1 WHERE workspace_id=$1 AND pool_id=$2`,
        [WORKSPACE, POOL],
      );
      await right.client.query('COMMIT');
      outcomes.push('right-committed');
    } catch (error) {
      outcomes.push(`right-${(error as { code?: string }).code ?? 'error'}`);
      await right.client.query('ROLLBACK').catch(() => undefined);
    }
    expect(outcomes).toEqual(['left-committed', 'right-40001']);
  });
});
