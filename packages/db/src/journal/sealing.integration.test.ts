import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assetKey,
  amount,
  poolId,
  priceFromDecimal,
  venueAccountKey,
  type FeeBoundEvidence,
  type SealedPlanPayload,
} from '@capitaldesk/contracts';
import { principal, type MandatePolicyWire } from '@capitaldesk/domain';
import { IntentRepository } from './intents.js';
import { LedgerRepository } from './ledger.js';
import { PolicyRepository } from './policy.js';
import { SealingRepository } from './sealing.js';
import { ACCOUNT, DATABASE_URL, JournalHarness, POOL, USDT, WORKSPACE } from './test-harness.js';

const describeIfDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER = principal({
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'owner-1',
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

function payload(planSuffix = 'a'): SealedPlanPayload {
  return {
    pool: poolId(
      WORKSPACE,
      venueAccountKey(ACCOUNT.venue, ACCOUNT.environment, ACCOUNT.stableAccountId),
      1,
    ),
    childClientOrderId: `child-${planSuffix}`,
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
        intentId: 'intent-1',
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

describeIfDatabase('atomic plan sealing', () => {
  const harness = new JournalHarness();
  let repository: SealingRepository;

  beforeAll(() => harness.open());
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    await new PolicyRepository(harness.pool).publish({
      workspaceId: WORKSPACE,
      poolId: POOL,
      expectedPoolVersion: 1,
      idempotencyKey: 'policy-1',
      draft: policy(),
      actor: OWNER,
    });
    await new IntentRepository(harness.pool).propose({
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-a',
      idempotencyKey: 'intent-1',
      proposal: {
        intentId: 'intent-1',
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
      ledgerTxnId: 'fund-a',
      source: { kind: 'fixture', ref: 'fund-a' },
      description: 'fund strategy A',
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
    repository = new SealingRepository(harness.pool);
  });
  afterEach(() => harness.cleanup());

  function seal(planId = 'plan-a') {
    return repository.seal({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId,
      payload: payload(planId),
      expectedLedgerRevision: 1,
      expectedPolicyVersion: '1',
      reservations: [
        {
          reservationId: `reserve-${planId}`,
          strategyId: 'strategy-a',
          asset: USDT_KEY,
          atoms: 600n,
        },
      ],
      venueCapacity: {
        evidenceId: `capacity-${planId}`,
        complete: true,
        free: [{ asset: USDT_KEY, atoms: 1000n }],
      },
      feeBoundEvidence: FEE_EVIDENCE,
      verifiedAccountSettings: ['environment=local'],
      actor: OWNER,
    });
  }

  it('commits plan, binding, reservation, ledger move and outbox atomically', async () => {
    expect(await seal()).toMatchObject({ ok: true, planId: 'plan-a', ledgerRevision: 2 });
    const rows = await harness.admin.query<{
      plans: string;
      reservations: string;
      bindings: string;
      outbox: string;
    }>(
      `SELECT (SELECT count(*) FROM plans)::text plans,
              (SELECT count(*) FROM reservations)::text reservations,
              (SELECT count(*) FROM intent_plan_bindings)::text bindings,
              (SELECT count(*) FROM outbox WHERE kind='plan.sealed')::text outbox`,
    );
    expect(rows.rows[0]).toEqual({ plans: '1', reservations: '1', bindings: '1', outbox: '1' });
  });

  it('rejects stale preview revisions without partial rows', async () => {
    const result = await repository.seal({
      workspaceId: WORKSPACE,
      poolId: POOL,
      planId: 'stale',
      payload: payload('stale'),
      expectedLedgerRevision: 0,
      expectedPolicyVersion: '1',
      reservations: [],
      venueCapacity: { evidenceId: 'capacity-stale', complete: true, free: [] },
      feeBoundEvidence: FEE_EVIDENCE,
      verifiedAccountSettings: ['environment=local'],
      actor: OWNER,
    });
    expect(result).toEqual({ ok: false, reason: 'STALE_PREVIEW' });
    expect((await harness.admin.query('SELECT 1 FROM plans')).rowCount).toBe(0);
  });

  it('allows only one winner when two seals race for the same pool and capital', async () => {
    const results = await Promise.all([seal('race-a'), seal('race-b')]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      (await harness.admin.query(`SELECT 1 FROM reservations WHERE state='HELD'`)).rowCount,
    ).toBe(1);
  });
});
