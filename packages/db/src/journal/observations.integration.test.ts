import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObservationRepository } from './observations.js';
import { LedgerRepository } from './ledger.js';
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
 * Raw observations are evidence; applying them is a separate act (T-030, T-031, T-033).
 *
 * A crash between persisting what the venue said and posting its effect must leave a
 * replayable fact. Reapplying it must post exactly once. And an identifier the venue reused
 * in another scope must be a different fact, never a collision.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describeIfDatabase('raw observations and venue identity', () => {
  const harness = new JournalHarness();
  let observations: ObservationRepository;
  let ledger: LedgerRepository;

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    observations = new ObservationRepository(harness.pool);
    ledger = new LedgerRepository(harness.pool);
    await ledger.postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'txn-bootstrap',
      source: { kind: 'bootstrap', ref: 'b' },
      description: 'baseline',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 1_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 1_000n,
        },
      ],
    });
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  const fillObservation = {
    workspaceId: WORKSPACE,
    poolId: POOL,
    epoch: 1,
    observationId: 'obs-1',
    source: 'rest' as const,
    kind: 'trade',
    sourceRef: 'trade-77',
    sourceEventTime: new Date('2026-09-08T00:00:00Z'),
    payload: { tradeId: 77, qty: '10', quoteQty: '100', commission: '1' },
  };
  const fillLedger = {
    ledgerTxnId: 'txn-fill-77',
    source: { kind: 'fill', ref: 'trade-77' },
    description: 'fill 77',
    entries: [
      {
        accountKind: 'ASSET_CONTROL' as const,
        owner: 'ASSET_CONTROL',
        claimState: 'CONTROL' as const,
        asset: USDT,
        deltaAtoms: -101n,
      },
      {
        accountKind: 'STRATEGY' as const,
        owner: 'strategy-a',
        claimState: 'AVAILABLE' as const,
        asset: USDT,
        deltaAtoms: -101n,
      },
      {
        accountKind: 'ASSET_CONTROL' as const,
        owner: 'ASSET_CONTROL',
        claimState: 'CONTROL' as const,
        asset: BTC,
        deltaAtoms: 10n,
      },
      {
        accountKind: 'STRATEGY' as const,
        owner: 'strategy-a',
        claimState: 'AVAILABLE' as const,
        asset: BTC,
        deltaAtoms: 10n,
      },
    ],
  };

  it('applies an observation exactly once, even across a crash between record and apply', async () => {
    expect(await observations.record(fillObservation)).toEqual({ kind: 'recorded' });

    // Crash after the ledger posting, before the observation is marked applied: the whole
    // application rolls back and the observation remains an unapplied fact.
    await expect(
      observations.apply(
        { workspaceId: WORKSPACE, poolId: POOL, observationId: 'obs-1', ledger: fillLedger },
        { afterLedgerPost: () => Promise.reject(new Error('injected crash')) },
      ),
    ).rejects.toThrow('injected crash');
    const unapplied = await harness.admin.query<{ applied_ledger_txn_id: string | null }>(
      'SELECT applied_ledger_txn_id FROM raw_observations',
    );
    expect(unapplied.rows[0]?.applied_ledger_txn_id).toBeNull();
    expect(
      (await harness.admin.query(`SELECT 1 FROM ledger_transactions WHERE source_kind='fill'`))
        .rowCount,
    ).toBe(0);

    // Restart: apply again. Once.
    expect(
      await observations.apply({
        workspaceId: WORKSPACE,
        poolId: POOL,
        observationId: 'obs-1',
        ledger: fillLedger,
      }),
    ).toEqual({ kind: 'applied', revision: 2 });
    // And again: already applied, nothing posted twice.
    expect(
      await observations.apply({
        workspaceId: WORKSPACE,
        poolId: POOL,
        observationId: 'obs-1',
        ledger: fillLedger,
      }),
    ).toEqual({ kind: 'already-applied', ledgerTxnId: 'txn-fill-77' });
    expect(
      (await harness.admin.query(`SELECT 1 FROM ledger_transactions WHERE source_kind='fill'`))
        .rowCount,
    ).toBe(1);
  });

  it('deduplicates an exact repeat and keeps the first verbatim', async () => {
    expect(await observations.record(fillObservation)).toEqual({ kind: 'recorded' });
    // A duplicate boundary row from the next page, or the same trade over the stream.
    expect(await observations.record({ ...fillObservation, observationId: 'obs-1-dup' })).toEqual({
      kind: 'duplicate',
      observationId: 'obs-1',
    });
    const stored = await harness.admin.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM raw_observations',
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]?.payload).toEqual(fillObservation.payload);

    // The same trade id from a different source is a different observation of one fact, kept
    // for corroboration; deduplication is per source.
    expect(
      await observations.record({ ...fillObservation, observationId: 'obs-2', source: 'stream' }),
    ).toEqual({
      kind: 'recorded',
    });
  });

  it('is immutable evidence', async () => {
    await observations.record(fillObservation);
    for (const statement of [
      `UPDATE raw_observations SET payload = '{}'::jsonb`,
      `UPDATE raw_observations SET source_ref = 'trade-78'`,
      `DELETE FROM raw_observations`,
    ]) {
      let refusal = 'accepted';
      try {
        await harness.admin.query(statement);
      } catch (error) {
        refusal = sqlState(error);
      }
      expect(refusal, statement).toBe('23001');
    }
  });

  it('scopes order and fill identity by pool, epoch and symbol', async () => {
    await observations.record(fillObservation);
    const order = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: '5001',
      status: 'FILLED' as const,
    };
    expect(await observations.recordOrder(order)).toEqual({ kind: 'recorded' });
    // The same venue order id on another symbol is a different order.
    expect(await observations.recordOrder({ ...order, symbol: 'ETHUSDT' })).toEqual({
      kind: 'recorded',
    });
    // And in another epoch of the same pool.
    await harness.admin.query(
      `UPDATE baseline_epochs SET closed_at = now(), closed_reason = 'reset'`,
    );
    await harness.admin.query(
      `INSERT INTO baseline_epochs (workspace_id, pool_id, epoch) VALUES ($1,$2,2)`,
      [WORKSPACE, POOL],
    );
    expect(await observations.recordOrder({ ...order, epoch: 2 })).toEqual({ kind: 'recorded' });
    // But within its own scope it is the same order, and a second terminal status is a
    // contradiction, not a new row.
    expect(await observations.recordOrder({ ...order, status: 'CANCELED' })).toMatchObject({
      kind: 'conflict',
      current: 'FILLED',
      incoming: 'CANCELED',
    });

    const fill = {
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: '5001',
      venueTradeId: '77',
      observationId: 'obs-1',
      baseAtoms: 10n,
      quoteAtoms: 100n,
      commission: { asset: USDT, atoms: 1n },
      tradedAt: new Date('2026-09-08T00:00:00Z'),
    };
    expect(await observations.recordFill(fill)).toEqual({ kind: 'recorded' });
    expect(await observations.recordFill(fill)).toEqual({ kind: 'already-recorded' });
    // Trade id 77 on the ETHUSDT order is unrelated, and can never cross-link.
    expect(await observations.recordFill({ ...fill, symbol: 'ETHUSDT' })).toEqual({
      kind: 'recorded',
    });
    // A fill for an order this pool never observed is refused outright: no orphan attribution.
    expect(await observations.recordFill({ ...fill, venueOrderId: '9999' })).toEqual({
      kind: 'unknown-order',
    });

    const fills = await harness.admin.query<{ symbol: string; venue_trade_id: string }>(
      'SELECT symbol, venue_trade_id FROM venue_fills ORDER BY symbol',
    );
    expect(fills.rows).toEqual([
      { symbol: 'BTCUSDT', venue_trade_id: '77' },
      { symbol: 'ETHUSDT', venue_trade_id: '77' },
    ]);
  });

  it('accepts a late fill after the order is terminal', async () => {
    // T-033: cancellation or IOC expiry never means zero execution by assumption. Late fill
    // evidence stays ingestible; it is the reconciler's job to consume it, not the journal's
    // to refuse it.
    await observations.record(fillObservation);
    await observations.recordOrder({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: '5001',
      status: 'EXPIRED',
    });
    expect(
      await observations.recordFill({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        symbol: 'BTCUSDT',
        venueOrderId: '5001',
        venueTradeId: '78',
        observationId: 'obs-1',
        baseAtoms: 3n,
        quoteAtoms: 30n,
        commission: { asset: USDT, atoms: 1n },
        tradedAt: new Date('2026-09-08T00:00:01Z'),
      }),
    ).toEqual({ kind: 'recorded' });
  });
});
