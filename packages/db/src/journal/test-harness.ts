import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { loadMigrations, migrate } from '../migrator.js';

/**
 * Shared harness for the journal's real-PostgreSQL tests.
 *
 * Every test file gets its own schema, migrated from the shipped files, seeded with one
 * workspace, one venue account, one pool and epoch 1. Independent connections are real
 * `Client`s, not pool checkouts, so a concurrency test's "two connections" are two backends.
 *
 * Cleanup holds itself to the same standard as the tests: backends are cancelled before they
 * are closed, closes run concurrently under a deadline, and the schema drop is bounded, so a
 * failing test reports its failure instead of stranding a lock and hanging the suite.
 */
export const DATABASE_URL = process.env['CAPITALDESK_TEST_DATABASE_URL'];

export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

export const WORKSPACE = 'ws-journal';
export const OTHER_WORKSPACE = 'ws-journal-other';
export const POOL = 'pool-1';
export const ACCOUNT = {
  venue: 'binance-spot',
  environment: 'local',
  stableAccountId: 'acct-1',
} as const;
export const BTC = { code: 'BTC', scale: 'v1' } as const;
export const USDT = { code: 'USDT', scale: 'v1' } as const;

/**
 * How long an assertion may wait for a lock before failing.
 *
 * Short on purpose: a test that blocks on a lock it did not expect should fail quickly and
 * name the contention, not sit until the suite times out.
 */
const ASSERTION_LOCK_TIMEOUT = '5s';

/**
 * How long the schema migration may wait for the migrator's global advisory lock.
 *
 * Generous, because every suite migrates its own schema and they queue behind one lock; and
 * still bounded, because a genuinely stuck migration must fail rather than hang the run.
 */

export interface Backend {
  readonly client: Client;
  readonly pid: number;
}

export class JournalHarness {
  readonly schema = `journal_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  /** A pool for the repositories under test, bound to the schema. */
  pool!: Pool;
  /** The controlling connection: never blocked deliberately, so it can observe and cancel. */
  admin!: Client;
  private extras: Backend[] = [];
  private pinned: { pool: Pool; pid: number }[] = [];

  async open(): Promise<void> {
    this.admin = new Client({ connectionString: DATABASE_URL });
    await this.admin.connect();
    await this.admin.query(`SET lock_timeout = '${ASSERTION_LOCK_TIMEOUT}'`);
    await this.admin.query(`SET statement_timeout = '20s'`);
    this.pool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${this.schema}`,
      max: 8,
    });
  }

  /** Fresh schema, migrated and seeded. Call from beforeEach. */
  async reset(): Promise<void> {
    await this.admin.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    await this.admin.query(`CREATE SCHEMA ${this.schema}`);
    await this.admin.query(`SET search_path TO ${this.schema}`);
    // No special handling for the migrator's advisory lock is needed here: `migrate` suspends
    // and restores `lock_timeout` around its own wait, so this connection's short assertion
    // timeout survives and does not turn a queue of parallel suites into a spurious failure.
    await migrate(this.admin, await loadMigrations(MIGRATIONS_DIR), {
      appliedBy: 'vitest',
      buildId: 'journal-test',
    });
    await this.admin.query(
      `INSERT INTO workspaces (workspace_id, display_name) VALUES ($1,'Journal'), ($2,'Other')`,
      [WORKSPACE, OTHER_WORKSPACE],
    );
  }

  /** Seed a governed pool at epoch 1 directly, for tests that are not about governance. */
  async seedPool(workspaceId = WORKSPACE, poolId = POOL): Promise<void> {
    await this.admin.query(
      `INSERT INTO venue_accounts (venue, environment, stable_account_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId],
    );
    await this.admin.query(
      `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id, state)
       VALUES ($1,$2,$3,$4,$5,'READY')`,
      [workspaceId, poolId, ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId],
    );
    await this.admin.query(
      `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1,$2,1)`,
      [workspaceId, poolId],
    );
    await this.admin.query(
      `INSERT INTO strategies (workspace_id, pool_id, strategy_id, display_name)
       VALUES ($1,$2,'strategy-a','A'), ($1,$2,'strategy-b','B')`,
      [workspaceId, poolId],
    );
    // A READY pool with no governance lease can create no authority at all: sealing,
    // reserving, preparing and marking all require one. Seeding an ungoverned pool by
    // default would make most fixtures test the refusal path by accident, so the default
    // pool is governed and a test that wants the ungoverned case releases the lease itself.
    await this.seedGovernanceLease(workspaceId, poolId);
  }

  /** Install a deterministic owner-policy fixture for tests whose subject is downstream. */
  async seedPolicyVersion(workspaceId = WORKSPACE, poolId = POOL): Promise<void> {
    await this.admin.query(
      `INSERT INTO policy_versions
        (workspace_id,pool_id,policy_version,payload,payload_digest,selected_symbol,
         base_asset_code,base_asset_scale,quote_asset_code,quote_asset_scale,
         max_pool_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms,
         concentration_numerator,concentration_denominator,price_snapshot_max_age_ms,
         account_snapshot_max_age_ms,symbol_metadata_max_age_ms,venue_clock_max_age_ms,
         plan_lifetime_ms,risk_increase_halted,fee_policy_version,published_by_subject_id,
         idempotency_key)
       VALUES ($1,$2,1,'{}','sha256:${'0'.repeat(64)}','BTCUSDT','BTC','v1','USDT','v1',
               5000000,10000000,1,1,5000,5000,5000,5000,60000,false,'FIXTURE-V1',
               'fixture-owner','fixture-policy')`,
      [workspaceId, poolId],
    );
    await this.admin.query(
      `INSERT INTO strategy_policy_limits
        (workspace_id,pool_id,policy_version,strategy_id,max_target_base_atoms,
         max_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms)
       SELECT $1,$2,1,strategy_id,1000000,5000000,10000000 FROM strategies
        WHERE workspace_id=$1 AND pool_id=$2`,
      [workspaceId, poolId],
    );
    await this.admin.query(
      `UPDATE pools SET selected_symbol='BTCUSDT',base_asset_code='BTC',base_asset_scale='v1',
                        quote_asset_code='USDT',quote_asset_scale='v1',
                        max_target_base_atoms=1000000,active_policy_version=1
        WHERE workspace_id=$1 AND pool_id=$2`,
      [workspaceId, poolId],
    );
  }

  /** The active governance lease a dispatch marker requires. */
  async seedGovernanceLease(workspaceId = WORKSPACE, poolId = POOL): Promise<void> {
    await this.admin.query(
      `INSERT INTO governance_leases (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (lease_id) DO NOTHING`,
      [
        `lease-${poolId}`,
        ACCOUNT.venue,
        ACCOUNT.environment,
        ACCOUNT.stableAccountId,
        workspaceId,
        poolId,
      ],
    );
  }

  /** An independent backend bound to the schema. Cancelled and closed by cleanup(). */
  async connect(): Promise<Backend> {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`SET search_path TO ${this.schema}`);
    const pid = await backendPid(client);
    const backend = { client, pid };
    this.extras.push(backend);
    return backend;
  }

  /**
   * A `Pool` pinned to exactly one backend, with that backend's pid.
   *
   * A repository built on it runs every statement on one known connection, which is what a
   * lock-contention test needs: `harness.pool` hands out any of eight backends, so the pid a
   * test observed would not be the pid the next statement used. Closed by `cleanup()`.
   */
  async pinnedRepositoryPool(): Promise<{ pool: Pool; pid: number }> {
    const pool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${this.schema}`,
      max: 1,
      // The single backend must persist across statements, or the pid moves under the test.
      idleTimeoutMillis: 0,
    });
    const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (pid === undefined) throw new Error('could not read the pinned backend pid');
    this.pinned.push({ pool, pid });
    return { pool, pid };
  }

  /**
   * Call from afterEach. Cancels first, closes concurrently, bounded - and then proves it.
   *
   * A bounded `client.end()` does not stop a checked-out backend that is still blocked, and
   * the later schema drop was swallowed by `.catch()`, so a stuck backend and its schema could
   * survive while the suite reported success. Anything still alive is terminated by pid, and
   * residue is thrown rather than suppressed.
   */
  async cleanup(): Promise<void> {
    const pending = this.extras;
    this.extras = [];
    const pinned = this.pinned;
    this.pinned = [];
    const cancellable = [...pending.map((b) => b.pid), ...pinned.map((p) => p.pid)];
    if (cancellable.length > 0) {
      await this.admin
        .query('SELECT pg_cancel_backend(pid) FROM unnest($1::int[]) AS pid', [cancellable])
        .catch(() => undefined);
    }
    await Promise.allSettled(
      pending.map((backend) => withDeadline(backend.client.end(), 5000, `closing ${backend.pid}`)),
    );
    await Promise.allSettled(
      pinned.map((entry) =>
        withDeadline(entry.pool.end(), 5000, `closing pinned pool ${String(entry.pid)}`),
      ),
    );
    await this.admin.query('ROLLBACK').catch(() => undefined);

    if (cancellable.length > 0) {
      // Terminate, not cancel: a backend that survived `end()` is holding something, and the
      // schema drop would block on it.
      const pids = cancellable;
      await this.admin
        .query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids])
        .catch(() => undefined);
      const alive = await this.admin.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[])',
        [pids],
      );
      if (alive.rowCount !== null && alive.rowCount > 0) {
        throw new Error(
          `cleanup left ${String(alive.rowCount)} backend(s) alive: ${alive.rows.map((r) => r.pid).join(', ')}`,
        );
      }
    }
  }

  /**
   * Call from afterAll. The schema drop is bounded and its failure is reported, not
   * suppressed: a drop that times out means a live backend still holds the schema, which is
   * exactly the residue these tests promise not to leave.
   */
  async close(): Promise<void> {
    await this.cleanup();
    await withDeadline(this.pool.end(), 5000, 'closing the pool').catch(() => undefined);
    let dropFailure: Error | undefined;
    try {
      await this.admin.query(`SET lock_timeout = '${ASSERTION_LOCK_TIMEOUT}'`);
      await this.admin.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    } catch (error) {
      dropFailure = error instanceof Error ? error : new Error(String(error));
    }
    const residue = await this.admin
      .query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_namespace WHERE nspname = $1`,
        [this.schema],
      )
      .catch(() => null);
    await this.admin.end().catch(() => undefined);
    if (dropFailure !== undefined) {
      throw new Error(`could not drop ${this.schema}: ${dropFailure.message}`);
    }
    if (residue !== null && residue.rows[0]?.count !== '0') {
      throw new Error(`schema ${this.schema} survived cleanup`);
    }
  }

  /**
   * Wait until every waiter is blocked inside the blocker's dependency chain.
   *
   * The first waiter queues on the holder's `transactionid`, the second on a `tuple` lock
   * whose reported blocker is the first waiter, so the condition true of both is: blocked,
   * and blocked only by the barrier or by each other.
   */
  async waitUntilBlockedBy(blockerPid: number, waiterPids: readonly number[]): Promise<void> {
    const deadline = Date.now() + 10_000;
    const chain = [blockerPid, ...waiterPids];
    for (;;) {
      const blocked = await this.admin.query(
        `SELECT pid FROM unnest($1::int[]) AS pid
          WHERE cardinality(pg_blocking_pids(pid)) > 0 AND pg_blocking_pids(pid) <@ $2::int[]`,
        [waiterPids, chain],
      );
      if (blocked.rowCount === waiterPids.length) return;
      if (Date.now() > deadline) {
        throw new Error(
          `only ${blocked.rowCount ?? 0} of ${waiterPids.length} backends were blocked by the barrier`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('could not read the backend pid');
  return pid;
}

export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
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

/** The SQLSTATE of a thrown pg error, or a marker when it is not one. */
export function sqlState(error: unknown): string {
  return (error as { code?: string })?.code ?? 'no-sqlstate';
}

/**
 * The SQLSTATE and the constraint that produced it.
 *
 * A test that asserts only "something refused this" passes for the wrong reason. One INSERT
 * regression here was satisfied by `dispatch_attempts_marked_has_evidence` rejecting a row
 * that simply had no marker fields, so it never exercised the guard it was named after, and a
 * fully populated row went straight in. Naming the constraint makes that impossible.
 */
export function sqlRefusal(error: unknown): { state: string; constraint: string } {
  const failure = error as { code?: string; constraint?: string } | null;
  return {
    state: failure?.code ?? 'no-sqlstate',
    constraint: failure?.constraint ?? 'no-constraint',
  };
}
