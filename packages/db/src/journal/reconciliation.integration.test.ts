import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { principal } from '@capitaldesk/domain';
import { LedgerRepository } from './ledger.js';
import { ObservationRepository } from './observations.js';
import { ReconciliationRepository } from './reconciliation.js';
import { RecoveryRepository } from './recovery.js';
import {
  ACCOUNT,
  BTC,
  DATABASE_URL,
  JournalHarness,
  POOL,
  USDT,
  WORKSPACE,
} from './test-harness.js';

const describeDb = DATABASE_URL === undefined ? describe.skip : describe;
const owner = principal({
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'owner-1',
  scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
});
const complete = {
  movementUniverseProven: true,
  streamOrGapCertificate: true,
  openOrdersComplete: true,
  tradeBackfillComplete: true,
  balanceBracketMatches: true,
  freshnessComplete: true,
  upstreamSupportsRecovery: true,
} as const;

describeDb('fill reconciliation and drift recovery (PostgreSQL)', () => {
  const harness = new JournalHarness();
  let ledger: LedgerRepository;
  let observations: ObservationRepository;
  let reconciliation: ReconciliationRepository;
  let recovery: RecoveryRepository;

  beforeAll(async () => harness.open());
  afterEach(async () => harness.cleanup());
  afterAll(async () => harness.close());
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    ledger = new LedgerRepository(harness.pool);
    observations = new ObservationRepository(harness.pool);
    reconciliation = new ReconciliationRepository(harness.pool);
    recovery = new RecoveryRepository(harness.pool);
  });

  async function seedPlan(attemptState: 'DISPATCH_MARKED' | 'SEND_ATTEMPTED' = 'SEND_ATTEMPTED') {
    await harness.admin.query(
      `INSERT INTO plans(workspace_id,pool_id,epoch,plan_id,state,payload,payload_digest)
       VALUES ($1,$2,1,'plan-1','RECONCILING','{}','digest')`,
      [WORKSPACE, POOL],
    );
    for (const [strategy, intent] of [
      ['strategy-a', 'intent-a'],
      ['strategy-b', 'intent-b'],
    ] as const) {
      await harness.admin.query(
        `INSERT INTO strategy_intents
          (workspace_id,pool_id,epoch,intent_id,strategy_id,symbol,base_asset_code,base_asset_scale,
           quote_asset_code,quote_asset_scale,target_base_atoms,max_buy_price,max_quote_debit_atoms,
           expires_at,strategy_revision,policy_version,idempotency_key,request_digest,state)
         VALUES ($1,$2,1,$3,$4,'BTCUSDT','BTC','v1','USDT','v1',3000000,'20000',500000000,
                 now()+interval '1 hour',1,1,$3,'sha256:${'0'.repeat(64)}','PLANNED')`,
        [WORKSPACE, POOL, intent, strategy],
      );
    }
    await harness.admin.query(
      `INSERT INTO dispatch_attempts
        (workspace_id,pool_id,epoch,attempt_id,plan_id,client_order_id,dispatch_token,state,
         signed_request,marked_at,send_attempted_at,marker_host_boot_id,marker_pid,marker_process_started_at)
       VALUES ($1,$2,1,'attempt-1','plan-1','client-1','token-1',$3,'{}',now(),
               CASE WHEN $3='SEND_ATTEMPTED' THEN now() ELSE NULL END,'boot',1,now())`,
      [WORKSPACE, POOL, attemptState],
    );
  }

  async function openingAndReservations() {
    expect(
      await ledger.postTransaction({
        workspaceId: WORKSPACE,
        poolId: POOL,
        epoch: 1,
        ledgerTxnId: 'opening',
        source: { kind: 'fixture', ref: 'opening' },
        description: 'opening',
        entries: [
          {
            accountKind: 'ASSET_CONTROL',
            owner: 'ASSET_CONTROL',
            claimState: 'CONTROL',
            asset: USDT,
            deltaAtoms: 1_000_000_000n,
          },
          {
            accountKind: 'STRATEGY',
            owner: 'strategy-a',
            claimState: 'AVAILABLE',
            asset: USDT,
            deltaAtoms: 500_000_000n,
          },
          {
            accountKind: 'STRATEGY',
            owner: 'strategy-b',
            claimState: 'AVAILABLE',
            asset: USDT,
            deltaAtoms: 500_000_000n,
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    for (const [reservationId, strategyId, atoms] of [
      ['reserve-a', 'strategy-a', 200_200_000n],
      ['reserve-b', 'strategy-b', 400_400_000n],
    ] as const) {
      expect(
        await ledger.reserve({
          workspaceId: WORKSPACE,
          poolId: POOL,
          epoch: 1,
          reservationId,
          strategyId,
          planId: 'plan-1',
          asset: USDT,
          atoms,
        }),
      ).toMatchObject({ ok: true });
    }
  }

  async function expiredPartialFill() {
    await observations.record({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      observationId: 'fill-observation-1',
      source: 'rest',
      kind: 'trade',
      sourceRef: 'BTCUSDT/order-1/trade-1',
      sourceEventTime: new Date('2026-09-08T12:00:00Z'),
      payload: { redacted: true },
    });
    await observations.recordOrder({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: 'order-1',
      clientOrderId: 'client-1',
      status: 'EXPIRED',
    });
    await observations.recordFill({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      symbol: 'BTCUSDT',
      venueOrderId: 'order-1',
      venueTradeId: 'trade-1',
      exchangeSequence: 1n,
      observationId: 'fill-observation-1',
      baseAtoms: 2_000_000n,
      quoteAtoms: 398_000_000n,
      commission: { asset: USDT, atoms: 398_000n },
      tradedAt: new Date('2026-09-08T12:00:00Z'),
    });
  }

  it('atomically applies the golden fill, fee, FIFO attribution and proven remainder release', async () => {
    await seedPlan();
    await openingAndReservations();
    await expiredPartialFill();
    await reconciliation.start({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reconciliationId: 'recon-1',
      attemptId: 'attempt-1',
      symbol: 'BTCUSDT',
      venueOrderId: 'order-1',
      observedStableAccountId: ACCOUNT.stableAccountId,
      coverageProof: complete,
      cursorEvidence: { pages: 1 },
      observedBaseAtoms: 2_000_000n,
      observedQuoteAtoms: 398_000_000n,
    });
    const outcome = await reconciliation.finalize({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reconciliationId: 'recon-1',
      attemptId: 'attempt-1',
      planId: 'plan-1',
      symbol: 'BTCUSDT',
      venueOrderId: 'order-1',
      side: 'BUY',
      baseAsset: { code: BTC.code, scaleVersion: BTC.scale },
      quoteAsset: { code: USDT.code, scaleVersion: USDT.scale },
      fifo: [
        {
          strategyId: 'strategy-a',
          intentId: 'intent-a',
          requestedGrossBaseAtoms: 1_000_000n,
          maxQuoteDebitAtoms: 200_200_000n,
          maxBaseDebitAtoms: 1_000_000n,
          maxBaseCommissionAtoms: 0n,
          maxQuoteCommissionAtoms: 200_000n,
        },
        {
          strategyId: 'strategy-b',
          intentId: 'intent-b',
          requestedGrossBaseAtoms: 2_000_000n,
          maxQuoteDebitAtoms: 400_400_000n,
          maxBaseDebitAtoms: 2_000_000n,
          maxBaseCommissionAtoms: 0n,
          maxQuoteCommissionAtoms: 400_000n,
        },
      ],
      reservations: [
        {
          strategyId: 'strategy-a',
          asset: { code: USDT.code, scaleVersion: USDT.scale },
          reservationId: 'reserve-a',
        },
        {
          strategyId: 'strategy-b',
          asset: { code: USDT.code, scaleVersion: USDT.scale },
          reservationId: 'reserve-b',
        },
      ],
    });
    expect(outcome).toMatchObject({ ok: true, planState: 'PARTIAL', allocations: 2 });
    expect(
      await ledger.balancesFromEntries({ workspaceId: WORKSPACE, poolId: POOL, epoch: 1 }),
    ).toEqual([
      {
        owner: 'strategy-a',
        asset: BTC,
        availableAtoms: 1_000_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
      {
        owner: 'strategy-a',
        asset: USDT,
        availableAtoms: 300_801_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
      {
        owner: 'strategy-b',
        asset: BTC,
        availableAtoms: 1_000_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
      {
        owner: 'strategy-b',
        asset: USDT,
        availableAtoms: 300_801_000n,
        reservedAtoms: 0n,
        quarantinedAtoms: 0n,
      },
    ]);
    const rows = await harness.admin.query<{ n: string }>(
      'SELECT count(*)::text n FROM fill_allocations',
    );
    expect(rows.rows[0]?.n).toBe('2');
  });

  it('holds every reservation when one coverage condition is missing', async () => {
    await seedPlan();
    await openingAndReservations();
    await expiredPartialFill();
    await reconciliation.start({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reconciliationId: 'recon-missing-page',
      attemptId: 'attempt-1',
      symbol: 'BTCUSDT',
      venueOrderId: 'order-1',
      observedStableAccountId: ACCOUNT.stableAccountId,
      coverageProof: { ...complete, tradeBackfillComplete: false },
      cursorEvidence: {},
      observedBaseAtoms: 2_000_000n,
      observedQuoteAtoms: 398_000_000n,
    });
    const outcome = await reconciliation.finalize({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reconciliationId: 'recon-missing-page',
      attemptId: 'attempt-1',
      planId: 'plan-1',
      symbol: 'BTCUSDT',
      venueOrderId: 'order-1',
      side: 'BUY',
      baseAsset: { code: 'BTC', scaleVersion: 'v1' },
      quoteAsset: { code: 'USDT', scaleVersion: 'v1' },
      fifo: [
        {
          strategyId: 'strategy-a',
          intentId: 'intent-a',
          requestedGrossBaseAtoms: 1_000_000n,
          maxQuoteDebitAtoms: 200_200_000n,
          maxBaseDebitAtoms: 1_000_000n,
          maxBaseCommissionAtoms: 0n,
          maxQuoteCommissionAtoms: 200_000n,
        },
      ],
      reservations: [],
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'NOT_FINANCIALLY_FINAL' });
    expect(
      await ledger.remainingOf({
        workspaceId: WORKSPACE,
        poolId: POOL,
        reservationId: 'reserve-a',
      }),
    ).toBe(200_200_000n);
  });

  it('allows decisive NOT_SENT_PROVEN only for a fenced never-sent marker with COMPLETE evidence', async () => {
    await seedPlan('DISPATCH_MARKED');
    await reconciliation.start({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reconciliationId: 'non-send-run',
      attemptId: 'attempt-1',
      symbol: 'BTCUSDT',
      venueOrderId: 'absent-order',
      observedStableAccountId: ACCOUNT.stableAccountId,
      coverageProof: complete,
      cursorEvidence: { window: 'complete' },
      observedBaseAtoms: 0n,
      observedQuoteAtoms: 0n,
    });
    expect(
      await reconciliation.proveNotSent({
        workspaceId: WORKSPACE,
        poolId: POOL,
        attemptId: 'attempt-1',
        reconciliationId: 'non-send-run',
        evidenceId: 'non-send-1',
        senderFenced: true,
        windowStart: new Date('2026-09-08T11:59:00Z'),
        windowEnd: new Date('2026-09-08T12:01:00Z'),
      }),
    ).toEqual({ ok: true });
    const state = await harness.admin.query<{ state: string }>(
      "SELECT state FROM dispatch_attempts WHERE attempt_id='attempt-1'",
    );
    expect(state.rows[0]?.state).toBe('NOT_SENT_PROVEN');
  });

  it('separates acknowledgement from resolution and refuses resume with active drift', async () => {
    const result = await recovery.assess({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      reconciliationId: 'drift-1',
      expectedAccountId: ACCOUNT.stableAccountId,
      observedAccountId: ACCOUNT.stableAccountId,
      coverage: 'COMPLETE',
      expectedBalances: { 'BTC:v1': 10n },
      observedBalances: { 'BTC:v1': 9n },
      externalActivityObserved: true,
      unknownOpenOrderObserved: false,
      scaleChanged: false,
      resetPositivelyDetected: false,
    });
    expect(result.quarantined).toBe(true);
    expect(
      await recovery.acknowledge({
        workspaceId: WORKSPACE,
        poolId: POOL,
        incidentId: result.incidentIds[0]!,
        actor: owner,
      }),
    ).toEqual({ ok: true });
    expect(await recovery.resume({ workspaceId: WORKSPACE, poolId: POOL, actor: owner })).toEqual({
      ok: false,
      reason: 'RECOVERY_GATE_UNMET',
    });
    const pool = await harness.admin.query<{ state: string }>(
      'SELECT state FROM pools WHERE workspace_id=$1 AND pool_id=$2',
      [WORKSPACE, POOL],
    );
    expect(pool.rows[0]?.state).toBe('QUARANTINED');
  });
});
