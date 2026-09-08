import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContractViolation } from '@capitaldesk/contracts';
import { principal, type MandatePolicyWire } from '@capitaldesk/domain';
import { LedgerRepository } from './ledger.js';
import { PolicyRepository } from './policy.js';
import { DATABASE_URL, JournalHarness, POOL, USDT, WORKSPACE, sqlState } from './test-harness.js';

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

function draft(policyVersion = '1', strategyDaily = '1000', poolDaily = '1000'): MandatePolicyWire {
  return {
    policyVersion,
    selectedSymbol: 'BTCUSDT',
    baseAsset: 'BTC:v1',
    quoteAsset: 'USDT:v1',
    maxPoolPlanQuoteDebitAtoms: '1000',
    maxDailyGrossBuyQuoteAtoms: poolDaily,
    poolConcentrationNumerator: '8',
    poolConcentrationDenominator: '10',
    freshnessMaxAgeMs: {
      PRICE_SNAPSHOT: '5000',
      ACCOUNT_SNAPSHOT: '5000',
      SYMBOL_METADATA: '60000',
      VENUE_CLOCK: '1000',
    },
    planLifetimeMs: '60000',
    buyInhibitUntil: null,
    riskIncreaseHalted: false,
    feePolicyVersion: 'STANDARD_NO_BNB_V1',
    strategyLimits: [
      {
        strategyId: 'strategy-a',
        maxTargetBaseAtoms: '1000000',
        maxPlanQuoteDebitAtoms: '1000',
        maxDailyGrossBuyQuoteAtoms: strategyDaily,
      },
      {
        strategyId: 'strategy-b',
        maxTargetBaseAtoms: '1000000',
        maxPlanQuoteDebitAtoms: '1000',
        maxDailyGrossBuyQuoteAtoms: '1000',
      },
    ],
  };
}

describeIfDatabase('owner mandate journal', () => {
  const harness = new JournalHarness();
  let repository: PolicyRepository;

  beforeAll(() => harness.open());
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.reset();
    await harness.seedPool();
    repository = new PolicyRepository(harness.pool);
  });
  afterEach(() => harness.cleanup());

  async function publish(policy = draft(), key = `policy-${policy.policyVersion}`) {
    return repository.publish({
      workspaceId: WORKSPACE,
      poolId: POOL,
      expectedPoolVersion: Number(policy.policyVersion),
      idempotencyKey: key,
      draft: policy,
      actor: OWNER,
    });
  }

  async function fundStrategy(atoms = 1000n) {
    await new LedgerRepository(harness.pool).postTransaction({
      workspaceId: WORKSPACE,
      poolId: POOL,
      epoch: 1,
      ledgerTxnId: 'fund-strategy-a',
      source: { kind: 'fixture', ref: 'strategy-a-usdt' },
      description: 'owner allocates quote claim to strategy A',
      entries: [
        {
          accountKind: 'ASSET_CONTROL',
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL',
          asset: USDT,
          deltaAtoms: atoms,
        },
        {
          accountKind: 'STRATEGY',
          owner: 'strategy-a',
          claimState: 'AVAILABLE',
          asset: USDT,
          deltaAtoms: atoms,
        },
      ],
    });
  }

  it('publishes immutable versions with durable replay and exact optimistic concurrency', async () => {
    expect(await publish()).toMatchObject({ ok: true, policyVersion: '1', poolVersion: 2 });
    expect(await publish()).toMatchObject({ ok: true, replayed: true });
    expect(await publish(draft('2'), 'policy-2')).toMatchObject({ ok: true, policyVersion: '2' });
    expect(
      await repository.active({ workspaceId: WORKSPACE, poolId: POOL, actor: OWNER }),
    ).toMatchObject({ policyVersion: '2', selectedSymbol: 'BTCUSDT' });
    await expect(
      harness.admin.query(`UPDATE policy_versions SET risk_increase_halted=true`),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '23000');
  });

  it('refuses agent-authored policy changes regardless of prompt content', async () => {
    await expect(
      repository.publish({
        workspaceId: WORKSPACE,
        poolId: POOL,
        expectedPoolVersion: 1,
        idempotencyKey: 'agent-escalation',
        draft: draft(),
        actor: AGENT,
      }),
    ).rejects.toBeInstanceOf(ContractViolation);
  });

  it('serializes same-pool concurrent exhaustion so only one hold wins', async () => {
    await publish();
    await fundStrategy();
    const hold = (budgetRef: string) =>
      repository.holdDailyBuyBudget({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-a',
        policyVersion: '1',
        budgetRef,
        utcBucket: '2030-01-02',
        maxQuoteDebitAtoms: '600',
        actor: OWNER,
      });
    const results = await Promise.all([hold('plan-a'), hold('plan-b')]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'POLICY_BUDGET_EXCEEDED' },
    ]);
  });

  it('keeps consumed fills in their original UTC bucket while released capacity returns', async () => {
    await publish();
    await fundStrategy(2000n);
    const hold = (budgetRef: string, utcBucket: string, amount: string) =>
      repository.holdDailyBuyBudget({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-a',
        policyVersion: '1',
        budgetRef,
        utcBucket,
        maxQuoteDebitAtoms: amount,
        actor: OWNER,
      });
    expect(await hold('filled', '2030-01-02', '700')).toMatchObject({ ok: true });
    expect(
      await repository.settleBudgetHold({
        workspaceId: WORKSPACE,
        poolId: POOL,
        budgetRef: 'filled',
        consumedQuoteAtoms: '650',
      }),
    ).toBe(true);
    expect(await hold('same-day', '2030-01-02', '400')).toEqual({
      ok: false,
      reason: 'POLICY_BUDGET_EXCEEDED',
    });
    expect(await hold('next-day', '2030-01-03', '700')).toMatchObject({ ok: true });
    expect(
      await repository.settleBudgetHold({
        workspaceId: WORKSPACE,
        poolId: POOL,
        budgetRef: 'next-day',
        consumedQuoteAtoms: '0',
      }),
    ).toBe(true);
    expect(await hold('next-day-reuse', '2030-01-03', '1000')).toMatchObject({ ok: true });
  });

  it('uses the strategy claim as authority even when a venue could hold surplus cash', async () => {
    await publish();
    await fundStrategy(500n);
    expect(
      await repository.holdDailyBuyBudget({
        workspaceId: WORKSPACE,
        poolId: POOL,
        strategyId: 'strategy-a',
        policyVersion: '1',
        budgetRef: 'unfunded',
        utcBucket: '2030-01-02',
        maxQuoteDebitAtoms: '600',
        actor: OWNER,
      }),
    ).toEqual({ ok: false, reason: 'INSUFFICIENT_STRATEGY_CLAIM' });
  });
});
