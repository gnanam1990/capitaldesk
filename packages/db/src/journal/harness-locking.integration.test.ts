import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY } from '../migrator.js';
import { DATABASE_URL, JournalHarness } from './test-harness.js';

/**
 * The harness's own locking contract.
 *
 * Every suite migrates its own schema, and the migrator takes one global advisory lock so
 * concurrent runs cannot interleave. `lock_timeout` applies to that wait like any other lock
 * wait, so a short assertion timeout made a queue of parallel suites report a scheduling
 * artefact as a test failure. That is what produced the intermittent full-run failures.
 *
 * The two waits are now separate concerns with separate bounds, and this pins that they are.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describeIfDatabase('harness locking', () => {
  const harness = new JournalHarness();

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('leaves the short assertion lock timeout in force after migrating', async () => {
    await harness.reset();
    const setting = await harness.admin.query<{ lock_timeout: string }>('SHOW lock_timeout');
    // Restored, not left at the generous migration bound: a test that blocks on a lock it did
    // not expect must fail quickly and name the contention.
    expect(setting.rows[0]?.lock_timeout).toBe('5s');
  });

  it('still migrates when another session already holds the migration advisory lock', async () => {
    // The regression itself. A second migrator waiting behind the first must queue and
    // succeed, not fail after five seconds.
    const blocker = await harness.connect();
    // The very key the migrator uses, so this contends on the same lock rather than a
    // lookalike.
    await blocker.client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const held = harness.reset();
    // Hold it well past the five seconds that used to be fatal.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await blocker.client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);

    await expect(held).resolves.toBeUndefined();
    const setting = await harness.admin.query<{ lock_timeout: string }>('SHOW lock_timeout');
    expect(setting.rows[0]?.lock_timeout).toBe('5s');
    await harness.cleanup();
  }, 30_000);
});
