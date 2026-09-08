import type { Pool } from 'pg';
import { transactional, transactionalOn, type Queryable } from './transaction.js';

/**
 * Worker leases with a fencing token.
 *
 * The token increases on every acquisition, so a holder whose lease lapsed and was taken over
 * presents a stale token and is refused. This fences the database only: a sender that already
 * holds a dispatch marker may still complete its send after its lease expires, which is why
 * lease expiry never authorises a resend (TDD section 9).
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
  readonly now: Date;
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
    readonly now: Date;
  }): Promise<RenewLeaseOutcome> {
    return transactional(this.pool, async (client): Promise<RenewLeaseOutcome> => {
      const lease = await client.query<{
        holder_id: string;
        fencing_token: string;
        expires_at: Date;
      }>(
        'SELECT holder_id, fencing_token, expires_at FROM job_leases WHERE lease_key = $1 FOR UPDATE',
        [input.leaseKey],
      );
      const row = lease.rows[0];
      if (row === undefined) return { ok: false, reason: 'NOT_HELD' };
      const currentToken = BigInt(row.fencing_token);
      // A stale token is named as such whoever presents it: the holder that lost its lease
      // needs to know it was fenced, not merely that someone else holds the lease now.
      if (currentToken !== input.fencingToken)
        return { ok: false, reason: 'STALE_TOKEN', currentToken };
      if (row.holder_id !== input.holderId || row.expires_at.getTime() <= input.now.getTime()) {
        return { ok: false, reason: 'NOT_HELD' };
      }
      await client.query('UPDATE job_leases SET expires_at = $2 WHERE lease_key = $1', [
        input.leaseKey,
        new Date(input.now.getTime() + input.ttlMs),
      ]);
      return { ok: true };
    });
  }

  async release(input: {
    readonly leaseKey: string;
    readonly holderId: string;
    readonly fencingToken: bigint;
    readonly now: Date;
  }): Promise<boolean> {
    // Releasing sets the expiry into the past rather than deleting the row, so the token
    // sequence continues from where it was.
    const updated = await this.pool.query(
      `UPDATE job_leases SET expires_at = acquired_at + interval '1 microsecond'
        WHERE lease_key = $1 AND holder_id = $2 AND fencing_token = $3 AND expires_at > $4`,
      [input.leaseKey, input.holderId, input.fencingToken.toString(), input.now],
    );
    return updated.rowCount === 1;
  }
}

async function acquireBody(
  client: Queryable,
  input: AcquireLeaseInput,
): Promise<AcquireLeaseOutcome> {
  const expiresAt = new Date(input.now.getTime() + input.ttlMs);
  // Row lock, READ COMMITTED: a second acquirer blocked here re-reads the row the winner
  // committed and sees it held.
  const lease = await client.query<{ holder_id: string; fencing_token: string; expires_at: Date }>(
    'SELECT holder_id, fencing_token, expires_at FROM job_leases WHERE lease_key = $1 FOR UPDATE',
    [input.leaseKey],
  );
  const row = lease.rows[0];
  if (row === undefined) {
    await client.query(
      `INSERT INTO job_leases (lease_key, holder_id, fencing_token, acquired_at, expires_at) VALUES ($1, $2, 1, $3, $4)`,
      [input.leaseKey, input.holderId, input.now, expiresAt],
    );
    return { ok: true, fencingToken: 1n };
  }
  if (row.expires_at.getTime() > input.now.getTime()) {
    return { ok: false, reason: 'HELD', holderId: row.holder_id, expiresAt: row.expires_at };
  }
  const nextToken = BigInt(row.fencing_token) + 1n;
  await client.query(
    `UPDATE job_leases SET holder_id = $2, fencing_token = $3, acquired_at = $4, expires_at = $5 WHERE lease_key = $1`,
    [input.leaseKey, input.holderId, nextToken.toString(), input.now, expiresAt],
  );
  return { ok: true, fencingToken: nextToken };
}
