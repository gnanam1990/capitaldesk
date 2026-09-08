import type { Pool, PoolClient, Client } from 'pg';

/**
 * Transaction helpers for the journal.
 *
 * Economic writes run at SERIALIZABLE. PostgreSQL's serializable snapshot isolation refuses
 * an interleaving it cannot serialise with SQLSTATE 40001, and the correct response is to run
 * the whole unit again from a fresh snapshot - a bounded number of times, and only while
 * nothing outside the database has happened yet. Once a transaction has caused an external
 * effect, a retry would cause it twice, so the guard makes the failure final instead.
 *
 * No function here performs a network call, and none accepts a callback that should.
 */

/** A connection that can run statements. Pool checkouts and standalone clients both qualify. */
export type Queryable = PoolClient | Client;

export interface EffectGuard {
  /** Call before the first external effect. After this, no retry is permitted. */
  externalEffectStarted(): void;
  readonly started: boolean;
}

export interface SerializableOptions {
  /** Attempts in total, including the first. Default 5. */
  readonly maxAttempts?: number;
}

export class SerializationRetriesExhausted extends Error {
  constructor(
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(`serializable transaction failed ${attempts} times; not retrying further`);
    this.name = 'SerializationRetriesExhausted';
  }
}

const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

export function sqlStateOf(error: unknown): string | undefined {
  return (error as { code?: unknown })?.code as string | undefined;
}

function createGuard(): EffectGuard {
  let started = false;
  return {
    externalEffectStarted(): void {
      started = true;
    },
    get started(): boolean {
      return started;
    },
  };
}

/** Run `work` on a checked-out connection at SERIALIZABLE, with bounded retries. */
export async function serializable<T>(
  pool: Pool,
  work: (client: Queryable, effects: EffectGuard) => Promise<T>,
  options: SerializableOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    return await serializableOn(client, work, options);
  } finally {
    client.release();
  }
}

/**
 * Run `work` on the given connection at SERIALIZABLE, with bounded retries.
 *
 * Exposed so a concurrency test can pin each racing transaction to its own independent
 * connection; production paths go through `serializable`.
 */
export async function serializableOn<T>(
  client: Queryable,
  work: (client: Queryable, effects: EffectGuard) => Promise<T>,
  options: SerializableOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  for (let attempt = 1; ; attempt += 1) {
    const effects = createGuard();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      const result = await work(client, effects);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = sqlStateOf(error);
      // Only PostgreSQL's own serialization and deadlock failures. A unique violation raised
      // by a concurrent transaction under SERIALIZABLE already arrives as 40001, so no wider
      // predicate is needed, and an ordinary error must never be re-run.
      const retryable = code !== undefined && RETRYABLE_SQLSTATES.has(code);
      // An external effect makes the failure final whatever its cause: a retry would repeat
      // the effect, and there is no undoing a sent request.
      if (!retryable || effects.started) throw error;
      if (attempt >= maxAttempts) throw new SerializationRetriesExhausted(attempt, error);
    }
  }
}

/**
 * A plain READ COMMITTED transaction, for lock-based queue operations (SKIP LOCKED claims,
 * lease takeovers) where row locks rather than snapshots are the arbiter. No retry: these
 * paths are written so that a blocked statement re-evaluates against the committed row.
 */
export async function transactional<T>(
  pool: Pool,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await transactionalOn(client, work);
  } finally {
    client.release();
  }
}

export async function transactionalOn<T>(
  client: Queryable,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export interface PoolKey {
  readonly workspaceId: string;
  readonly poolId: string;
}

/**
 * The one order in which pool rows are locked, everywhere.
 *
 * Two transactions that lock the same rows in different orders can deadlock; PostgreSQL
 * detects it and aborts one, but that is a retry that need never happen. Sorting the keys
 * gives every writer the same order regardless of how its inputs arrived.
 */
export function lockOrder<K extends PoolKey>(keys: readonly K[]): K[] {
  return [...keys].sort((a, b) =>
    a.workspaceId === b.workspaceId
      ? a.poolId.localeCompare(b.poolId)
      : a.workspaceId.localeCompare(b.workspaceId),
  );
}

/** Lock the named pool rows in the canonical order, so callers cannot get it wrong. */
export async function lockPools(client: Queryable, keys: readonly PoolKey[]): Promise<void> {
  for (const key of lockOrder(keys)) {
    const locked = await client.query(
      'SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
      [key.workspaceId, key.poolId],
    );
    if (locked.rowCount !== 1) {
      throw new Error(`pool ${key.workspaceId}/${key.poolId} does not exist`);
    }
  }
}
