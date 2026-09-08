import type { Pool } from 'pg';
import { transactional, transactionalOn, type Queryable } from './transaction.js';

/**
 * Worker leases with a fencing token.
 *
 * The token increases on every acquisition, so a holder whose lease lapsed and was taken over
 * presents a stale token and is refused. This fences the database only: a sender that already
 * holds a dispatch marker may still complete its send after its lease expires, which is why
 * lease expiry never authorises a resend (TDD section 9).
 *
 * Every expiry decision is made by the database clock. There is no `now` argument, so a
 * worker whose clock runs fast cannot declare a live lease lapsed and take it early.
 */

export type AcquireLeaseOutcome =
  | { readonly ok: true; readonly fencingToken: bigint }
  | {
      readonly ok: false;
      readonly reason: 'HELD';
      readonly holderId: string;
      readonly expiresAt: Date;
    };

export type RenewLeaseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'NOT_HELD' }
  | { readonly ok: false; readonly reason: 'STALE_TOKEN'; readonly currentToken: bigint };

export interface AcquireLeaseInput {
  readonly leaseKey: string;
  readonly holderId: string;
  readonly ttlMs: number;
}

export class JobLeaseRepository {
  constructor(private readonly pool: Pool) {}

  acquire(input: AcquireLeaseInput): Promise<AcquireLeaseOutcome> {
    return transactional(this.pool, (client) => acquireBody(client, input));
  }

  /** Pinned to one connection, for a race proven on independent backends. */
  static acquireOn(client: Queryable, input: AcquireLeaseInput): Promise<AcquireLeaseOutcome> {
    return transactionalOn(client, (c) => acquireBody(c, input));
  }

  renew(input: {
    readonly leaseKey: string;
    readonly holderId: string;
    readonly fencingToken: bigint;
    readonly ttlMs: number;
  }): Promise<RenewLeaseOutcome> {
    return transactional(this.pool, async (client): Promise<RenewLeaseOutcome> => {
      const lease = await client.query<{ holder_id: string; fencing_token: string; live: boolean }>(
        `SELECT holder_id, fencing_token, expires_at > now() AS live FROM job_leases
          WHERE lease_key = $1 FOR UPDATE`,
        [input.leaseKey],
      );
      const row = lease.rows[0];
      if (row === undefined) return { ok: false, reason: 'NOT_HELD' };
      const currentToken = BigInt(row.fencing_token);
      // A stale token is named as such whoever presents it: the holder that lost its lease
      // needs to know it was fenced, not merely that someone else holds the lease now.
      if (currentToken !== input.fencingToken)
        return { ok: false, reason: 'STALE_TOKEN', currentToken };
      if (row.holder_id !== input.holderId || !row.live) return { ok: false, reason: 'NOT_HELD' };
      await client.query(
        `UPDATE job_leases SET expires_at = now() + ($2::bigint * interval '1 millisecond')
          WHERE lease_key = $1`,
        [input.leaseKey, input.ttlMs],
      );
      return { ok: true };
    });
  }

  async release(input: {
    readonly leaseKey: string;
    readonly holderId: string;
    readonly fencingToken: bigint;
  }): Promise<boolean> {
    // Releasing expires the lease rather than deleting the row, so the token sequence
    // continues from where it was and a resumed holder still reads a stale token.
    const updated = await this.pool.query(
      `UPDATE job_leases SET expires_at = acquired_at + interval '1 microsecond'
        WHERE lease_key = $1 AND holder_id = $2 AND fencing_token = $3 AND expires_at > now()`,
      [input.leaseKey, input.holderId, input.fencingToken.toString()],
    );
    return updated.rowCount === 1;
  }
}

/**
 * Acquire in one statement.
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE expires_at <= now()` makes the whole decision
 * atomically: a fresh key inserts, a lapsed lease is taken over with the next token, and a
 * live one updates nothing. Reading the row first and then inserting had a window between
 * them, so two acquirers racing for a key that did not exist yet both passed the read and one
 * surfaced a raw unique violation instead of a decision.
 */
async function acquireBody(
  client: Queryable,
  input: AcquireLeaseInput,
): Promise<AcquireLeaseOutcome> {
  const acquired = await client.query<{ fencing_token: string }>(
    `INSERT INTO job_leases (lease_key, holder_id, fencing_token, acquired_at, expires_at)
     VALUES ($1, $2, 1, now(), now() + ($3::bigint * interval '1 millisecond'))
     ON CONFLICT (lease_key) DO UPDATE
        SET holder_id = EXCLUDED.holder_id,
            fencing_token = job_leases.fencing_token + 1,
            acquired_at = now(),
            expires_at = EXCLUDED.expires_at
      WHERE job_leases.expires_at <= now()
     RETURNING fencing_token`,
    [input.leaseKey, input.holderId, input.ttlMs],
  );
  const won = acquired.rows[0];
  if (won !== undefined) return { ok: true, fencingToken: BigInt(won.fencing_token) };

  const holder = await client.query<{ holder_id: string; expires_at: Date }>(
    'SELECT holder_id, expires_at FROM job_leases WHERE lease_key = $1',
    [input.leaseKey],
  );
  const row = holder.rows[0];
  /* c8 ignore next -- the conflict target exists by definition once the insert conflicted. */
  if (row === undefined)
    return { ok: false, reason: 'HELD', holderId: 'unknown', expiresAt: new Date(0) };
  return { ok: false, reason: 'HELD', holderId: row.holder_id, expiresAt: row.expires_at };
}
