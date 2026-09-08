import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DispatchRepository } from './dispatch.js';
import { GovernanceRepository } from './governance.js';
import { LedgerRepository } from './ledger.js';
import {
  DATABASE_URL,
  JournalHarness,
  POOL,
  USDT,
  WORKSPACE,
  type Backend,
} from './test-harness.js';

/**
 * Blocker 1 of the maintainer's fourth exact-head review of PR #2.
 *
 * The third round proved only that `mark` refuses after a governance lease is released. The
 * maintainer's probe then sealed a plan, reserved 500 atoms and prepared a dispatch attempt
 * in that same halted, ungoverned pool, because sealing, reserving and preparing took the
 * pool lock without asking whether the pool could still create authority.
 *
 * The rule these cases pin: under the pool lock, every path that creates approval,
 * reservation or dispatch authority requires both an allowed pool state and a live
 * governance lease. Compensating accounting is deliberately outside that rule, so a halted
 * pool can still account for the liabilities it already carries.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const SCOPE = { workspaceId: WORKSPACE, poolId: POOL, epoch: 1 } as const;

describeIfDatabase('withdrawn authority stops every authority-creating path', () => {
  const harness = new JournalHarness();
  let dispatch: DispatchRepository;
  let ledger: LedgerRepository;
  let governance: GovernanceRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    dispatch = new DispatchRepository(harness.pool);
    ledger = new LedgerRepository(harness.pool);
    governance = new GovernanceRepository(harness.pool);
    await ledger.postTransaction({
      ...SCOPE,
      ledgerTxnId: 'txn-bootstrap',
      source: { kind: 'bootstrap', ref: 'round-4' },
      description: 'baseline',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 20_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 20_000n,
        },
      ],
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  function seal(planId = 'plan-1'): Promise<unknown> {
    return dispatch.sealPlan({
      ...SCOPE,
      planId,
      payload: { symbol: 'BTCUSDT' },
      payloadDigest: `digest-${planId}`,
      state: 'DISPATCH_PENDING',
    });
  }
  function reserve(reservationId = 'res-1', planId = 'plan-1'): Promise<unknown> {
    return ledger.reserve({
      ...SCOPE,
      reservationId,
      strategyId: 'strategy-a',
      planId,
      asset: USDT,
      atoms: 500n,
    });
  }
  function prepare(attemptId = 'attempt-1', planId = 'plan-1'): Promise<unknown> {
    return dispatch.prepare({
      ...SCOPE,
      planId,
      attemptId,
      clientOrderId: `client-${attemptId}`,
      dispatchToken: `token-${attemptId}`,
    });
  }

  /** Everything a refused path must not have changed. */
  async function snapshot(): Promise<Record<string, string | null>> {
    const result = await harness.admin.query<Record<string, string | null>>(
      `SELECT (SELECT count(*)::text FROM plans) AS plans,
              (SELECT count(*)::text FROM reservations) AS reservations,
              (SELECT count(*)::text FROM dispatch_attempts) AS attempts,
              (SELECT count(*)::text FROM ledger_transactions) AS ledger_txns,
              (SELECT count(*)::text FROM ledger_entries) AS ledger_entries,
              (SELECT ledger_revision::text FROM pools
                WHERE workspace_id = $1 AND pool_id = $2) AS revision,
              (SELECT coalesce(sum(delta_atoms), 0)::text FROM ledger_entries
                WHERE claim_state = 'AVAILABLE' AND account_owner = 'strategy-a') AS available,
              (SELECT coalesce(sum(delta_atoms), 0)::text FROM ledger_entries
                WHERE claim_state = 'RESERVED' AND account_owner = 'strategy-a') AS reserved`,
      [WORKSPACE, POOL],
    );
    return result.rows[0] ?? {};
  }

  it('refuses sealing, reserving and preparing after the lease is released, changing nothing', async () => {
    const before = await snapshot();
    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' }),
    ).toEqual({ ok: true, plansInvalidated: 0, reservationsReleased: 0, attemptsVoided: 0 });

    const halted = { ok: false, reason: 'POOL_NOT_DISPATCHABLE', state: 'HALTED' };
    expect(await seal()).toEqual(halted);
    expect(await reserve()).toEqual(halted);
    expect(await prepare()).toEqual(halted);

    // The exact evidence the maintainer's probe found missing: no plan, no reservation, no
    // attempt, no ledger movement, and the same revision and balances as before.
    expect(await snapshot()).toEqual(before);
  });

  it('refuses each path on the lease alone, with the pool state left dispatchable', async () => {
    // Isolate the second half of the gate. A READY pool whose lease is gone governs nothing,
    // so a state check on its own would let all three through.
    await harness.admin.query(
      `UPDATE governance_leases SET released_at = now(), released_reason = 'gone'`,
    );
    const state = await harness.admin.query<{ state: string }>(
      'SELECT state FROM pools WHERE workspace_id = $1 AND pool_id = $2',
      [WORKSPACE, POOL],
    );
    expect(state.rows[0]?.state).toBe('READY');

    const before = await snapshot();
    const ungoverned = { ok: false, reason: 'NO_ACTIVE_LEASE' };
    expect(await seal()).toEqual(ungoverned);
    expect(await reserve()).toEqual(ungoverned);
    expect(await prepare()).toEqual(ungoverned);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses each path in every non-authority pool state', async () => {
    for (const state of ['BOOTSTRAPPING', 'HALTED', 'QUARANTINED']) {
      await harness.admin.query('UPDATE pools SET state = $1', [state]);
      const refusal = { ok: false, reason: 'POOL_NOT_DISPATCHABLE', state };
      expect(await seal(`plan-${state}`)).toEqual(refusal);
      expect(await reserve(`res-${state}`, `plan-${state}`)).toEqual(refusal);
      expect(await prepare(`attempt-${state}`, `plan-${state}`)).toEqual(refusal);
    }
    expect(
      (await harness.admin.query('SELECT 1 FROM plans UNION ALL SELECT 1 FROM reservations'))
        .rowCount,
    ).toBe(0);
  });

  it('still records compensating accounting while halted and ungoverned', async () => {
    await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' });

    // A halted pool must still be able to account for what it already owes. Blanket-disabling
    // the ledger would strand every existing liability unrecordable.
    const posted = await ledger.postTransaction({
      ...SCOPE,
      ledgerTxnId: 'txn-reconciliation',
      source: { kind: 'reconciliation', ref: 'external-fill' },
      description: 'an externally observed movement, recorded while halted',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: -1_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: -1_000n,
        },
      ],
    });
    expect(posted).toMatchObject({ ok: true });
    const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
    expect(balances).toEqual([
      {
        owner: 'strategy-a',
        asset: USDT,
        availableAtoms: 19_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
    ]);
  });

  it('releases a held reservation while halted, so withdrawn authority cannot strand capital', async () => {
    expect(await seal()).toEqual({ ok: true });
    expect(await reserve()).toEqual({ ok: true, revision: 2 });

    // Release now resolves what it withdraws authority from: ADR-0006 gives POOL_HALT the
    // INVALIDATE_UNMARKED effect, and this release halts the pool.
    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' }),
    ).toEqual({ ok: true, plansInvalidated: 1, reservationsReleased: 1, attemptsVoided: 0 });

    const plan = await harness.admin.query<{ state: string }>('SELECT state FROM plans');
    expect(plan.rows[0]?.state).toBe('INVALIDATED');
    const reservation = await harness.admin.query<{ state: string }>(
      'SELECT state FROM reservations',
    );
    expect(reservation.rows[0]?.state).toBe('RELEASED');
    expect(await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 })).toEqual([
      {
        owner: 'strategy-a',
        asset: USDT,
        availableAtoms: 20_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
    ]);
  });

  it('voids a prepared attempt when its unmarked plan is invalidated by the release', async () => {
    expect(await seal()).toEqual({ ok: true });
    expect(await reserve()).toEqual({ ok: true, revision: 2 });
    expect(await prepare()).toEqual({ ok: true });

    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' }),
    ).toEqual({ ok: true, plansInvalidated: 1, reservationsReleased: 1, attemptsVoided: 1 });

    const attempt = await harness.admin.query<{ state: string; voided_reason: string | null }>(
      'SELECT state, voided_reason FROM dispatch_attempts',
    );
    expect(attempt.rows[0]?.state).toBe('PREPARED');
    expect(attempt.rows[0]?.voided_reason).toContain('governance lease released');
  });

  it('refuses the release outright while a dispatch is in flight, leaving the liability alone', async () => {
    await seal();
    await reserve();
    await prepare();
    expect(
      await dispatch.mark({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'attempt-1',
        outboxId: 'outbox-1',
        signedRequest: { symbol: 'BTCUSDT' },
        host: { bootId: 'boot-1', pid: 42, processStartedAt: new Date('2026-09-08T00:00:00Z') },
      }),
    ).toEqual({ ok: true });

    // ADR-0006 refuses ACCOUNT_UNLINK outright while a dispatch is in flight, because its
    // meaning would be incoherent under a possibly live order. Retiring the account's
    // governance lease is that action.
    expect(
      await governance.release({ workspaceId: WORKSPACE, poolId: POOL, reason: 'closing' }),
    ).toEqual({ ok: false, reason: 'LIABILITIES_OUTSTANDING', outstanding: 1 });

    const pool = await harness.admin.query<{ state: string }>('SELECT state FROM pools');
    expect(pool.rows[0]?.state).toBe('READY');
    const reservation = await harness.admin.query<{ state: string }>(
      'SELECT state FROM reservations',
    );
    expect(reservation.rows[0]?.state).toBe('HELD');
  });

  /**
   * Queue the release and one authority-creating path against the same pool row, in a chosen
   * order, on independent backends.
   *
   * A barrier connection holds the pool row. The first contender is started and proven
   * blocked on that barrier through `pg_blocking_pids` before the second is started, so the
   * lock queue order is the one the test asked for rather than whichever promise the event
   * loop happened to schedule. Letting them race freely produced the same winner every time,
   * which left the other interleaving asserted but never executed.
   */
  async function queueAgainstRelease(
    first: 'release' | 'path',
    run: (repositories: {
      dispatch: DispatchRepository;
      ledger: LedgerRepository;
    }) => Promise<unknown>,
    setup?: () => Promise<void>,
  ): Promise<{ path: unknown; release: unknown }> {
    if (setup !== undefined) await setup();
    const barrier: Backend = await harness.connect();
    const releaser = await harness.pinnedRepositoryPool();
    const contender = await harness.pinnedRepositoryPool();

    await barrier.client.query('BEGIN');
    await barrier.client.query(
      'SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
      [WORKSPACE, POOL],
    );

    const startRelease = (): Promise<unknown> =>
      new GovernanceRepository(releaser.pool).release({
        workspaceId: WORKSPACE,
        poolId: POOL,
        reason: 'racing',
      });
    const startPath = (): Promise<unknown> =>
      run({
        dispatch: new DispatchRepository(contender.pool),
        ledger: new LedgerRepository(contender.pool),
      });

    const firstPid = first === 'release' ? releaser.pid : contender.pid;
    const secondPid = first === 'release' ? contender.pid : releaser.pid;
    const firstPromise = first === 'release' ? startRelease() : startPath();
    await harness.waitUntilBlockedBy(barrier.pid, [firstPid]);
    const secondPromise = first === 'release' ? startPath() : startRelease();
    await harness.waitUntilBlockedBy(barrier.pid, [firstPid, secondPid]);
    await barrier.client.query('COMMIT');

    const [releaseResult, pathResult] =
      first === 'release'
        ? await Promise.all([firstPromise, secondPromise])
        : await Promise.all([secondPromise, firstPromise]);
    return { path: pathResult, release: releaseResult };
  }

  const sealRace = ({ dispatch: d }: { dispatch: DispatchRepository }): Promise<unknown> =>
    d.sealPlan({
      ...SCOPE,
      planId: 'plan-race',
      payload: {},
      payloadDigest: 'race',
      state: 'DISPATCH_PENDING',
    });
  const reserveRace = ({ ledger: l }: { ledger: LedgerRepository }): Promise<unknown> =>
    l.reserve({
      ...SCOPE,
      reservationId: 'res-race',
      strategyId: 'strategy-a',
      planId: 'plan-1',
      asset: USDT,
      atoms: 500n,
    });
  const prepareRace = ({ dispatch: d }: { dispatch: DispatchRepository }): Promise<unknown> =>
    d.prepare({
      ...SCOPE,
      planId: 'plan-1',
      attemptId: 'attempt-race',
      clientOrderId: 'client-race',
      dispatchToken: 'token-race',
    });

  it('refuses a seal that was already queued behind the release', async () => {
    const { path, release } = await queueAgainstRelease('release', sealRace);
    expect(release).toEqual({
      ok: true,
      plansInvalidated: 0,
      reservationsReleased: 0,
      attemptsVoided: 0,
    });
    expect(path).toEqual({ ok: false, reason: 'POOL_NOT_DISPATCHABLE', state: 'HALTED' });
    expect((await harness.admin.query('SELECT 1 FROM plans')).rowCount).toBe(0);
  });

  it('invalidates a seal that committed just before the release', async () => {
    const { path, release } = await queueAgainstRelease('path', sealRace);
    expect(path).toEqual({ ok: true });
    expect(release).toEqual({
      ok: true,
      plansInvalidated: 1,
      reservationsReleased: 0,
      attemptsVoided: 0,
    });
    const plans = await harness.admin.query<{ state: string }>('SELECT state FROM plans');
    expect(plans.rows.map((row) => row.state)).toEqual(['INVALIDATED']);
  });

  it('refuses a reservation that was already queued behind the release', async () => {
    const { path, release } = await queueAgainstRelease('release', reserveRace, async () => {
      await seal();
    });
    expect(release).toMatchObject({ ok: true, reservationsReleased: 0 });
    expect(path).toEqual({ ok: false, reason: 'POOL_NOT_DISPATCHABLE', state: 'HALTED' });
    expect((await harness.admin.query('SELECT 1 FROM reservations')).rowCount).toBe(0);
    expect(await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 })).toEqual([
      {
        owner: 'strategy-a',
        asset: USDT,
        availableAtoms: 20_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
    ]);
  });

  it('returns a reservation that committed just before the release', async () => {
    const { path, release } = await queueAgainstRelease('path', reserveRace, async () => {
      await seal();
    });
    expect(path).toMatchObject({ ok: true });
    expect(release).toEqual({
      ok: true,
      plansInvalidated: 1,
      reservationsReleased: 1,
      attemptsVoided: 0,
    });
    const reservations = await harness.admin.query<{ state: string }>(
      'SELECT state FROM reservations',
    );
    expect(reservations.rows.map((row) => row.state)).toEqual(['RELEASED']);
    // The capital is back where it started, not stranded behind withdrawn authority.
    expect(await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 })).toEqual([
      {
        owner: 'strategy-a',
        asset: USDT,
        availableAtoms: 20_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
    ]);
  });

  it('refuses a prepare that was already queued behind the release', async () => {
    const { path, release } = await queueAgainstRelease('release', prepareRace, async () => {
      await seal();
    });
    expect(release).toMatchObject({ ok: true, attemptsVoided: 0 });
    expect(path).toEqual({ ok: false, reason: 'POOL_NOT_DISPATCHABLE', state: 'HALTED' });
    expect((await harness.admin.query('SELECT 1 FROM dispatch_attempts')).rowCount).toBe(0);
  });

  it('voids a prepare that committed just before the release', async () => {
    const { path, release } = await queueAgainstRelease('path', prepareRace, async () => {
      await seal();
    });
    expect(path).toEqual({ ok: true });
    expect(release).toEqual({
      ok: true,
      plansInvalidated: 1,
      reservationsReleased: 0,
      attemptsVoided: 1,
    });
    // Prepared, then durably undispatchable: it can never become a marker.
    const attempts = await harness.admin.query<{ state: string; voided_at: Date | null }>(
      'SELECT state, voided_at FROM dispatch_attempts',
    );
    expect(attempts.rows[0]?.state).toBe('PREPARED');
    expect(attempts.rows[0]?.voided_at).not.toBeNull();
  });
});
