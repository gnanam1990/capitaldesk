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

  async open(): Promise<void> {
    this.admin = new Client({ connectionString: DATABASE_URL });
    await this.admin.connect();
    await this.admin.query(`SET lock_timeout = '5s'`);
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
  }

  /** The active governance lease a dispatch marker requires. */
  async seedGovernanceLease(workspaceId = WORKSPACE, poolId = POOL): Promise<void> {
    await this.admin.query(
      `INSERT INTO governance_leases (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
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

  /** Call from afterEach. Cancels first, closes concurrently, bounded. */
  async cleanup(): Promise<void> {
    const pending = this.extras;
    this.extras = [];
    if (pending.length > 0) {
      await this.admin
        .query('SELECT pg_cancel_backend(pid) FROM unnest($1::int[]) AS pid', [
          pending.map((backend) => backend.pid),
        ])
        .catch(() => undefined);
    }
    await Promise.allSettled(
      pending.map((backend) => withDeadline(backend.client.end(), 5000, `closing ${backend.pid}`)),
    );
    await this.admin.query('ROLLBACK').catch(() => undefined);
  }

  /** Call from afterAll. */
  async close(): Promise<void> {
    await this.cleanup();
    await withDeadline(this.pool.end(), 5000, 'closing the pool').catch(() => undefined);
    await this.admin.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`).catch(() => undefined);
    await this.admin.end().catch(() => undefined);
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
