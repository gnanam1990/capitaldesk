import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyRepository } from './idempotency.js';
import { serializable } from './transaction.js';
import { DATABASE_URL, JournalHarness, POOL, WORKSPACE, sqlState } from './test-harness.js';

/**
 * Idempotency (INV-11): same key, scope and body replays the same result; a changed body is a
 * durable conflict; an expired stored response never permits a second economic action.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describeIfDatabase('idempotency records', () => {
  const harness = new JournalHarness();
  let idempotency: IdempotencyRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    idempotency = new IdempotencyRepository(harness.pool);
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  const now = new Date('2026-09-08T12:00:00Z');
  const scope = { scopeKind: 'pool' as const, scopeId: `${WORKSPACE}/${POOL}`, key: 'key-1' };

  async function perform(digest: string, at = now) {
    const begun = await idempotency.begin({ ...scope, requestDigest: digest, now: at });
    if (begun.kind !== 'fresh') return begun;
    await serializable(harness.pool, async (client) => {
      await client.query(`UPDATE pools SET state = 'HALTED'`);
      await IdempotencyRepository.recordOn(client, {
        ...scope,
        requestDigest: digest,
        action: 'POOL_HALT',
        economicRef: 'halt-1',
        status: 200,
        body: { state: 'HALTED' },
        retentionMs: 60_000,
        now: at,
      });
    });
    return begun;
  }

  it('replays the stored response for the same body', async () => {
    expect(await perform('digest-a')).toEqual({ kind: 'fresh' });
    expect(await perform('digest-a', new Date(now.getTime() + 1000))).toEqual({
      kind: 'replay',
      status: 200,
      body: { state: 'HALTED' },
    });
  });

  it('conflicts on a changed body under the same key', async () => {
    await perform('digest-a');
    expect(await perform('digest-b')).toEqual({ kind: 'conflict', action: 'POOL_HALT' });
  });

  it('keeps the tombstone after the response expires, so the action cannot run again', async () => {
    await perform('digest-a');
    const discarded = await idempotency.discardExpiredResponses({
      now: new Date(now.getTime() + 61_000),
    });
    expect(discarded).toBe(1);
    const row = await harness.admin.query<{ response_body: unknown; economic_ref: string }>(
      'SELECT response_body, economic_ref FROM idempotency_results',
    );
    expect(row.rows[0]).toEqual({ response_body: null, economic_ref: 'halt-1' });

    // The same request again: not fresh. The body is gone, the decision is not.
    expect(await perform('digest-a', new Date(now.getTime() + 62_000))).toEqual({
      kind: 'replay-expired',
      action: 'POOL_HALT',
      economicRef: 'halt-1',
    });
    // And a changed body is still a conflict.
    expect(await perform('digest-b', new Date(now.getTime() + 62_000))).toEqual({
      kind: 'conflict',
      action: 'POOL_HALT',
    });
  });

  it('cannot be deleted or rewritten', async () => {
    await perform('digest-a');
    for (const statement of [
      'DELETE FROM idempotency_results',
      `UPDATE idempotency_results SET request_digest = 'digest-b'`,
      `UPDATE idempotency_results SET economic_ref = 'other'`,
      `UPDATE idempotency_results SET response_body = '{"state":"READY"}'::jsonb`,
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

  it('records the response in the same transaction as the action', async () => {
    const begun = await idempotency.begin({ ...scope, requestDigest: 'digest-a', now });
    expect(begun).toEqual({ kind: 'fresh' });
    await expect(
      serializable(harness.pool, async (client) => {
        await client.query(`UPDATE pools SET state = 'HALTED'`);
        await IdempotencyRepository.recordOn(client, {
          ...scope,
          requestDigest: 'digest-a',
          action: 'POOL_HALT',
          economicRef: 'halt-1',
          status: 200,
          body: {},
          retentionMs: 1000,
          now,
        });
        throw new Error('injected failure');
      }),
    ).rejects.toThrow('injected failure');
    // Neither the action nor its record survived, so the key is still fresh.
    expect((await harness.admin.query(`SELECT 1 FROM pools WHERE state = 'HALTED'`)).rowCount).toBe(
      0,
    );
    expect(await idempotency.begin({ ...scope, requestDigest: 'digest-a', now })).toEqual({
      kind: 'fresh',
    });
  });
});
