import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../migrator.js';
import { enterRestorePosture } from './restore.js';
import { DispatchRepository } from './dispatch.js';
import { LedgerRepository } from './ledger.js';
import { ObservationRepository } from './observations.js';
import { OutboxRepository } from './outbox.js';
import { serializable } from './transaction.js';
import {
  BTC,
  DATABASE_URL,
  JournalHarness,
  MIGRATIONS_DIR,
  POOL,
  USDT,
  WORKSPACE,
} from './test-harness.js';

/**
 * Restart, migration and restore preserve unresolved liabilities (T-035, T-051).
 *
 * The rehearsal data is the state a real deployment could be in when it is upgraded or
 * restored: a held reservation, an UNKNOWN dispatch, a partial fill, a quarantined claim, an
 * unpublished message. None of it may be cleared, completed or drained by anything here.
 */
const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;

describe('migrations never clear economic records', () => {
  it('contain no DELETE, TRUNCATE or DROP TABLE', () => {
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'))) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
        // Comments may mention the words; statements may not.
        .replace(/--[^\n]*/g, '');
      // The projection rebuild function is the one permitted DELETE: it deletes derived rows
      // and re-derives them in the same statement sequence from immutable entries.
      const withoutRebuild = sql.replace(
        /CREATE OR REPLACE FUNCTION rebuild_claim_balances[\s\S]*?\$\$ LANGUAGE plpgsql;/,
        '',
      );
      expect(withoutRebuild, file).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i);
    }
  });
});

describeIfDatabase('restart and restore posture', () => {
  const harness = new JournalHarness();

  beforeAll(async () => {
    await harness.open();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await harness.seedGovernanceLease();
    await rehearsalFixture();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  /** The state of a deployment mid-flight. */
  async function rehearsalFixture(): Promise<void> {
    const ledger = new LedgerRepository(harness.pool);
    const dispatch = new DispatchRepository(harness.pool);
    const observations = new ObservationRepository(harness.pool);
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
          deltaAtoms: 10_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 6_000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-b',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 3_000n,
        },
        {
          accountKind: 'HOUSE',
          owner: 'HOUSE',
          claimState: 'QUARANTINED',
          asset: USDT,
          deltaAtoms: 1_000n,
        },
      ],
    });
    // Plan A: marked and UNKNOWN, with a held reservation and a partial fill.
    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-unknown',
      payload: {},
      payloadDigest: 'd1',
      state: 'DISPATCH_PENDING',
    });
    await ledger.reserve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reservationId: 'res-unknown',
      strategyId: 'strategy-a',
      planId: 'plan-unknown',
      asset: USDT,
      atoms: 4_000n,
    });
    await dispatch.prepare({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-unknown',
      attemptId: 'attempt-unknown',
      clientOrderId: 'cd-unknown',
      dispatchToken: 'tok-unknown',
    });
    await dispatch.mark({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-unknown',
      outboxId: 'ob-send',
      signedRequest: {},
      host: { bootId: 'b', pid: 1, processStartedAt: new Date('2026-09-08T00:00:00Z') },
    });
    await dispatch.recordSendAttempted({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-unknown',
    });
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-unknown',
      to: 'UNKNOWN',
    });
    await dispatch.transitionPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-unknown',
      to: 'EXECUTING',
      expectedVersion: 1,
    });
    await observations.record({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      observationId: 'obs-partial',
      source: 'stream',
      kind: 'trade',
      sourceRef: 'trade-1',
      sourceEventTime: null,
      payload: { partial: true },
    });
    await observations.recordOrder({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: '1',
      clientOrderId: 'cd-unknown',
      status: 'PARTIALLY_FILLED',
    });
    await observations.recordFill({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: '1',
      venueTradeId: '1',
      observationId: 'obs-partial',
      baseAtoms: 5n,
      quoteAtoms: 500n,
      commission: { asset: BTC, atoms: 0n },
      tradedAt: new Date(),
    });
    // An unpublished non-dispatch message.
    await serializable(harness.pool, (client) =>
      OutboxRepository.enqueueOn(client, {
        workspaceId: WORKSPACE,
        poolId: POOL,
        outboxId: 'ob-event',
        kind: 'pool.state',
        payload: {},
      }),
    );
  }

  async function snapshot(client: Client): Promise<Record<string, unknown[]>> {
    const tables = [
      'pools',
      'reservations',
      'dispatch_attempts',
      'plans',
      'raw_observations',
      'venue_fills',
      'ledger_transactions',
      'ledger_entries',
      'outbox',
      'baseline_epochs',
    ];
    const out: Record<string, unknown[]> = {};
    for (const table of tables) {
      const rows = await client.query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`);
      out[table] = rows.rows;
    }
    return out;
  }

  it('preserves every unresolved liability across a re-run of the migrations and a fresh connection', async () => {
    const before = await snapshot(harness.admin);
    const result = await migrate(harness.admin, await loadMigrations(MIGRATIONS_DIR), {
      appliedBy: 'vitest',
      buildId: 'again',
    });
    expect(result.applied).toEqual([]);

    // A restart: a new backend reads the same facts.
    const restarted = await harness.connect();
    const after = await snapshot(restarted.client);
    expect(after).toEqual(before);

    // Nothing was marked complete, released or resolved by passing through.
    const attempt = await restarted.client.query<{ state: string }>(
      'SELECT state FROM dispatch_attempts',
    );
    expect(attempt.rows[0]?.state).toBe('UNKNOWN');
    const reservation = await restarted.client.query<{ state: string; reserved_atoms: string }>(
      'SELECT state, reserved_atoms FROM reservations',
    );
    expect(reservation.rows[0]).toEqual({ state: 'HELD', reserved_atoms: '4000' });
    const quarantined = await restarted.client.query<{ quarantined: string }>(
      `SELECT sum(delta_atoms)::text AS quarantined FROM ledger_entries WHERE claim_state = 'QUARANTINED'`,
    );
    expect(quarantined.rows[0]?.quarantined).toBe('1000');
  });

  it('starts a restored deployment halted, drains nothing, and keeps every liability', async () => {
    // A second, unmarked approved plan cannot coexist with the in-flight one (one in-flight
    // plan per pool), so the restore posture is exercised on the state that exists: a marked
    // UNKNOWN attempt, a held reservation and an unpublished message.
    const posture = await enterRestorePosture(harness.pool, {
      reason: 'restored from backup',
      now: new Date(),
    });
    // Two unpublished messages: the dispatch message the marker wrote, and the state event.
    expect(posture).toEqual({
      poolsHalted: 1,
      outboxQuarantined: 2,
      plansInvalidated: 0,
      reservationsReleased: 0,
      attemptsVoided: 0,
      liabilitiesRetained: 1,
    });

    const pool = await harness.admin.query<{ state: string }>('SELECT state FROM pools');
    expect(pool.rows[0]?.state).toBe('HALTED');
    // The old outbox is never drained: every unpublished message is quarantined, and none is
    // claimable.
    const quarantined = await harness.admin.query(
      `SELECT 1 FROM outbox WHERE quarantined_at IS NOT NULL`,
    );
    expect(quarantined.rowCount).toBe(2);
    const outbox = new OutboxRepository(harness.pool);
    expect(
      await outbox.claim({
        workspaceId: WORKSPACE,
        poolId: POOL,
        consumerId: 'w',
        leaseMs: 1000,
      }),
    ).toBeNull();
    // The UNKNOWN attempt and its reservation are exactly as they were.
    expect(
      (await harness.admin.query<{ state: string }>('SELECT state FROM dispatch_attempts')).rows[0]
        ?.state,
    ).toBe('UNKNOWN');
    expect(
      (await harness.admin.query<{ state: string }>('SELECT state FROM reservations')).rows[0]
        ?.state,
    ).toBe('HELD');
  });

  it('invalidates an unmarked approved plan on restore and releases only its reservation', async () => {
    // Resolve the in-flight plan first so an unmarked one can exist.
    const dispatch = new DispatchRepository(harness.pool);
    const ledger = new LedgerRepository(harness.pool);
    await dispatch.resolve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      attemptId: 'attempt-unknown',
      to: 'IRRECOVERABLE_UNCERTAINTY',
    });
    await dispatch.transitionPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-unknown',
      to: 'MANUAL_REVIEW',
      expectedVersion: 2,
    });
    await dispatch.transitionPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-unknown',
      to: 'UNFILLED',
      expectedVersion: 3,
    });

    await dispatch.sealPlan({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      planId: 'plan-approved',
      payload: {},
      payloadDigest: 'd2',
      state: 'APPROVED',
    });
    await ledger.reserve({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reservationId: 'res-approved',
      strategyId: 'strategy-b',
      planId: 'plan-approved',
      asset: USDT,
      atoms: 2_000n,
    });

    const posture = await enterRestorePosture(harness.pool, {
      reason: 'restored',
      now: new Date(),
    });
    expect(posture).toMatchObject({
      plansInvalidated: 1,
      reservationsReleased: 1,
      liabilitiesRetained: 1,
    });

    const plans = await harness.admin.query<{ plan_id: string; state: string }>(
      'SELECT plan_id, state FROM plans ORDER BY plan_id',
    );
    expect(plans.rows).toEqual([
      { plan_id: 'plan-approved', state: 'INVALIDATED' },
      { plan_id: 'plan-unknown', state: 'UNFILLED' },
    ]);
    const reservations = await harness.admin.query<{ reservation_id: string; state: string }>(
      'SELECT reservation_id, state FROM reservations ORDER BY reservation_id',
    );
    expect(reservations.rows).toEqual([
      { reservation_id: 'res-approved', state: 'RELEASED' },
      // The marked plan's reservation is a liability, not a release candidate.
      { reservation_id: 'res-unknown', state: 'HELD' },
    ]);
    const balances = await ledger.balances({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 });
    expect(balances).toContainEqual({
      owner: 'strategy-b',
      asset: USDT,
      availableAtoms: 3_000n,
      reservedAtoms: 0n,
      quarantinedAtoms: 0n,
    });
  });
});
