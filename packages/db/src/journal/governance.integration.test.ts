import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GovernanceRepository } from './governance.js';
import { DispatchRepository } from './dispatch.js';
import {
  ACCOUNT,
  DATABASE_URL,
  JournalHarness,
  OTHER_WORKSPACE,
  POOL,
  WORKSPACE,
  sqlState,
} from './test-harness.js';

/**
 * One stable account, one governing pool (T-056; TDD section 4).
 *
 * The identity is the venue's own account id. Two workspaces presenting two different
 * credentials for it are presenting the same funds, and the registry must let exactly one of
 * them govern - decided by the database under a race, not by whichever request happened to
 * read first.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describeIfDatabase('governance lease', () => {
  const harness = new JournalHarness();
  let governance: GovernanceRepository;
  let dispatch: DispatchRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    governance = new GovernanceRepository(harness.pool);
    dispatch = new DispatchRepository(harness.pool);
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it('lets exactly one of two racing workspaces govern the same account', async () => {
    const [left, right, barrier] = await Promise.all([
      harness.connect(),
      harness.connect(),
      harness.connect(),
    ]);
    // Barrier: hold the venue account row that every acquisition locks first.
    await barrier.client.query(
      `INSERT INTO venue_accounts (venue, environment, stable_account_id) VALUES ($1,$2,$3)`,
      [ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId],
    );
    await barrier.client.query('BEGIN');
    await barrier.client.query(
      `SELECT 1 FROM venue_accounts WHERE venue=$1 AND environment=$2 AND stable_account_id=$3 FOR UPDATE`,
      [ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId],
    );

    const acquire = (workspaceId: string, poolId: string, alias: string) =>
      GovernanceRepository.acquireWith(harness.pool, {
        workspaceId,
        poolId,
        account: ACCOUNT,
        credentialAlias: alias,
      });
    // Independent backends: each call is pinned to its own connection for the race.
    const both = Promise.all([
      GovernanceRepository.acquireOn(left.client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        account: ACCOUNT,
        credentialAlias: 'key-left',
      }),
      GovernanceRepository.acquireOn(right.client, {
        workspaceId: OTHER_WORKSPACE,
        poolId: 'pool-other',
        account: ACCOUNT,
        credentialAlias: 'key-right',
      }),
    ]);
    both.catch(() => undefined);
    try {
      await harness.waitUntilBlockedBy(barrier.pid, [left.pid, right.pid]);
    } finally {
      await barrier.client.query('ROLLBACK').catch(() => undefined);
    }
    const [a, b] = await both;
    void acquire;

    const acquired = [a, b].filter((outcome) => outcome.ok && outcome.kind === 'ACQUIRED');
    const refused = [a, b].filter((outcome) => !outcome.ok);
    expect(acquired).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ ok: false, reason: 'LEASE_HELD_ELSEWHERE' });

    const active = await harness.admin.query(
      `SELECT workspace_id, pool_id FROM governance_leases WHERE released_at IS NULL`,
    );
    expect(active.rowCount).toBe(1);
    // Only one pool exists: the loser did not bootstrap anything.
    const pools = await harness.admin.query('SELECT pool_id FROM pools');
    expect(pools.rowCount).toBe(1);
  });

  it('returns the existing governance for a rotated credential of the same account', async () => {
    const first = await governance.acquire({
      workspaceId: WORKSPACE,
      poolId: POOL,
      account: ACCOUNT,
      credentialAlias: 'key-1',
    });
    expect(first).toMatchObject({ ok: true, kind: 'ACQUIRED', epoch: 1 });

    // A new API key for the same authenticated uid is the same account. It must find the
    // existing pool and lease, never a second bootstrap of the same funds.
    const rotated = await governance.acquire({
      workspaceId: WORKSPACE,
      poolId: POOL,
      account: ACCOUNT,
      credentialAlias: 'key-2',
    });
    expect(rotated).toMatchObject({ ok: true, kind: 'ALREADY_GOVERNED_HERE', poolId: POOL });

    const aliases = await harness.admin.query<{ credential_alias: string }>(
      `SELECT credential_alias FROM venue_account_credentials ORDER BY credential_alias`,
    );
    expect(aliases.rows.map((row) => row.credential_alias)).toEqual(['key-1', 'key-2']);
    expect((await harness.admin.query('SELECT 1 FROM pools')).rowCount).toBe(1);
    expect((await harness.admin.query('SELECT 1 FROM baseline_epochs')).rowCount).toBe(1);
  });

  it('refuses a second pool for the same account even in the same workspace', async () => {
    await governance.acquire({
      workspaceId: WORKSPACE,
      poolId: POOL,
      account: ACCOUNT,
      credentialAlias: 'key-1',
    });
    const second = await governance.acquire({
      workspaceId: WORKSPACE,
      poolId: 'pool-2',
      account: ACCOUNT,
      credentialAlias: 'key-1',
    });
    expect(second).toMatchObject({
      ok: false,
      reason: 'LEASE_HELD_ELSEWHERE',
      governingWorkspaceId: WORKSPACE,
      governingPoolId: POOL,
    });
  });

  it('cannot release the lease while an UNKNOWN dispatch liability remains', async () => {
    await governance.acquire({
      workspaceId: WORKSPACE,
      poolId: POOL,
      account: ACCOUNT,
      credentialAlias: 'key-1',
    });
    // Acquiring leaves the pool BOOTSTRAPPING, which is deliberately not dispatchable: a
    // marker needs a pool that has a baseline. Move it on, as module 06 will.
    await harness.admin.query(`UPDATE pools SET state = 'READY'`);
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: { note: 'fixture' },
      payloadDigest: 'digest-1',
      state: 'DISPATCH_PENDING',
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'attempt-1',
      clientOrderId: 'cd-attempt-1',
      dispatchToken: 'token-1',
    });
    await dispatch.mark({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      outboxId: 'outbox-1',
      signedRequest: { signed: true },
      host: { bootId: 'boot-1', pid: 1 },
    });
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      to: 'UNKNOWN',
    });

    const release = await governance.release({
      workspaceId: WORKSPACE,
      poolId: POOL,
      reason: 'closing',
    });
    expect(release).toEqual({ ok: false, reason: 'LIABILITIES_OUTSTANDING', outstanding: 1 });

    // And not by going around the repository either.
    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `UPDATE governance_leases SET released_at = now(), released_reason = 'forced'`,
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23001');

    // Nor does an IRRECOVERABLE_UNCERTAINTY resolution free it: that is an honest record of a
    // retained liability, not a release (ADR-0001 section 3).
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      to: 'IRRECOVERABLE_UNCERTAINTY',
    });
    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' }),
    ).toEqual({ ok: false, reason: 'LIABILITIES_OUTSTANDING', outstanding: 1 });
  });

  it('releases a lease with no liabilities, and the account can then be governed again', async () => {
    await governance.acquire({
      workspaceId: WORKSPACE,
      poolId: POOL,
      account: ACCOUNT,
      credentialAlias: 'key-1',
    });
    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' }),
    ).toEqual({
      ok: true,
    });
    // The released row remains as history.
    const rows = await harness.admin.query<{ released_reason: string | null }>(
      'SELECT released_reason FROM governance_leases',
    );
    expect(rows.rows).toEqual([{ released_reason: 'closing' }]);

    const again = await governance.acquire({
      workspaceId: OTHER_WORKSPACE,
      poolId: 'pool-other',
      account: ACCOUNT,
      credentialAlias: 'key-other',
    });
    expect(again).toMatchObject({ ok: true, kind: 'ACQUIRED' });
  });

  it('rotates the epoch, keeps the lease, and retains the old epoch with its liabilities', async () => {
    await governance.acquire({
      workspaceId: WORKSPACE,
      poolId: POOL,
      account: ACCOUNT,
      credentialAlias: 'key-1',
    });
    await harness.admin.query(`UPDATE pools SET state = 'READY'`);
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: {},
      payloadDigest: 'd1',
      state: 'DISPATCH_PENDING',
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      attemptId: 'attempt-1',
      clientOrderId: 'cd-1',
      dispatchToken: 'tok-1',
    });
    await dispatch.mark({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      outboxId: 'ob-1',
      signedRequest: {},
      host: { bootId: 'b', pid: 1 },
    });
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      to: 'UNKNOWN',
    });

    // An unresolved attempt blocks rotation: the old epoch's uncertainty must first be
    // recorded as what it is.
    expect(
      await governance.rotateEpoch({ workspaceId: WORKSPACE, poolId: POOL, reason: 'reset' }),
    ).toEqual({
      ok: false,
      reason: 'UNRESOLVED_ATTEMPTS',
      outstanding: 1,
    });
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-1',
      to: 'IRRECOVERABLE_UNCERTAINTY',
    });

    const rotated = await governance.rotateEpoch({
      workspaceId: WORKSPACE,
      poolId: POOL,
      reason: 'reset',
    });
    expect(rotated).toEqual({ ok: true, epoch: 2 });

    const epochs = await harness.admin.query<{ epoch: number; closed_reason: string | null }>(
      'SELECT epoch, closed_reason FROM baseline_epochs ORDER BY epoch',
    );
    expect(epochs.rows).toEqual([
      { epoch: 1, closed_reason: 'reset' },
      { epoch: 2, closed_reason: null },
    ]);
    // The lease is untouched by rotation: the liability is still attached to this account.
    expect(
      (await harness.admin.query('SELECT 1 FROM governance_leases WHERE released_at IS NULL'))
        .rowCount,
    ).toBe(1);
    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'x' }),
    ).toMatchObject({
      ok: false,
      reason: 'LIABILITIES_OUTSTANDING',
    });

    // A new-epoch attempt cannot name the old epoch's plan (T-032): the tuple FK refuses it.
    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `INSERT INTO dispatch_attempts (workspace_id, pool_id, epoch, attempt_id, plan_id, client_order_id, dispatch_token)
         VALUES ($1,$2,2,'attempt-2','plan-1','cd-2','tok-2')`,
        [WORKSPACE, POOL],
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23503');
  });

  it('refuses a stable account id that is not an identifier', async () => {
    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `INSERT INTO venue_accounts (venue, environment, stable_account_id) VALUES ('binance-spot','local','')`,
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23514');
  });
});
