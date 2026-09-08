import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { PLAN_IN_FLIGHT_STATES } from './dispatch.js';
import { invalidateUnmarkedPlans } from './restore.js';
import { serializable, serializableOn, type Queryable } from './transaction.js';

/**
 * Governance of a venue account: who may act on these funds.
 *
 * Identity is the venue's stable authenticated account id. One active lease per account
 * across every workspace and pool in this registry is a partial unique index, so under a race
 * the database decides and the loser gets a typed refusal after re-reading, never a
 * constraint violation and never a second bootstrap of the same funds.
 *
 * Independent deployments that do not share this registry cannot enforce the exclusion. That
 * is a documented deployment and trust limit (TDD section 4), not something this code can
 * work around.
 */

export interface VenueAccountRef {
  readonly venue: string;
  readonly environment: string;
  readonly stableAccountId: string;
}

export interface AcquireGovernanceInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly account: VenueAccountRef;
  /** The credential that observed the account. Evidence, never identity. */
  readonly credentialAlias: string;
}

export type AcquireGovernanceOutcome =
  | {
      readonly ok: true;
      readonly kind: 'ACQUIRED';
      readonly leaseId: string;
      readonly epoch: number;
    }
  | {
      readonly ok: true;
      readonly kind: 'ALREADY_GOVERNED_HERE';
      readonly leaseId: string;
      readonly poolId: string;
      readonly epoch: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'LEASE_HELD_ELSEWHERE';
      readonly governingWorkspaceId: string;
      readonly governingPoolId: string;
    };

export type ReleaseGovernanceOutcome =
  | {
      readonly ok: true;
      /** Unmarked plans invalidated by this release, per ADR-0006 `INVALIDATE_UNMARKED`. */
      readonly plansInvalidated: number;
      readonly reservationsReleased: number;
      readonly attemptsVoided: number;
    }
  | { readonly ok: false; readonly reason: 'NO_ACTIVE_LEASE' }
  | {
      readonly ok: false;
      readonly reason: 'LIABILITIES_OUTSTANDING';
      readonly outstanding: number;
    };

export type RotateEpochOutcome =
  | { readonly ok: true; readonly epoch: number }
  | { readonly ok: false; readonly reason: 'UNKNOWN_POOL' }
  | { readonly ok: false; readonly reason: 'UNRESOLVED_ATTEMPTS'; readonly outstanding: number }
  /**
   * A plan that is sealed but has not reached a terminal outcome. Counting only unresolved
   * attempts missed an APPROVED plan that had never prepared one: rotation closed its epoch
   * and the plan remained dispatchable against a baseline that no longer existed.
   */
  | { readonly ok: false; readonly reason: 'PLAN_IN_FLIGHT'; readonly planIds: readonly string[] };

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

/** States in which an attempt is a liability the account still carries. */
const LIABILITY_STATES = `('DISPATCH_MARKED', 'SEND_ATTEMPTED', 'UNKNOWN', 'IRRECOVERABLE_UNCERTAINTY')`;
/** States in which an attempt is unresolved and blocks an epoch rotation. */
const UNRESOLVED_STATES = `('DISPATCH_MARKED', 'SEND_ATTEMPTED', 'UNKNOWN')`;

export class GovernanceRepository {
  constructor(private readonly pool: Pool) {}

  acquire(input: AcquireGovernanceInput): Promise<AcquireGovernanceOutcome> {
    return GovernanceRepository.acquireWith(this.pool, input);
  }

  static acquireWith(pool: Pool, input: AcquireGovernanceInput): Promise<AcquireGovernanceOutcome> {
    return serializable(pool, (client) => acquireBody(client, input));
  }

  /** The same acquisition pinned to one connection, for a race proven on independent backends. */
  static acquireOn(
    client: Queryable,
    input: AcquireGovernanceInput,
  ): Promise<AcquireGovernanceOutcome> {
    return serializableOn(client, (c) => acquireBody(c, input));
  }

  /**
   * Release a pool's lease.
   *
   * Refused while the account carries any unresolved dispatch liability, in any epoch of any
   * pool that governed it. The trigger on governance_leases is the backstop for a writer that
   * bypasses this method; the check here is what turns it into a typed decision.
   */
  release(input: {
    workspaceId: string;
    poolId: string;
    reason: string;
  }): Promise<ReleaseGovernanceOutcome> {
    return serializable(this.pool, async (client): Promise<ReleaseGovernanceOutcome> => {
      // The pool row first, in the order every economic writer takes it.
      await client.query(
        'SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
        [input.workspaceId, input.poolId],
      );
      const lease = await client.query<{
        lease_id: string;
        venue: string;
        environment: string;
        stable_account_id: string;
      }>(
        `SELECT lease_id, venue, environment, stable_account_id FROM governance_leases
          WHERE workspace_id = $1 AND pool_id = $2 AND released_at IS NULL FOR UPDATE`,
        [input.workspaceId, input.poolId],
      );
      const row = lease.rows[0];
      if (row === undefined) return { ok: false, reason: 'NO_ACTIVE_LEASE' };

      const outstanding = await countLiabilities(client, row);
      if (outstanding > 0) return { ok: false, reason: 'LIABILITIES_OUTSTANDING', outstanding };

      await client.query(
        `UPDATE governance_leases SET released_at = now(), released_reason = $2 WHERE lease_id = $1`,
        [row.lease_id, input.reason],
      );
      // A pool without a lease governs nothing. Leaving it READY let an approved plan keep
      // dispatching and its claims keep moving after the lease was retired, so the pool is
      // halted in the same transaction - and every path that creates approval, reservation
      // or dispatch authority independently requires both an allowed pool state and a live
      // lease, so neither guard stands alone.
      await client.query(
        `UPDATE pools SET state = 'HALTED', version = version + 1, updated_at = now()
          WHERE workspace_id = $1 AND pool_id = $2`,
        [input.workspaceId, input.poolId],
      );
      // Release resolves what it withdraws authority from rather than halting around it.
      // The two accepted lifecycle rules compose here: this release is refused outright
      // while a dispatch is in flight, exactly as `ACCOUNT_UNLINK` is, and because it halts
      // the pool it carries `POOL_HALT`'s `INVALIDATE_UNMARKED` effect - unmarked plans are
      // invalidated and their reservations returned in this same transaction, so no plan is
      // left permanently unapprovable while still holding the owner's capital.
      const invalidated = await invalidateUnmarkedPlans(client, {
        reason: `governance lease released: ${input.reason}`,
        releaseKind: 'lease-release',
        scope: { workspaceId: input.workspaceId, poolId: input.poolId },
      });
      return { ok: true, ...invalidated };
    });
  }

  /**
   * Open a new baseline epoch, closing the current one.
   *
   * The lease is untouched: rotation partitions history, it does not discharge liability. An
   * attempt still in flight or UNKNOWN blocks rotation until it is resolved - to a decisive
   * outcome or, honestly, to IRRECOVERABLE_UNCERTAINTY, which is retained under the old epoch
   * (ADR-0001 section 4).
   */
  rotateEpoch(input: {
    workspaceId: string;
    poolId: string;
    reason: string;
  }): Promise<RotateEpochOutcome> {
    return serializable(this.pool, async (client): Promise<RotateEpochOutcome> => {
      const pool = await client.query(
        'SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
        [input.workspaceId, input.poolId],
      );
      if (pool.rowCount !== 1) return { ok: false, reason: 'UNKNOWN_POOL' };

      const unresolved = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dispatch_attempts
          WHERE workspace_id = $1 AND pool_id = $2 AND state IN ${UNRESOLVED_STATES}`,
        [input.workspaceId, input.poolId],
      );
      const outstanding = Number(unresolved.rows[0]?.count ?? '0');
      if (outstanding > 0) return { ok: false, reason: 'UNRESOLVED_ATTEMPTS', outstanding };

      // A sealed plan that has not reached a terminal outcome still carries authority, whether
      // or not it ever prepared an attempt. The pool row is locked above, and every path that
      // seals, reserves, prepares or marks takes the same lock and re-reads the open epoch, so
      // rotation and preparation cannot interleave.
      const inFlight = await client.query<{ plan_id: string }>(
        `SELECT plan_id FROM plans
          WHERE workspace_id = $1 AND pool_id = $2 AND state = ANY($3::text[])
          ORDER BY plan_id`,
        [input.workspaceId, input.poolId, PLAN_IN_FLIGHT_STATES],
      );
      if (inFlight.rowCount !== null && inFlight.rowCount > 0) {
        return {
          ok: false,
          reason: 'PLAN_IN_FLIGHT',
          planIds: inFlight.rows.map((r) => r.plan_id),
        };
      }

      const current = await client.query<{ epoch: number }>(
        `UPDATE baseline_epochs SET closed_at = now(), closed_reason = $3
          WHERE workspace_id = $1 AND pool_id = $2 AND closed_at IS NULL
          RETURNING epoch`,
        [input.workspaceId, input.poolId, input.reason],
      );
      const next = (current.rows[0]?.epoch ?? 0) + 1;
      await client.query(
        'INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1, $2, $3)',
        [input.workspaceId, input.poolId, next],
      );
      return { ok: true, epoch: next };
    });
  }

  async currentEpoch(scope: { workspaceId: string; poolId: string }): Promise<number | null> {
    const result = await this.pool.query<{ epoch: number }>(
      `SELECT epoch FROM baseline_epochs WHERE workspace_id = $1 AND pool_id = $2 AND closed_at IS NULL`,
      [scope.workspaceId, scope.poolId],
    );
    return result.rows[0]?.epoch ?? null;
  }
}

/*
 * The losing side of a lease race reaches the partial unique index with a snapshot that
 * predates the winner. Under SERIALIZABLE, PostgreSQL reports a unique violation caused by a
 * concurrent transaction as a serialization failure rather than as 23505, so the ordinary
 * retry re-runs the transaction from a fresh snapshot, where it reads the winner's lease and
 * returns the typed refusal. An earlier draft added a special retry for 23505 on the lease
 * index; the race test passed identically without it, so it is not here.
 */

async function acquireBody(
  client: Queryable,
  input: AcquireGovernanceInput,
): Promise<AcquireGovernanceOutcome> {
  const { venue, environment, stableAccountId } = input.account;

  // The account row is the lock every acquisition for this identity takes first, so two
  // acquirers are serialised on it whatever their workspaces.
  await client.query(
    `INSERT INTO venue_accounts (venue, environment, stable_account_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [venue, environment, stableAccountId],
  );
  await client.query(
    `SELECT 1 FROM venue_accounts WHERE venue = $1 AND environment = $2 AND stable_account_id = $3 FOR UPDATE`,
    [venue, environment, stableAccountId],
  );
  // Which credentials have seen this account is evidence worth keeping; it is never identity.
  await client.query(
    `INSERT INTO venue_account_credentials (venue, environment, stable_account_id, credential_alias)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [venue, environment, stableAccountId, input.credentialAlias],
  );

  const existing = await client.query<{ lease_id: string; workspace_id: string; pool_id: string }>(
    `SELECT lease_id, workspace_id, pool_id FROM governance_leases
      WHERE venue = $1 AND environment = $2 AND stable_account_id = $3 AND released_at IS NULL`,
    [venue, environment, stableAccountId],
  );
  const held = existing.rows[0];
  if (held !== undefined) {
    if (held.workspace_id === input.workspaceId && held.pool_id === input.poolId) {
      // A rotated credential for the pool that already governs this account: the same
      // governance, the same funds, no second bootstrap.
      const epoch = await client.query<{ epoch: number }>(
        `SELECT epoch FROM baseline_epochs WHERE workspace_id = $1 AND pool_id = $2 AND closed_at IS NULL`,
        [held.workspace_id, held.pool_id],
      );
      return {
        ok: true,
        kind: 'ALREADY_GOVERNED_HERE',
        leaseId: held.lease_id,
        poolId: held.pool_id,
        epoch: epoch.rows[0]?.epoch ?? 1,
      };
    }
    return {
      ok: false,
      reason: 'LEASE_HELD_ELSEWHERE',
      governingWorkspaceId: held.workspace_id,
      governingPoolId: held.pool_id,
    };
  }

  await client.query(
    `INSERT INTO pools (workspace_id, pool_id, venue, environment, stable_account_id, state)
     VALUES ($1, $2, $3, $4, $5, 'BOOTSTRAPPING')`,
    [input.workspaceId, input.poolId, venue, environment, stableAccountId],
  );
  await client.query(
    'INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1, $2, 1)',
    [input.workspaceId, input.poolId],
  );
  const leaseId = newId('lease');
  await client.query(
    `INSERT INTO governance_leases (lease_id, venue, environment, stable_account_id, workspace_id, pool_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [leaseId, venue, environment, stableAccountId, input.workspaceId, input.poolId],
  );
  return { ok: true, kind: 'ACQUIRED', leaseId, epoch: 1 };
}

async function countLiabilities(
  client: Queryable,
  account: {
    venue: string;
    environment: string;
    stable_account_id: string;
  },
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM dispatch_attempts a
       JOIN pools p ON p.workspace_id = a.workspace_id AND p.pool_id = a.pool_id
      WHERE p.venue = $1 AND p.environment = $2 AND p.stable_account_id = $3
        AND a.state IN ${LIABILITY_STATES}`,
    [account.venue, account.environment, account.stable_account_id],
  );
  return Number(result.rows[0]?.count ?? '0');
}
