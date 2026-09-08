import type { Pool } from 'pg';
import { digestOf, feePolicy, parseAtoms, violate } from '@capitaldesk/contracts';
import {
  assertAuthorized,
  mandatePolicy,
  type MandatePolicy,
  type MandatePolicyWire,
  type Principal,
} from '@capitaldesk/domain';
import { IdempotencyRepository } from './idempotency.js';
import { invalidateUnmarkedPlans, type UnmarkedInvalidation } from './restore.js';
import { transactional, type Queryable } from './transaction.js';

export type PublishPolicyOutcome =
  | {
      readonly ok: true;
      readonly policyVersion: string;
      readonly poolVersion: number;
      readonly replayed: boolean;
      readonly invalidation: UnmarkedInvalidation;
    }
  | {
      readonly ok: false;
      readonly reason: 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT';
      readonly currentPolicyVersion: string | null;
    };

function canonicalPolicy(wire: MandatePolicyWire): MandatePolicyWire {
  return {
    ...wire,
    freshnessMaxAgeMs: { ...wire.freshnessMaxAgeMs },
    strategyLimits: [...wire.strategyLimits]
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId))
      .map((limit) => ({ ...limit })),
  };
}

/** Owner policy publication and the gross-BUY budget authority journal. */
export class PolicyRepository {
  constructor(private readonly pool: Pool) {}

  publish(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly expectedPoolVersion: number;
    readonly idempotencyKey: string;
    readonly draft: MandatePolicyWire;
    readonly actor: Principal;
  }): Promise<PublishPolicyOutcome> {
    assertAuthorized(input.actor, 'policy.publish', input);
    const policy = mandatePolicy(input.draft);
    // Naming a registered but UNVERIFIED fee policy is valid policy configuration. It stays
    // non-dispatchable until its separate evidence gate passes.
    feePolicy(policy.feePolicyVersion);
    const payload = canonicalPolicy(input.draft);
    const payloadDigest = digestOf(payload);
    const scopeId = `${input.workspaceId}/${input.poolId}`;
    return transactional(this.pool, async (client): Promise<PublishPolicyOutcome> => {
      const pool = await client.query<{
        version: number;
        active_policy_version: string | null;
        selected_symbol: string | null;
        base_asset_code: string | null;
        base_asset_scale: string | null;
        quote_asset_code: string | null;
        quote_asset_scale: string | null;
      }>(
        `SELECT version,active_policy_version::text,selected_symbol,base_asset_code,
                base_asset_scale,quote_asset_code,quote_asset_scale
           FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE`,
        [input.workspaceId, input.poolId],
      );
      const poolRow = pool.rows[0];
      if (poolRow === undefined) violate('IDENTITY_SCOPE_MISMATCH', 'pool does not exist');

      const begun = await IdempotencyRepository.beginOn(client, {
        scopeKind: 'pool',
        scopeId,
        key: input.idempotencyKey,
        requestDigest: payloadDigest,
      });
      if (begun.kind === 'conflict') {
        return {
          ok: false,
          reason: 'IDEMPOTENCY_CONFLICT',
          currentPolicyVersion: poolRow.active_policy_version,
        };
      }
      if (begun.kind === 'replay') {
        const prior = begun.body as PublishPolicyOutcome;
        return prior.ok ? { ...prior, replayed: true } : prior;
      }
      if (begun.kind === 'replay-expired') {
        return {
          ok: false,
          reason: 'IDEMPOTENCY_CONFLICT',
          currentPolicyVersion: poolRow.active_policy_version,
        };
      }

      const expectedPolicy =
        poolRow.active_policy_version === null ? 1n : BigInt(poolRow.active_policy_version) + 1n;
      if (
        poolRow.version !== input.expectedPoolVersion ||
        policy.policyVersion !== expectedPolicy
      ) {
        const outcome: PublishPolicyOutcome = {
          ok: false,
          reason: 'VERSION_CONFLICT',
          currentPolicyVersion: poolRow.active_policy_version,
        };
        await this.recordPublish(client, {
          scopeId,
          idempotencyKey: input.idempotencyKey,
          payloadDigest,
          policyVersion: policy.policyVersion.toString(),
          outcome,
        });
        return outcome;
      }
      if (
        poolRow.selected_symbol !== null &&
        (poolRow.selected_symbol !== policy.selectedSymbol ||
          poolRow.base_asset_code !== policy.baseAsset.code ||
          poolRow.base_asset_scale !== policy.baseAsset.scaleVersion ||
          poolRow.quote_asset_code !== policy.quoteAsset.code ||
          poolRow.quote_asset_scale !== policy.quoteAsset.scaleVersion)
      ) {
        violate('IDENTITY_SCOPE_MISMATCH', 'policy cannot change the pool selected market');
      }
      const activeStrategies = await client.query<{ strategy_id: string }>(
        `SELECT strategy_id FROM strategies
          WHERE workspace_id=$1 AND pool_id=$2 AND archived_at IS NULL FOR SHARE`,
        [input.workspaceId, input.poolId],
      );
      const active = new Set(activeStrategies.rows.map((row) => row.strategy_id));
      for (const limit of policy.strategyLimits) {
        if (!active.has(limit.strategyId)) {
          violate(
            'IDENTITY_SCOPE_MISMATCH',
            'policy limit names a strategy not active in this pool',
            {
              strategyId: limit.strategyId,
            },
          );
        }
      }

      await this.insertPolicy(client, input, policy, payload, payloadDigest);
      const maxTarget = policy.strategyLimits.reduce(
        (maximum, limit) =>
          limit.maxTargetBaseAtoms > maximum ? limit.maxTargetBaseAtoms : maximum,
        0n,
      );
      const activated = await client.query<{ version: number }>(
        `UPDATE pools
            SET selected_symbol=$3,base_asset_code=$4,base_asset_scale=$5,
                quote_asset_code=$6,quote_asset_scale=$7,max_target_base_atoms=$8,
                active_policy_version=$9,version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 RETURNING version`,
        [
          input.workspaceId,
          input.poolId,
          policy.selectedSymbol,
          policy.baseAsset.code,
          policy.baseAsset.scaleVersion,
          policy.quoteAsset.code,
          policy.quoteAsset.scaleVersion,
          maxTarget.toString(),
          policy.policyVersion.toString(),
        ],
      );
      const invalidation = await invalidateUnmarkedPlans(client, {
        reason: `mandate policy ${policy.policyVersion.toString()} published by owner`,
        releaseKind: 'policy-publish',
        scope: { workspaceId: input.workspaceId, poolId: input.poolId },
      });
      const outcome: PublishPolicyOutcome = {
        ok: true,
        policyVersion: policy.policyVersion.toString(),
        poolVersion: activated.rows[0]?.version ?? input.expectedPoolVersion + 1,
        replayed: false,
        invalidation,
      };
      await this.recordPublish(client, {
        scopeId,
        idempotencyKey: input.idempotencyKey,
        payloadDigest,
        policyVersion: policy.policyVersion.toString(),
        outcome,
      });
      return outcome;
    });
  }

  private async insertPolicy(
    client: Queryable,
    input: {
      workspaceId: string;
      poolId: string;
      idempotencyKey: string;
      actor: Principal;
    },
    policy: MandatePolicy,
    payload: MandatePolicyWire,
    payloadDigest: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO policy_versions
        (workspace_id,pool_id,policy_version,payload,payload_digest,selected_symbol,
         base_asset_code,base_asset_scale,quote_asset_code,quote_asset_scale,
         max_pool_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms,
         concentration_numerator,concentration_denominator,price_snapshot_max_age_ms,
         account_snapshot_max_age_ms,symbol_metadata_max_age_ms,venue_clock_max_age_ms,
         plan_lifetime_ms,buy_inhibit_until,risk_increase_halted,fee_policy_version,
         published_by_subject_id,idempotency_key)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24)`,
      [
        input.workspaceId,
        input.poolId,
        policy.policyVersion.toString(),
        JSON.stringify(payload),
        payloadDigest,
        policy.selectedSymbol,
        policy.baseAsset.code,
        policy.baseAsset.scaleVersion,
        policy.quoteAsset.code,
        policy.quoteAsset.scaleVersion,
        policy.maxPoolPlanQuoteDebitAtoms.toString(),
        policy.maxDailyGrossBuyQuoteAtoms.toString(),
        policy.poolConcentrationLimit.numerator.toString(),
        policy.poolConcentrationLimit.denominator.toString(),
        policy.freshnessMaxAgeMs.PRICE_SNAPSHOT.toString(),
        policy.freshnessMaxAgeMs.ACCOUNT_SNAPSHOT.toString(),
        policy.freshnessMaxAgeMs.SYMBOL_METADATA.toString(),
        policy.freshnessMaxAgeMs.VENUE_CLOCK.toString(),
        policy.planLifetimeMs.toString(),
        policy.buyInhibitUntil,
        policy.riskIncreaseHalted,
        policy.feePolicyVersion,
        input.actor.subjectId,
        input.idempotencyKey,
      ],
    );
    for (const limit of policy.strategyLimits) {
      await client.query(
        `INSERT INTO strategy_policy_limits
          (workspace_id,pool_id,policy_version,strategy_id,max_target_base_atoms,
           max_plan_quote_debit_atoms,max_daily_gross_buy_quote_atoms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.workspaceId,
          input.poolId,
          policy.policyVersion.toString(),
          limit.strategyId,
          limit.maxTargetBaseAtoms.toString(),
          limit.maxPlanQuoteDebitAtoms.toString(),
          limit.maxDailyGrossBuyQuoteAtoms.toString(),
        ],
      );
    }
  }

  private async recordPublish(
    client: Queryable,
    input: {
      scopeId: string;
      idempotencyKey: string;
      payloadDigest: string;
      policyVersion: string;
      outcome: PublishPolicyOutcome;
    },
  ): Promise<void> {
    await IdempotencyRepository.recordOn(client, {
      scopeKind: 'pool',
      scopeId: input.scopeId,
      key: input.idempotencyKey,
      requestDigest: input.payloadDigest,
      action: 'POLICY_VERSION_PUBLISH',
      economicRef: input.policyVersion,
      status: input.outcome.ok ? 201 : 409,
      body: input.outcome,
      retentionMs: 86_400_000,
    });
  }

  async active(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly actor: Principal;
  }): Promise<MandatePolicyWire | null> {
    assertAuthorized(input.actor, 'pool.read', input);
    const result = await this.pool.query<{ payload: MandatePolicyWire }>(
      `SELECT v.payload FROM pools p JOIN policy_versions v
          ON v.workspace_id=p.workspace_id AND v.pool_id=p.pool_id
         AND v.policy_version=p.active_policy_version
        WHERE p.workspace_id=$1 AND p.pool_id=$2`,
      [input.workspaceId, input.poolId],
    );
    return result.rows[0]?.payload ?? null;
  }

  holdDailyBuyBudget(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly policyVersion: string;
    readonly budgetRef: string;
    readonly utcBucket: string;
    readonly maxQuoteDebitAtoms: string;
    readonly actor: Principal;
  }): Promise<
    | { readonly ok: true; readonly replayed: boolean }
    | {
        readonly ok: false;
        readonly reason:
          | 'POLICY_VERSION_STALE'
          | 'POLICY_BUDGET_EXCEEDED'
          | 'INSUFFICIENT_STRATEGY_CLAIM'
          | 'BUDGET_REF_CONFLICT';
      }
  > {
    assertAuthorized(input.actor, 'plan.seal', input);
    const amount = parseAtoms(input.maxQuoteDebitAtoms);
    if (amount <= 0n || !/^\d{4}-\d{2}-\d{2}$/.test(input.utcBucket)) {
      violate('POLICY_CONFIGURATION_MISSING', 'budget hold amount and UTC bucket are malformed');
    }
    return transactional(this.pool, async (client) => {
      const pool = await client.query<{
        active_policy_version: string | null;
        quote_asset_code: string | null;
        quote_asset_scale: string | null;
      }>(
        `SELECT active_policy_version::text,quote_asset_code,quote_asset_scale
           FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE`,
        [input.workspaceId, input.poolId],
      );
      const poolRow = pool.rows[0];
      if (poolRow?.active_policy_version !== input.policyVersion) {
        return { ok: false, reason: 'POLICY_VERSION_STALE' } as const;
      }
      const existing = await client.query<{
        policy_version: string;
        strategy_id: string;
        utc_bucket: string;
        max_quote_debit_atoms: string;
      }>(
        `SELECT policy_version::text,strategy_id,utc_bucket::text,max_quote_debit_atoms::text
           FROM policy_budget_holds WHERE workspace_id=$1 AND pool_id=$2 AND budget_ref=$3`,
        [input.workspaceId, input.poolId, input.budgetRef],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        return prior.policy_version === input.policyVersion &&
          prior.strategy_id === input.strategyId &&
          prior.utc_bucket === input.utcBucket &&
          prior.max_quote_debit_atoms === amount.toString()
          ? { ok: true, replayed: true }
          : { ok: false, reason: 'BUDGET_REF_CONFLICT' };
      }
      const limits = await client.query<{
        strategy_limit: string;
        pool_limit: string;
      }>(
        `SELECT s.max_daily_gross_buy_quote_atoms::text AS strategy_limit,
                p.max_daily_gross_buy_quote_atoms::text AS pool_limit
           FROM strategy_policy_limits s JOIN policy_versions p
             USING (workspace_id,pool_id,policy_version)
          WHERE s.workspace_id=$1 AND s.pool_id=$2 AND s.policy_version=$3
            AND s.strategy_id=$4`,
        [input.workspaceId, input.poolId, input.policyVersion, input.strategyId],
      );
      const limit = limits.rows[0];
      if (limit === undefined) return { ok: false, reason: 'POLICY_VERSION_STALE' } as const;
      const used = await client.query<{ strategy_used: string; pool_used: string }>(
        `SELECT
           coalesce(sum(CASE WHEN strategy_id=$4 THEN
             CASE WHEN state='HELD' THEN max_quote_debit_atoms ELSE consumed_quote_atoms END
             ELSE 0 END),0)::text AS strategy_used,
           coalesce(sum(CASE WHEN state='HELD' THEN max_quote_debit_atoms
                             ELSE consumed_quote_atoms END),0)::text AS pool_used
           FROM policy_budget_holds
          WHERE workspace_id=$1 AND pool_id=$2 AND utc_bucket=$3 AND state IN ('HELD','CONSUMED')`,
        [input.workspaceId, input.poolId, input.utcBucket, input.strategyId],
      );
      const totals = used.rows[0];
      if (
        BigInt(totals?.strategy_used ?? '0') + amount > BigInt(limit.strategy_limit) ||
        BigInt(totals?.pool_used ?? '0') + amount > BigInt(limit.pool_limit)
      ) {
        return { ok: false, reason: 'POLICY_BUDGET_EXCEEDED' } as const;
      }
      const claims = await client.query<{ available: string }>(
        `SELECT coalesce(sum(delta_atoms),0)::text AS available
           FROM ledger_entries
          WHERE workspace_id=$1 AND pool_id=$2 AND epoch=(SELECT epoch FROM baseline_epochs
                 WHERE workspace_id=$1 AND pool_id=$2 AND closed_at IS NULL)
            AND account_owner=$3 AND claim_state='AVAILABLE'
            AND asset_code=$4 AND asset_scale=$5`,
        [
          input.workspaceId,
          input.poolId,
          input.strategyId,
          poolRow.quote_asset_code,
          poolRow.quote_asset_scale,
        ],
      );
      const outstanding = BigInt(totals?.strategy_used ?? '0');
      if (BigInt(claims.rows[0]?.available ?? '0') < outstanding + amount) {
        return { ok: false, reason: 'INSUFFICIENT_STRATEGY_CLAIM' } as const;
      }
      await client.query(
        `INSERT INTO policy_budget_holds
          (workspace_id,pool_id,policy_version,strategy_id,budget_ref,utc_bucket,max_quote_debit_atoms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.workspaceId,
          input.poolId,
          input.policyVersion,
          input.strategyId,
          input.budgetRef,
          input.utcBucket,
          amount.toString(),
        ],
      );
      return { ok: true, replayed: false } as const;
    });
  }

  async settleBudgetHold(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly budgetRef: string;
    readonly consumedQuoteAtoms: string;
  }): Promise<boolean> {
    const consumed = parseAtoms(input.consumedQuoteAtoms);
    if (consumed < 0n) violate('MONEY_NEGATIVE_RESULT', 'consumed budget cannot be negative');
    const result = await this.pool.query(
      `UPDATE policy_budget_holds
          SET state=CASE WHEN $4::numeric > 0 THEN 'CONSUMED' ELSE 'RELEASED' END,
              consumed_quote_atoms=$4,updated_at=now()
        WHERE workspace_id=$1 AND pool_id=$2 AND budget_ref=$3 AND state='HELD'`,
      [input.workspaceId, input.poolId, input.budgetRef, consumed.toString()],
    );
    return result.rowCount === 1;
  }
}
