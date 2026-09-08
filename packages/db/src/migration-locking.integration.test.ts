import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, loadMigrations, migrate } from './migrator.js';

/**
 * The migrator's locking contract, against real PostgreSQL.
 *
 * `migrate` takes one global advisory lock so two deployers cannot interleave, and waiting
 * behind another migration is the correct outcome rather than a fault. But `lock_timeout`
 * applies to that wait like any other lock wait, so any caller that had set one — every
 * integration harness here does, to fail fast on unexpected contention — had its migration
 * cancelled for queueing properly, and reported a failure for a migration another process was
 * applying successfully.
 *
 * That was the intermittent full-run failure. The wait now runs with the timeout suspended and
 * the caller's value restored, and these pin both halves.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ASSERTION_TIMEOUT = '5s';

describeIfDatabase('migration locking', () => {
  let client: Client;
  let blocker: Client;
  let schema: string;

  beforeEach(async () => {
    schema = `cd_lock_${Date.now()}`;
    client = new Client({ connectionString: DATABASE_URL });
    blocker = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await blocker.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The short bound a test connection wants for its own statements, so an unexpected lock
    // fails quickly and names the contention instead of hanging the run.
    await client.query(`SET lock_timeout = '${ASSERTION_TIMEOUT}'`);
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
    await blocker.end();
  });

  async function run(): Promise<void> {
    await migrate(client, await loadMigrations(MIGRATIONS_DIR), {
      appliedBy: 'vitest',
      buildId: 'locking-test',
    });
  }

  it('queues behind another migrator instead of failing at the caller’s lock timeout', async () => {
    // The regression itself, contended on the very key the migrator uses rather than a
    // lookalike, and held well past the five seconds that used to be fatal.
    await blocker.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const queued = run();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await blocker.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);

    await expect(queued).resolves.toBeUndefined();
  }, 30_000);

  it('restores the caller’s lock timeout, and does not leave it suspended', async () => {
    await run();
    const setting = await client.query<{ lock_timeout: string }>('SHOW lock_timeout');
    // Not left at 0: a later statement that blocks unexpectedly must still fail fast, and a
    // migration must not silently relax the connection it was handed.
    expect(setting.rows[0]?.lock_timeout).toBe(ASSERTION_TIMEOUT);
  });

  it('restores the caller’s lock timeout even when the migration fails', async () => {
    const broken = [{ version: '9999_broken', checksum: 'x'.repeat(64), sql: 'SELECT 1/0' }];
    await expect(
      migrate(client, broken, { appliedBy: 'vitest', buildId: 'locking-test' }),
    ).rejects.toThrow();
    const setting = await client.query<{ lock_timeout: string }>('SHOW lock_timeout');
    expect(setting.rows[0]?.lock_timeout).toBe(ASSERTION_TIMEOUT);
    // And this session released the lock, so a failure cannot strand every later deployer.
    // Asserted against this connection's own holdings rather than by trying to take the lock:
    // the key is global, so a parallel suite legitimately migrating would make that racy and
    // this test would then be reporting on the scheduler rather than on the migrator.
    const held = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()
          AND ((classid::bigint << 32) | objid::bigint) = $1`,
      [MIGRATION_LOCK_KEY],
    );
    expect(held.rows[0]?.count).toBe('0');
  });
});
