import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  amount,
  assetKey,
  poolId,
  priceFromDecimal,
  venueAccountKey,
  type FeeBoundEvidence,
  type SealedPlanPayload,
} from '@capitaldesk/contracts';
import { principal, type MandatePolicyWire } from '@capitaldesk/domain';
import { ApprovalRepository } from './approvals.js';
import { IntentRepository } from './intents.js';
import { LedgerRepository } from './ledger.js';
import { PolicyRepository } from './policy.js';
import { SealingRepository } from './sealing.js';
import { ACCOUNT, DATABASE_URL, JournalHarness, POOL, USDT, WORKSPACE } from './test-harness.js';

const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER = principal({
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'owner-approval',
  scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
});
const AGENT = principal({
  kind: 'agent-credential',
  role: 'agent',
  subjectId: 'agent-a',
  scope: { workspaceId: WORKSPACE, poolId: POOL, strategyId: 'strategy-a' },
});
const BTC_KEY = assetKey('BTC', 'v1');
const USDT_KEY = assetKey('USDT', 'v1');
const FEE_EVIDENCE: FeeBoundEvidence = {
  policyVersion: 'QUOTE_FEE_FIXTURE_V1',
  derivedAt: '2026-09-08T00:00:00.000Z',
  maxFillCount: 1,
  minFillBaseAtoms: 1n,
  derivationDigest: `sha256:${'0'.repeat(64)}`,
};
const BEFORE_EXPIRY = new Date('2029-12-31T23:59:00.000Z');

function policy(): MandatePolicyWire {
  return {
    policyVersion: '1',
    selectedSymbol: 'BTCUSDT',
    baseAsset: 'BTC@v1',
    quoteAsset: 'USDT@v1',
    maxPoolPlanQuoteDebitAtoms: '1000',
    maxDailyGrossBuyQuoteAtoms: '1000',
    poolConcentrationNumerator: '1',
    poolConcentrationDenominator: '1',
    freshnessMaxAgeMs: {
      PRICE_SNAPSHOT: '5000',
      ACCOUNT_SNAPSHOT: '5000',
      SYMBOL_METADATA: '5000',
      VENUE_CLOCK: '5000',
    },
    planLifetimeMs: '60000',
    buyInhibitUntil: null,
    riskIncreaseHalted: false,
    feePolicyVersion: 'QUOTE_FEE_FIXTURE_V1',
    strategyLimits: [
      {
        strategyId: 'strategy-a',
        maxTargetBaseAtoms: '1000',
        maxPlanQuoteDebitAtoms: '1000',
        maxDailyGrossBuyQuoteAtoms: '1000',
      },
      {
        strategyId: 'strategy-b',
        maxTargetBaseAtoms: '1000',
        maxPlanQuoteDebitAtoms: '1000',
        maxDailyGrossBuyQuoteAtoms: '1000',
      },
    ],
  };
}

function payload(): SealedPlanPayload {
  return {
    pool: poolId(
      WORKSPACE,
      venueAccountKey(ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId),
      1,
    ),
    childClientOrderId: 'child-approval',
    symbol: 'BTCUSDT',
    side: 'BUY',
    orderType: 'LIMIT',
    timeInForce: 'IOC',
    grossBaseQuantity: amount(BTC_KEY, 60n),
    limitPrice: priceFromDecimal(BTC_KEY, USDT_KEY, '10'),
    allocation: [
      {
        position: 0,
        strategyId: 'strategy-a',
        intentId: 'intent-approval',
        intentRevision: 1,
        requestedGrossBase: amount(BTC_KEY, 60n),
      },
    ],
    strategyCaps: [
      { strategyId: 'strategy-a', maxDebit: amount(USDT_KEY, 600n), maxCommission: [] },
    ],
    allocationAlgorithmVersion: 'FIFO_V1',
    feePolicyVersion: 'QUOTE_FEE_FIXTURE_V1',
    mandatePolicyVersion: '1',
    baselineLedgerRevision: 1,
    cohortClosedAtSequence: 1,
    approvalExpiresAt: '2030-01-01T00:01:00.000Z',
    submissionDeadlineAt: '2030-01-01T00:00:55.000Z',
    signedRequestValidityMs: 5000,
    clockSkewBudgetMs: 500,
    authorizationDurability: 'AT_RISK_SINGLE_NODE',
  };
}

describeIfDatabase('exact owner approval', () => {
  const harness = new JournalHarness();
  let repository: ApprovalRepository;
  let digest: string;

  beforeAll(() => harness.open());
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await new PolicyRepository(harness.pool).publish({
      workspaceId: WORKSPACE,
      poolId: POOL,
      expectedPoolVersion: 1,
      idempotencyKey: 'policy-approval',
      draft: policy(),
      actor: OWNER,
    });
    await new IntentRepository(harness.pool).propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'intent-approval',
      proposal: {
        intentId: 'intent-approval',
        symbol: 'BTCUSDT',
        targetBaseQtyAtoms: '100',
        maxBuyPrice: '10',
        minSellPrice: null,
        maxQuoteDebitAtoms: '1000',
        expiresAt: '2030-01-01T00:00:00.000Z',
        strategyRevision: '1',
        policyVersion: '1',
      },
      actor: AGENT,
      now: new Date('2029-01-01T00:00:00.000Z'),
    });
    await new LedgerRepository(harness.pool).postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'fund-approval',
      source: { kind: 'fixture', ref: 'fund-approval' },
      description: 'fund approval fixture',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 1000n,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 1000n,
        },
      ],
    });
    const sealed = await new SealingRepository(harness.pool).seal({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-approval',
      payload: payload(),
      expectedLedgerRevision: 1,
      expectedPolicyVersion: '1',
      reservations: [
        {
          reservationId: 'reserve-approval',
          strategyId: 'strategy-a',
          asset: USDT_KEY,
          atoms: 600n,
        },
      ],
      venueCapacity: {
        evidenceId: 'capacity-approval',
        complete: true,
        free: [{ asset: USDT_KEY, atoms: 1000n }],
      },
      feeBoundEvidence: FEE_EVIDENCE,
      verifiedAccountSettings: ['environment=local'],
      actor: OWNER,
    });
    if (!sealed.ok) throw new Error(`fixture seal failed: ${sealed.reason}`);
    digest = sealed.digest;
    repository = new ApprovalRepository(harness.pool);
  });
  afterEach(() => harness.cleanup());

  function approve(
    executionMode: 'BROKER_KEY' | 'APPROVED_HOST' = 'BROKER_KEY',
    idempotencyKey = 'approve-1',
  ) {
    return repository.decide({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-approval',
      planDigest: digest,
      decision: 'APPROVED',
      executionMode,
      idempotencyKey,
      actor: OWNER,
      now: BEFORE_EXPIRY,
    });
  }

  it('persists the exact FIFO, intent revisions, caps and deadlines as immutable evidence', async () => {
    expect(await approve()).toMatchObject({ ok: true, replayed: false });
    const view = await repository.view({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-approval',
      actor: OWNER,
    });
    expect(view).toMatchObject({
      planDigest: digest,
      decision: 'APPROVED',
      allocationAlgorithmVersion: 'FIFO_V1',
      feePolicyVersion: 'QUOTE_FEE_FIXTURE_V1',
      revoked: false,
    });
    expect(view?.allocation).toEqual([
      expect.objectContaining({
        position: '0',
        strategyId: 'strategy-a',
        intentId: 'intent-approval',
      }),
    ]);
    await expect(
      harness.admin.query(`UPDATE plan_approval_decisions SET plan_digest=$1`, [
        `sha256:${'f'.repeat(64)}`,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects a changed digest and conflicting idempotency body', async () => {
    expect(
      await repository.decide({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        planDigest: `sha256:${'f'.repeat(64)}`,
        decision: 'APPROVED',
        executionMode: 'BROKER_KEY',
        idempotencyKey: 'changed-digest',
        actor: OWNER,
        now: BEFORE_EXPIRY,
      }),
    ).toEqual({ ok: false, reason: 'APPROVAL_DIGEST_MISMATCH' });
    expect(await approve()).toMatchObject({ ok: true, replayed: false });
    expect(await approve()).toMatchObject({ ok: true, replayed: true });
    expect(await approve('APPROVED_HOST')).toEqual({
      ok: false,
      reason: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('never grants approval authority to a proposal agent', async () => {
    expect(() =>
      repository.decide({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        planDigest: digest,
        decision: 'APPROVED',
        executionMode: 'BROKER_KEY',
        idempotencyKey: 'agent-forgery',
        actor: AGENT,
        now: BEFORE_EXPIRY,
      }),
    ).toThrow(/AUTHZ_SCOPE_DENIED/);
    expect((await harness.admin.query(`SELECT 1 FROM plan_approval_decisions`)).rowCount).toBe(0);
  });

  it('expires at the exact boundary and atomically returns held capital', async () => {
    const result = await repository.decide({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-approval',
      planDigest: digest,
      decision: 'APPROVED',
      executionMode: 'BROKER_KEY',
      idempotencyKey: 'approve-expired',
      actor: OWNER,
      now: new Date('2030-01-01T00:00:55.000Z'),
    });
    expect(result).toEqual({ ok: false, reason: 'APPROVAL_EXPIRED' });
    expect(
      (
        await harness.admin.query<{ state: string }>(
          `SELECT state FROM plans WHERE plan_id='plan-approval'`,
        )
      ).rows[0]?.state,
    ).toBe('EXPIRED');
    expect(
      (
        await harness.admin.query<{ state: string }>(
          `SELECT state FROM reservations WHERE reservation_id='reserve-approval'`,
        )
      ).rows[0]?.state,
    ).toBe('RELEASED');
  });

  it('requires an independent exact native confirmation in approved-host mode', async () => {
    expect(await approve('APPROVED_HOST')).toMatchObject({ ok: true });
    expect(
      await repository.eligibility({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        digest,
        executionMode: 'APPROVED_HOST',
        now: BEFORE_EXPIRY,
      }),
    ).toEqual({ ok: false, reason: 'DISPATCH_NATIVE_CONFIRMATION_MISSING' });
    expect(
      await repository.recordNativeConfirmation({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        planDigest: digest,
        confirmationRef: 'native-confirmation-1',
        confirmedPayloadDigest: digest,
        confirmedAt: BEFORE_EXPIRY,
      }),
    ).toMatchObject({ ok: true, replayed: false });
    expect(
      await repository.eligibility({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        digest,
        executionMode: 'APPROVED_HOST',
        now: BEFORE_EXPIRY,
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses dispatch at expiry and stores the last-moment reason', async () => {
    await approve();
    expect(
      await repository.eligibility({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        digest,
        executionMode: 'BROKER_KEY',
        now: new Date('2030-01-01T00:01:00.000Z'),
      }),
    ).toEqual({ ok: false, reason: 'APPROVAL_EXPIRED' });
    expect(
      (
        await harness.admin.query<{ reason: string }>(
          `SELECT reason FROM plan_dispatch_eligibility_checks ORDER BY check_id DESC LIMIT 1`,
        )
      ).rows[0]?.reason,
    ).toBe('APPROVAL_EXPIRED');
  });

  it('invalidates eligibility on ledger, policy or strategy authority change', async () => {
    await approve();
    await harness.admin.query(
      `INSERT INTO policy_versions
        (workspace_id,pool_id,policy_version,payload,payload_digest,selected_symbol,
         base_asset_code,base_asset_scale,quote_asset_code,quote_asset_scale,
         max_pool_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms,
         concentration_numerator,concentration_denominator,price_snapshot_max_age_ms,
         account_snapshot_max_age_ms,symbol_metadata_max_age_ms,venue_clock_max_age_ms,
         plan_lifetime_ms,buy_inhibit_until,risk_increase_halted,fee_policy_version,
         published_by_subject_id,idempotency_key)
       SELECT workspace_id,pool_id,2,payload,'sha256:${'2'.repeat(64)}',selected_symbol,
              base_asset_code,base_asset_scale,quote_asset_code,quote_asset_scale,
              max_pool_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms,
              concentration_numerator,concentration_denominator,price_snapshot_max_age_ms,
              account_snapshot_max_age_ms,symbol_metadata_max_age_ms,venue_clock_max_age_ms,
              plan_lifetime_ms,buy_inhibit_until,risk_increase_halted,fee_policy_version,
              published_by_subject_id,'policy-version-2'
         FROM policy_versions WHERE workspace_id=$1 AND pool_id=$2 AND policy_version=1`,
      [WORKSPACE, POOL],
    );
    await harness.admin.query(
      `INSERT INTO strategy_policy_limits
        (workspace_id,pool_id,policy_version,strategy_id,max_target_base_atoms,
         max_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms)
       SELECT workspace_id,pool_id,2,strategy_id,max_target_base_atoms,
              max_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms
         FROM strategy_policy_limits WHERE workspace_id=$1 AND pool_id=$2 AND policy_version=1`,
      [WORKSPACE, POOL],
    );
    await harness.admin.query(`UPDATE pools SET active_policy_version=2`);
    expect(
      await repository.eligibility({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        digest,
        executionMode: 'BROKER_KEY',
        now: BEFORE_EXPIRY,
      }),
    ).toEqual({ ok: false, reason: 'POLICY_MANDATE_VERSION_STALE' });
    await harness.admin.query(`UPDATE pools SET active_policy_version=1`);
    await harness.admin.query(
      `UPDATE strategies SET archived_at=$1 WHERE strategy_id='strategy-a'`,
      [BEFORE_EXPIRY],
    );
    expect(
      await repository.eligibility({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        digest,
        executionMode: 'BROKER_KEY',
        now: BEFORE_EXPIRY,
      }),
    ).toEqual({ ok: false, reason: 'STRATEGY_AUTHORITY_REVOKED' });
    await harness.admin.query(
      `UPDATE strategies SET archived_at=NULL WHERE strategy_id='strategy-a'`,
    );
    await new LedgerRepository(harness.pool).postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'external-change',
      source: { kind: 'fixture', ref: 'external-change' },
      description: 'external inventory change',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: 1n,
        },
        {
          accountKind: 'HOUSE',
          owner: 'HOUSE',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: 1n,
        },
      ],
    });
    expect(
      await repository.eligibility({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        digest,
        executionMode: 'BROKER_KEY',
        now: BEFORE_EXPIRY,
      }),
    ).toEqual({ ok: false, reason: 'LEDGER_REVISION_STALE' });
  });

  it('declines idempotently and releases reservation and daily budget hold', async () => {
    const decline = () =>
      repository.decide({
        workspaceId: WORKSPACE,
        poolId: POOL,
        planId: 'plan-approval',
        planDigest: digest,
        decision: 'DECLINED',
        executionMode: 'BROKER_KEY',
        idempotencyKey: 'decline-1',
        actor: OWNER,
        now: BEFORE_EXPIRY,
      });
    expect(await decline()).toMatchObject({ ok: true, replayed: false });
    expect(await decline()).toMatchObject({ ok: true, replayed: true });
    const state = await harness.admin.query<{ plan: string; reservation: string; budget: string }>(
      `SELECT (SELECT state FROM plans WHERE plan_id='plan-approval') plan,
              (SELECT state FROM reservations WHERE reservation_id='reserve-approval') reservation,
              (SELECT state FROM policy_budget_holds WHERE budget_ref='reserve-approval') budget`,
    );
    expect(state.rows[0]).toEqual({
      plan: 'DECLINED',
      reservation: 'RELEASED',
      budget: 'RELEASED',
    });
  });

  it('revokes an unmarked approval and releases its capital', async () => {
    await approve();
    const revoked = await repository.revoke({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-approval',
      planDigest: digest,
      reason: 'owner withdrew consent',
      idempotencyKey: 'revoke-1',
      actor: OWNER,
      now: BEFORE_EXPIRY,
    });
    expect(revoked).toMatchObject({ ok: true, effect: 'INVALIDATED_UNMARKED' });
    expect(
      (
        await harness.admin.query<{ state: string }>(
          `SELECT state FROM reservations WHERE reservation_id='reserve-approval'`,
        )
      ).rows[0]?.state,
    ).toBe('RELEASED');
  });

  it('records a halt request without releasing capital after a dispatch marker', async () => {
    await approve();
    await harness.admin.query(`UPDATE plans SET state='EXECUTING' WHERE plan_id='plan-approval'`);
    await harness.admin.query(
      `INSERT INTO dispatch_attempts
        (workspace_id,pool_id,epoch,attempt_id,plan_id,client_order_id,dispatch_token,state,
         signed_request,marked_at,marker_host_boot_id,marker_pid,marker_process_started_at)
       VALUES ($1,$2,1,'attempt-marked','plan-approval','client-marked','token-marked',
               'DISPATCH_MARKED','{}',$3,'boot-1',42,$3)`,
      [WORKSPACE, POOL, BEFORE_EXPIRY],
    );
    const revoked = await repository.revoke({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'plan-approval',
      planDigest: digest,
      reason: 'halt after marker',
      idempotencyKey: 'revoke-marked',
      actor: OWNER,
      now: BEFORE_EXPIRY,
    });
    expect(revoked).toMatchObject({ ok: true, effect: 'HALT_REQUESTED_IN_FLIGHT' });
    const state = await harness.admin.query<{ plan: string; reservation: string; pool: string }>(
      `SELECT (SELECT state FROM plans WHERE plan_id='plan-approval') plan,
              (SELECT state FROM reservations WHERE reservation_id='reserve-approval') reservation,
              (SELECT state FROM pools WHERE pool_id=$1) pool`,
      [POOL],
    );
    expect(state.rows[0]).toEqual({ plan: 'EXECUTING', reservation: 'HELD', pool: 'HALTED' });
  });
});
