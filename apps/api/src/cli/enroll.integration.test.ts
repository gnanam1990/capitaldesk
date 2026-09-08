import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '@capitaldesk/db';
import { CODE_LIFETIME_MS, issueEnrollment, redeemEnrollment } from './enroll.js';

/**
 * One-time enrollment, proven against real PostgreSQL on independent connections.
 *
 * The behaviour under test is a decision, not a lucky constraint violation: a single-use code
 * must be redeemable exactly once even when two callers present it at the same instant, and a
 * lapsed code must never wedge the slot so that reissue needs someone to delete a record.
 *
 * The harness holds itself to the same standard. A proof that can strand a lock is not a
 * proof — it is a test suite that hangs and then reports nothing. Every path that blocks a
 * backend releases it in a `finally`, cleanup cancels before it closes, and every wait is
 * bounded.
 */
const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const WORKSPACE = 'ws-enroll';
const LOGIN = 'desk.owner';
const PASSWORD = 'correct-horse-battery-staple-7';
const BARRIER_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;

interface Backend {
  readonly client: Client;
  readonly pid: number;
}

async function openBackend(): Promise<Backend> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const pid = await backendPid(client);
  return { client, pid };
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('could not read the backend pid');
  return pid;
}

/** Bound any wait that could otherwise outlive the test that started it. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describeIfDatabase('one-time owner enrollment', () => {
  const schema = `enroll_${Date.now()}`;
  /** The controlling connection. Never blocked deliberately, so it can always observe and cancel. */
  let primary: Client;
  /** Connections a single test opened. Independent backends, not clients queued behind one pool. */
  let extras: Backend[] = [];

  async function connect(): Promise<Backend> {
    const backend = await openBackend();
    extras.push(backend);
    await backend.client.query(`SET search_path TO ${schema}`);
    return backend;
  }

  beforeAll(async () => {
    primary = (await openBackend()).client;
  });

  afterAll(async () => {
    await primary?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await primary?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    // A blocked DROP SCHEMA is the failure mode that turns one broken test into a hung suite.
    // Bounding it here means a leaked lock is reported as a fast, named failure instead.
    await primary.query(`SET lock_timeout = '5s'`);
    await primary.query(`SET statement_timeout = '20s'`);
    await primary.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await primary.query(`CREATE SCHEMA ${schema}`);
    // Before migrate, not after: the migrations create their relations wherever search_path
    // points, and a first run that left it at `public` would build the schema in the wrong
    // place and only fail on the next statement.
    await primary.query(`SET search_path TO ${schema}`);
    await migrate(primary, await loadMigrations(MIGRATIONS_DIR), {
      appliedBy: 'vitest',
      buildId: 'enroll-test',
    });
    await primary.query(`INSERT INTO workspaces (workspace_id, display_name) VALUES ($1, 'Desk')`, [
      WORKSPACE,
    ]);
  });

  afterEach(async () => {
    const pending = extras;
    extras = [];

    // Cancel first, close second. A backend waiting on a row lock will not accept a ROLLBACK:
    // the new statement queues behind the wait, so cleanup that politely asks first is exactly
    // the cleanup that can never run. Cancelling is a no-op on an idle backend.
    if (pending.length > 0) {
      await primary
        .query('SELECT pg_cancel_backend(pid) FROM unnest($1::int[]) AS pid', [
          pending.map((backend) => backend.pid),
        ])
        .catch(() => undefined);
    }

    // Concurrent and bounded: one stuck connection must not delay or prevent closing the rest.
    await Promise.allSettled(
      pending.map((backend) =>
        withDeadline(backend.client.end(), CLEANUP_TIMEOUT_MS, `closing backend ${backend.pid}`),
      ),
    );
    await primary.query('ROLLBACK').catch(() => undefined);
  });

  async function issue(now?: Date, rotate?: boolean) {
    return issueEnrollment(primary, {
      workspaceId: WORKSPACE,
      loginName: LOGIN,
      ...(now === undefined ? {} : { now }),
      ...(rotate === undefined ? {} : { rotate }),
    });
  }

  it('issues a code whose plaintext is never stored', async () => {
    const issued = await issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const stored = await primary.query<{ code_hash: string }>(
      'SELECT code_hash FROM owner_enrollments',
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.code_hash.startsWith('$argon2id$')).toBe(true);
    expect(stored.rows[0]?.code_hash).not.toContain(issued.code);
  });

  it('reissues after expiry without deleting the lapsed record', async () => {
    const first = await issue(new Date(Date.now() - CODE_LIFETIME_MS - 60_000));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await issue();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.superseded).toEqual({ enrollmentId: first.enrollmentId, reason: 'expired' });

    // Both rows survive. The lapsed one carries the reason it stopped being usable.
    const rows = await primary.query<{
      enrollment_id: string;
      invalidated_reason: string | null;
      consumed_at: Date | null;
    }>(
      'SELECT enrollment_id, invalidated_reason, consumed_at FROM owner_enrollments ORDER BY created_at',
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      enrollment_id: first.enrollmentId,
      invalidated_reason: 'expired',
      consumed_at: null,
    });
    expect(rows.rows[1]).toMatchObject({
      enrollment_id: second.enrollmentId,
      invalidated_reason: null,
    });
  });

  it('refuses to silently replace a live code, and rotates only when asked', async () => {
    const first = await issue();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // An accidental second `issue` must not revoke a code the operator may already have
    // handed over.
    const accidental = await issue();
    expect(accidental).toEqual({ ok: false, reason: 'LIVE_ENROLLMENT_OUTSTANDING' });

    const rotated = await issue(undefined, true);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.superseded).toEqual({ enrollmentId: first.enrollmentId, reason: 'rotated' });

    // The withdrawn code no longer redeems, and the record of it remains.
    const replay = await redeemEnrollment(primary, {
      workspaceId: WORKSPACE,
      code: first.code,
      password: PASSWORD,
    });
    expect(replay).toEqual({ ok: false, reason: 'WRONG_CODE' });
    const preserved = await primary.query(
      `SELECT 1 FROM owner_enrollments WHERE enrollment_id = $1 AND invalidated_reason = 'rotated'`,
      [first.enrollmentId],
    );
    expect(preserved.rowCount).toBe(1);
  });

  it('records expiry on redemption and refuses the lapsed code', async () => {
    const issued = await issue(new Date(Date.now() - CODE_LIFETIME_MS - 60_000));
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const outcome = await redeemEnrollment(primary, {
      workspaceId: WORKSPACE,
      code: issued.code,
      password: PASSWORD,
    });
    expect(outcome).toEqual({ ok: false, reason: 'EXPIRED' });

    const row = await primary.query<{ invalidated_reason: string | null }>(
      'SELECT invalidated_reason FROM owner_enrollments',
    );
    expect(row.rows[0]?.invalidated_reason).toBe('expired');
  });

  it('refuses a second use of the same code independently of the owner-membership index', async () => {
    const issued = await issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const first = await redeemEnrollment(primary, {
      workspaceId: WORKSPACE,
      code: issued.code,
      password: PASSWORD,
    });
    expect(first.ok).toBe(true);

    // Remove the membership so the single-owner index cannot be what refuses the replay.
    // What must refuse it is the consumed enrollment row itself.
    await primary.query(`DELETE FROM memberships WHERE workspace_id = $1`, [WORKSPACE]);

    const replay = await redeemEnrollment(primary, {
      workspaceId: WORKSPACE,
      code: issued.code,
      password: PASSWORD,
    });
    expect(replay).toEqual({ ok: false, reason: 'ALREADY_CONSUMED' });
  });

  it('lets exactly one of two concurrent redeemers create the owner', async () => {
    const issued = await issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const [left, right, barrier] = await Promise.all([connect(), connect(), connect()]);

    // Barrier: hold the workspace row both redeemers must lock first, so they are provably in
    // flight together rather than merely started together.
    await barrier.client.query('BEGIN');
    await barrier.client.query(
      'SELECT workspace_id FROM workspaces WHERE workspace_id = $1 FOR UPDATE',
      [WORKSPACE],
    );

    const redeem = (backend: Backend) =>
      redeemEnrollment(backend.client, {
        workspaceId: WORKSPACE,
        code: issued.code,
        password: PASSWORD,
      });
    const both = Promise.all([redeem(left), redeem(right)]);
    // Keep a handler attached, so a failed wait below cannot surface as an unhandled rejection
    // after this test has already reported.
    both.catch(() => undefined);

    try {
      await waitUntilBlockedBy(primary, barrier.pid, [left.pid, right.pid]);
    } finally {
      // Always release. ROLLBACK, not COMMIT: the barrier only took a lock, and a release path
      // that can itself fail is not a release path.
      await barrier.client.query('ROLLBACK').catch(() => undefined);
    }

    const [a, b] = await withDeadline(both, BARRIER_TIMEOUT_MS, 'concurrent redemption');
    const succeeded = [a, b].filter((outcome) => outcome.ok);
    const refused = [a, b].filter((outcome) => !outcome.ok);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // A decision, not a lost race against a unique index.
    expect(refused[0]).toEqual({ ok: false, reason: 'OWNER_ALREADY_ENROLLED' });

    const users = await primary.query('SELECT user_id FROM users');
    const owners = await primary.query(`SELECT user_id FROM memberships WHERE role = 'owner'`);
    const allowed = await primary.query(
      `SELECT audit_id FROM audit_events WHERE action = 'owner.enrollment.redeem' AND outcome = 'allowed'`,
    );
    expect(users.rowCount).toBe(1);
    expect(owners.rowCount).toBe(1);
    expect(allowed.rowCount).toBe(1);
  });

  it('refuses a weak password and an invalid login before writing or hashing anything', async () => {
    expect(await issueEnrollment(primary, { workspaceId: WORKSPACE, loginName: 'AB' })).toEqual({
      ok: false,
      reason: 'INVALID_LOGIN_NAME',
    });
    expect(await primary.query('SELECT 1 FROM owner_enrollments')).toMatchObject({ rowCount: 0 });

    const issued = await issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    for (const password of ['', '   ', 'short', 'aaaaaaaaaaaaaaaa']) {
      expect(
        await redeemEnrollment(primary, { workspaceId: WORKSPACE, code: issued.code, password }),
      ).toEqual({ ok: false, reason: 'WEAK_PASSWORD' });
    }
    expect(await primary.query('SELECT 1 FROM users')).toMatchObject({ rowCount: 0 });
  });

  it('keeps the code out of every audit record and every returned refusal', async () => {
    const issued = await issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    await redeemEnrollment(primary, {
      workspaceId: WORKSPACE,
      code: 'wrong-code-entirely',
      password: PASSWORD,
    });
    const success = await redeemEnrollment(primary, {
      workspaceId: WORKSPACE,
      code: issued.code,
      password: PASSWORD,
    });
    expect(success.ok).toBe(true);

    const audits = await primary.query<{ detail: unknown; outcome: string }>(
      'SELECT detail, outcome FROM audit_events ORDER BY audit_id',
    );
    expect(audits.rowCount).toBe(3);
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain(issued.code);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('$argon2id$');
    expect(JSON.stringify(success)).not.toContain(PASSWORD);
    expect(audits.rows.map((row) => row.outcome)).toEqual(['allowed', 'denied', 'allowed']);
  });
});

/**
 * Wait until every waiter is blocked inside the barrier's dependency chain.
 *
 * `pg_blocking_pids` names the blocker, which is the claim the test actually needs: not merely
 * that a backend is waiting on something, but that both redeemers are waiting on the row the
 * barrier holds. It does not name the barrier for both of them, though. Only the first waiter
 * queues on the barrier's `transactionid`; the second queues behind that waiter on a `tuple`
 * lock, so its reported blocker is the other redeemer. The condition that is true of both is
 * therefore: blocked, and blocked only by the barrier or by each other — a chain whose single
 * root is the barrier.
 *
 * Counting rows in `pg_locks` for the table cannot establish this at all: the `transactionid`
 * object carries no relation, so a relation-filtered count sees one waiter and never two.
 */
async function waitUntilBlockedBy(
  client: Client,
  blockerPid: number,
  waiterPids: readonly number[],
): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  const chain = [blockerPid, ...waiterPids];
  for (;;) {
    const blocked = await client.query<{ pid: number; blockers: number[] }>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers
         FROM unnest($1::int[]) AS pid
        WHERE cardinality(pg_blocking_pids(pid)) > 0
          AND pg_blocking_pids(pid) <@ $2::int[]`,
      [waiterPids, chain],
    );
    if (blocked.rowCount === waiterPids.length) return;
    if (Date.now() > deadline) {
      throw new Error(
        `only ${blocked.rowCount ?? 0} of ${waiterPids.length} redeemers were blocked within the ` +
          `barrier's chain; observed ${JSON.stringify(blocked.rows)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
