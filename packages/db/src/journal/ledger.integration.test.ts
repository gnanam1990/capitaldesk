import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerRepository, type AssetRef, type LedgerEntryInput } from './ledger.js';
import { DispatchRepository } from './dispatch.js';
import {
  BTC,
  DATABASE_URL,
  JournalHarness,
  POOL,
  USDT,
  WORKSPACE,
  sqlState,
} from './test-harness.js';

/**
 * The ledger: append-only, balanced per asset, and the only source of a balance.
 *
 * T-011 opening ownership is explicit; T-012 conservation through every transition; T-013
 * two workers reserving against the same claim on independent connections.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const control = (asset: AssetRef, atoms: bigint): LedgerEntryInput => ({
  accountKind: 'ASSET_CONTROL',
  owner: 'ASSET_CONTROL',
  claimState: 'CONTROL',
  asset,
  deltaAtoms: atoms,
});
const claim = (
  owner: string,
  state: 'AVAILABLE' | 'RESERVED' | 'QUARANTINED',
  asset: AssetRef,
  atoms: bigint,
): LedgerEntryInput => ({
  accountKind: owner === 'HOUSE' ? 'HOUSE' : 'STRATEGY',
  owner,
  claimState: state,
  asset,
  deltaAtoms: atoms,
});

describeIfDatabase('ledger and claims', () => {
  const harness = new JournalHarness();
  let ledger: LedgerRepository;
  let dispatch: DispatchRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    ledger = new LedgerRepository(harness.pool);
    dispatch = new DispatchRepository(harness.pool);
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  /** Control balance equals the sum of every claim, per asset, from the entries themselves. */
  async function assertConserved(): Promise<void> {
    const rows = await harness.admin.query<{
      asset_code: string;
      control: string;
      claims: string;
    }>(
      `SELECT asset_code,
              sum(delta_atoms) FILTER (WHERE account_kind = 'ASSET_CONTROL')::text AS control,
              sum(delta_atoms) FILTER (WHERE account_kind <> 'ASSET_CONTROL')::text AS claims
         FROM ledger_entries WHERE workspace_id = $1 AND pool_id = $2
        GROUP BY asset_code`,
      [WORKSPACE, POOL],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.control, `${row.asset_code} control vs claims`).toBe(row.claims);
    }
    // And the projection, rebuilt, says the same as an independent computation.
    await ledger.rebuildProjection({ workspaceId: WORKSPACE, poolId: POOL });
    const projected = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
    const computed = await ledger.balancesFromEntries({ workspaceId: WORKSPACE, poolId: POOL });
    expect(projected).toEqual(computed);
  }

  async function bootstrap(): Promise<void> {
    // T-011: the baseline says explicitly who owns what. Unknown BTC inventory goes to HOUSE
    // as quarantined, not to strategy-a because it happens to trade BTC.
    const posted = await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-bootstrap',
      source: { kind: 'bootstrap', ref: 'baseline-1' },
      description: 'opening baseline',
      entries: [
        control(BTC, 1000n),
        claim('strategy-a', 'AVAILABLE', BTC, 300n),
        claim('HOUSE', 'AVAILABLE', BTC, 500n),
        claim('HOUSE', 'QUARANTINED', BTC, 200n),
        control(USDT, 50_000n),
        claim('strategy-a', 'AVAILABLE', USDT, 20_000n),
        claim('strategy-b', 'AVAILABLE', USDT, 20_000n),
        claim('HOUSE', 'AVAILABLE', USDT, 10_000n),
      ],
    });
    expect(posted).toEqual({ ok: true, revision: 1 });
  }

  it('records an explicit opening baseline and conserves it', async () => {
    await bootstrap();
    await assertConserved();
    const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
    expect(balances).toContainEqual({
      owner: 'HOUSE',
      asset: BTC,
      availableAtoms: 500n,
      reservedAtoms: 0n,
      quarantinedAtoms: 200n,
    });
    expect(balances).toContainEqual({
      owner: 'strategy-a',
      asset: BTC,
      availableAtoms: 300n,
      reservedAtoms: 0n,
      quarantinedAtoms: 0n,
    });
  });

  it('refuses an unbalanced posting, in the repository and at commit', async () => {
    const posted = await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-bad',
      source: { kind: 'bootstrap', ref: 'bad' },
      description: 'plug',
      entries: [control(BTC, 100n), claim('HOUSE', 'AVAILABLE', BTC, 90n)],
    });
    expect(posted).toEqual({
      ok: false,
      reason: 'UNBALANCED',
      asset: 'BTC:v1',
      controlAtoms: 100n,
      claimAtoms: 90n,
    });
    expect((await harness.admin.query('SELECT 1 FROM ledger_transactions')).rowCount).toBe(0);

    // The database refuses it too, so a writer that bypasses the repository fails at COMMIT.
    const raw = await harness.connect();
    await raw.client.query('BEGIN');
    await raw.client.query(
      `INSERT INTO ledger_transactions (workspace_id,pool_id,epoch,ledger_txn_id,revision,source_kind,source_ref,description)
       VALUES ($1,$2,1,'txn-raw',1,'bootstrap','raw','x')`,
      [WORKSPACE, POOL],
    );
    await raw.client.query(
      `INSERT INTO ledger_entries VALUES ($1,$2,'txn-raw',1,'ASSET_CONTROL','ASSET_CONTROL','CONTROL','BTC','v1',100)`,
      [WORKSPACE, POOL],
    );
    let refusal = 'committed';
    try {
      await raw.client.query('COMMIT');
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('23000');
  });

  it('conserves every asset through reserve, quarantine, fill, commission and release', async () => {
    await bootstrap();
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: {},
      payloadDigest: 'd',
      state: 'SEALED_AWAITING_APPROVAL',
    });

    // Reserve quote for a BUY.
    const reserved = await ledger.reserve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reservationId: 'res-1',
      strategyId: 'strategy-a',
      planId: 'plan-1',
      asset: USDT,
      atoms: 15_000n,
    });
    expect(reserved).toMatchObject({ ok: true });
    await assertConserved();

    // The venue filled 100 BTC-atoms for 14_000 USDT-atoms and charged 10 USDT-atoms
    // commission. Control moves; the strategy's reserved quote is consumed; base arrives.
    const filled = await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-fill-1',
      source: { kind: 'fill', ref: 'trade-1' },
      description: 'fill',
      entries: [
        control(USDT, -14_010n),
        { ...claim('strategy-a', 'RESERVED', USDT, -14_010n), reservationId: 'res-1' },
        control(BTC, 100n),
        claim('strategy-a', 'AVAILABLE', BTC, 100n),
      ],
    });
    expect(filled).toMatchObject({ ok: true });
    await assertConserved();

    // Release the unspent remainder of the reservation: 15_000 - 14_010 = 990.
    const released = await ledger.release({
      workspaceId: WORKSPACE,
      poolId: POOL,
      reservationId: 'res-1',
      atoms: 990n,
      source: { kind: 'release', ref: 'res-1' },
    });
    expect(released).toMatchObject({ ok: true });
    await assertConserved();

    // Quarantine strategy-b's quote after unexplained drift.
    const quarantined = await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-quarantine',
      source: { kind: 'quarantine', ref: 'incident-1' },
      description: 'drift',
      entries: [
        claim('strategy-b', 'AVAILABLE', USDT, -20_000n),
        claim('strategy-b', 'QUARANTINED', USDT, 20_000n),
      ],
    });
    expect(quarantined).toMatchObject({ ok: true });
    await assertConserved();

    const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
    expect(balances).toContainEqual({
      owner: 'strategy-a',
      asset: USDT,
      availableAtoms: 5_990n,
      reservedAtoms: 0n,
      quarantinedAtoms: 0n,
    });
    expect(balances).toContainEqual({
      owner: 'strategy-a',
      asset: BTC,
      availableAtoms: 400n,
      reservedAtoms: 0n,
      quarantinedAtoms: 0n,
    });
    const revision = await harness.admin.query<{ ledger_revision: string }>(
      'SELECT ledger_revision FROM pools',
    );
    expect(revision.rows[0]?.ledger_revision).toBe('5');
  });

  it('never lets two workers reserve more than the strategy has, on independent connections', async () => {
    await bootstrap();
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-1',
      payload: {},
      payloadDigest: 'd',
      state: 'SEALED_AWAITING_APPROVAL',
    });

    // strategy-a has 20_000 USDT available. Two workers each try to reserve 15_000 having
    // both read the same opening availability. Under SERIALIZABLE one commits; the other
    // fails serialization, retries, sees 5_000 left and is refused.
    const [left, right, barrier] = await Promise.all([
      harness.connect(),
      harness.connect(),
      harness.connect(),
    ]);
    await barrier.client.query('BEGIN');
    await barrier.client.query(
      `SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE`,
      [WORKSPACE, POOL],
    );

    const reserveOn = (backend: typeof left, id: string) =>
      LedgerRepository.reserveOn(backend.client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        reservationId: id,
        strategyId: 'strategy-a',
        planId: 'plan-1',
        asset: USDT,
        atoms: 15_000n,
      });
    const both = Promise.all([reserveOn(left, 'res-left'), reserveOn(right, 'res-right')]);
    both.catch(() => undefined);
    try {
      await harness.waitUntilBlockedBy(barrier.pid, [left.pid, right.pid]);
    } finally {
      await barrier.client.query('ROLLBACK').catch(() => undefined);
    }
    const [a, b] = await both;
    const succeeded = [a, b].filter((outcome) => outcome.ok);
    const refused = [a, b].filter((outcome) => !outcome.ok);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      ok: false,
      reason: 'INSUFFICIENT_AVAILABLE',
      availableAtoms: 5_000n,
    });

    const reservations = await harness.admin.query(
      `SELECT 1 FROM reservations WHERE state = 'HELD'`,
    );
    expect(reservations.rowCount).toBe(1);
    await assertConserved();
    const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL });
    expect(balances).toContainEqual({
      owner: 'strategy-a',
      asset: USDT,
      availableAtoms: 5_000n,
      reservedAtoms: 15_000n,
      quarantinedAtoms: 0n,
    });
  });

  it('refuses to post the same source operation twice', async () => {
    await bootstrap();
    const again = await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-bootstrap-again',
      source: { kind: 'bootstrap', ref: 'baseline-1' },
      description: 'replayed',
      entries: [control(BTC, 1n), claim('HOUSE', 'AVAILABLE', BTC, 1n)],
    });
    expect(again).toEqual({
      ok: false,
      reason: 'SOURCE_ALREADY_POSTED',
      ledgerTxnId: 'txn-bootstrap',
    });
    expect((await harness.admin.query('SELECT 1 FROM ledger_transactions')).rowCount).toBe(1);
  });

  it('has no direct write path to balances, and a strategy keeps its records when archived', async () => {
    await bootstrap();
    // Read first, so the projection has rows: the refusal below must come from the trigger
    // firing on a real row, not from an UPDATE that matched nothing.
    expect(
      (await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL })).length,
    ).toBeGreaterThan(0);
    let refusal = 'accepted';
    try {
      await harness.admin.query(
        `UPDATE claim_balances SET available_atoms = available_atoms + 1 WHERE account_owner = 'strategy-a'`,
      );
    } catch (error) {
      refusal = sqlState(error);
    }
    expect(refusal).toBe('42501');

    await harness.admin.query(
      `UPDATE strategies SET archived_at = now() WHERE strategy_id = 'strategy-a'`,
    );
    await assertConserved();
    const entries = await harness.admin.query(
      `SELECT 1 FROM ledger_entries WHERE account_owner = 'strategy-a'`,
    );
    expect(entries.rowCount).toBe(2);
    // Entries and transactions are immutable evidence.
    for (const statement of [
      `DELETE FROM ledger_entries WHERE account_owner = 'strategy-a'`,
      `UPDATE ledger_entries SET delta_atoms = 0 WHERE account_owner = 'strategy-a'`,
      `DELETE FROM ledger_transactions`,
    ]) {
      let code = 'accepted';
      try {
        await harness.admin.query(statement);
      } catch (error) {
        code = sqlState(error);
      }
      expect(code, statement).toBe('23001');
    }
  });
});
