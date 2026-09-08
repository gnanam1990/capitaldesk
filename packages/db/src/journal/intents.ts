import type { Pool } from 'pg';
import { digestOf, violate, type CanonicalValue } from '@capitaldesk/contracts';
import {
  assertAuthorized,
  configuredAsset,
  targetProgress,
  validateStrategyTarget,
  type Principal,
  type StrategyTargetProposal,
  type TargetProgress,
} from '@capitaldesk/domain';
import { IdempotencyRepository, type BeginOutcome } from './idempotency.js';
import { invalidateUnmarkedPlans, type UnmarkedInvalidation } from './restore.js';
import { transactional, type Queryable } from './transaction.js';

export type IntentDisposition = 'CURRENT' | 'QUEUED_NEXT_COHORT' | 'DEFERRED';

export interface AcceptedIntent {
  readonly intentId: string;
  readonly strategyRevision: string;
  readonly acceptedSequence: string;
  readonly disposition: IntentDisposition;
  readonly replayed: boolean;
}

export type ProposeIntentOutcome =
  | { readonly ok: true; readonly intent: AcceptedIntent }
  | { readonly ok: false; readonly reason: 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT' }
  | {
      readonly ok: false;
      readonly reason: 'REVISION_NOT_MONOTONIC';
      readonly currentRevision: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'IDEMPOTENCY_RESPONSE_EXPIRED';
      readonly intentId: string | null;
    };

export type TargetControlOutcome =
  | {
      readonly ok: true;
      readonly state: 'DEFERRED' | 'ACTIVE';
      readonly version: number;
      readonly replayed: boolean;
      readonly invalidation: UnmarkedInvalidation;
    }
  | { readonly ok: false; readonly reason: 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' };

interface PoolMarketRow {
  readonly epoch: number;
  readonly selected_symbol: string | null;
  readonly base_asset_code: string | null;
  readonly base_asset_scale: string | null;
  readonly quote_asset_code: string | null;
  readonly quote_asset_scale: string | null;
  readonly max_target_base_atoms: string | null;
  readonly active_policy_version: string | null;
  readonly strategy_max_target_base_atoms: string | null;
  readonly strategy_max_plan_quote_debit_atoms: string | null;
}

interface ConfiguredPoolMarketRow extends PoolMarketRow {
  readonly selected_symbol: string;
  readonly base_asset_code: string;
  readonly base_asset_scale: string;
  readonly quote_asset_code: string;
  readonly quote_asset_scale: string;
  readonly max_target_base_atoms: string;
  readonly active_policy_version: string;
  readonly strategy_max_target_base_atoms: string;
  readonly strategy_max_plan_quote_debit_atoms: string;
}

interface IntentRow {
  readonly intent_id: string;
  readonly strategy_revision: string;
  readonly request_digest: string;
  readonly accepted_sequence: string;
  readonly state: string;
  readonly is_current: boolean;
  readonly is_next_cohort: boolean;
}

function targetScope(
  workspaceId: string,
  poolId: string,
  strategyId: string,
  symbol: string,
): string {
  return `${workspaceId}/${poolId}/${strategyId}/${symbol}`;
}

function canonicalProposal(input: StrategyTargetProposal): CanonicalValue {
  return {
    expiresAt: input.expiresAt,
    intentId: input.intentId,
    maxBuyPrice: input.maxBuyPrice,
    maxQuoteDebitAtoms: input.maxQuoteDebitAtoms,
    minSellPrice: input.minSellPrice,
    policyVersion: input.policyVersion,
    strategyRevision: input.strategyRevision,
    symbol: input.symbol,
    targetBaseQtyAtoms: input.targetBaseQtyAtoms,
  };
}

function disposition(row: IntentRow): IntentDisposition {
  if (row.state === 'DEFERRED') return 'DEFERRED';
  return row.is_next_cohort ? 'QUEUED_NEXT_COHORT' : 'CURRENT';
}

function accepted(row: IntentRow, replayed: boolean): AcceptedIntent {
  return {
    intentId: row.intent_id,
    strategyRevision: row.strategy_revision,
    acceptedSequence: row.accepted_sequence,
    disposition: disposition(row),
    replayed,
  };
}

async function currentEpochAndMarket(
  client: Queryable,
  workspaceId: string,
  poolId: string,
  strategyId: string,
): Promise<ConfiguredPoolMarketRow> {
  const result = await client.query<PoolMarketRow>(
    `SELECT e.epoch, p.selected_symbol, p.base_asset_code, p.base_asset_scale,
            p.quote_asset_code, p.quote_asset_scale, p.max_target_base_atoms::text,
            p.active_policy_version::text,
            limits.max_target_base_atoms::text AS strategy_max_target_base_atoms,
            limits.max_plan_quote_debit_atoms::text AS strategy_max_plan_quote_debit_atoms
       FROM pools p
       JOIN baseline_epochs e USING (workspace_id, pool_id)
       LEFT JOIN strategy_policy_limits limits
         ON limits.workspace_id=p.workspace_id AND limits.pool_id=p.pool_id
        AND limits.policy_version=p.active_policy_version AND limits.strategy_id=$3
      WHERE p.workspace_id=$1 AND p.pool_id=$2 AND e.closed_at IS NULL
      FOR UPDATE OF p, e`,
    [workspaceId, poolId, strategyId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    violate('IDENTITY_SCOPE_MISMATCH', 'pool or current baseline epoch does not exist');
  }
  if (
    row.selected_symbol === null ||
    row.base_asset_code === null ||
    row.base_asset_scale === null ||
    row.quote_asset_code === null ||
    row.quote_asset_scale === null ||
    row.max_target_base_atoms === null ||
    row.active_policy_version === null ||
    row.strategy_max_target_base_atoms === null ||
    row.strategy_max_plan_quote_debit_atoms === null
  ) {
    violate(
      'POLICY_CONFIGURATION_MISSING',
      'pool selected market or active policy is not configured',
    );
  }
  return row as ConfiguredPoolMarketRow;
}

async function isTargetDeferred(
  client: Queryable,
  input: { workspaceId: string; poolId: string; strategyId: string; symbol: string },
): Promise<boolean> {
  const result = await client.query<{ deferred: boolean }>(
    `SELECT deferred_at IS NOT NULL
            AND (reinstated_at IS NULL OR reinstated_at < deferred_at)
            AND (until_at IS NULL OR until_at > now()) AS deferred
       FROM strategy_target_controls
      WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4`,
    [input.workspaceId, input.poolId, input.strategyId, input.symbol],
  );
  return result.rows[0]?.deferred === true;
}

/** Durable strategy and intent service. All acceptance decisions share the pool row lock. */
export class IntentRepository {
  constructor(private readonly pool: Pool) {}

  async createStrategy(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly displayName: string;
    readonly idempotencyKey: string;
    readonly actor: Principal;
  }): Promise<{ readonly created: boolean; readonly version: number; readonly replayed: boolean }> {
    assertAuthorized(input.actor, 'strategy.create', input);
    const scopeId = `${input.workspaceId}/${input.poolId}`;
    const requestDigest = digestOf({
      action: 'STRATEGY_CREATE',
      displayName: input.displayName,
      strategyId: input.strategyId,
    });
    return transactional(this.pool, async (client) => {
      await client.query('SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE', [
        input.workspaceId,
        input.poolId,
      ]);
      const begun = await IdempotencyRepository.beginOn(client, {
        scopeKind: 'pool',
        scopeId,
        key: input.idempotencyKey,
        requestDigest,
      });
      if (begun.kind === 'conflict') {
        violate('IDEMPOTENCY_BODY_CONFLICT', 'idempotency key has different content');
      }
      if (begun.kind === 'replay') {
        const prior = begun.body as { created: boolean; version: number };
        return { ...prior, replayed: true };
      }
      if (begun.kind === 'replay-expired') {
        violate('IDEMPOTENCY_BODY_CONFLICT', 'idempotency response expired; key remains used');
      }
      const result = await client.query<{ version: number }>(
        `INSERT INTO strategies (workspace_id,pool_id,strategy_id,display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id,strategy_id) DO NOTHING
         RETURNING version`,
        [input.workspaceId, input.poolId, input.strategyId, input.displayName],
      );
      let outcome: { created: boolean; version: number; replayed: boolean };
      if (result.rows[0] !== undefined) {
        outcome = { created: true, version: result.rows[0].version, replayed: false };
      } else {
        const existing = await client.query<{
          pool_id: string;
          display_name: string;
          version: number;
        }>(
          `SELECT pool_id,display_name,version FROM strategies
            WHERE workspace_id=$1 AND strategy_id=$2`,
          [input.workspaceId, input.strategyId],
        );
        const row = existing.rows[0];
        if (row?.pool_id !== input.poolId || row.display_name !== input.displayName) {
          violate('IDEMPOTENCY_BODY_CONFLICT', 'strategy id already names different content');
        }
        outcome = { created: false, version: row.version, replayed: false };
      }
      await IdempotencyRepository.recordOn(client, {
        scopeKind: 'pool',
        scopeId,
        key: input.idempotencyKey,
        requestDigest,
        action: 'STRATEGY_CREATE',
        economicRef: input.strategyId,
        status: outcome.created ? 201 : 200,
        body: outcome,
        retentionMs: 86_400_000,
      });
      return outcome;
    });
  }

  async archiveStrategy(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly actor: Principal;
  }): Promise<{
    readonly archived: boolean;
    readonly version: number | null;
    readonly invalidation: UnmarkedInvalidation;
    readonly replayed: boolean;
  }> {
    assertAuthorized(input.actor, 'strategy.archive', input);
    const scopeId = `${input.workspaceId}/${input.poolId}`;
    const requestDigest = digestOf({
      action: 'STRATEGY_ARCHIVE',
      expectedVersion: String(input.expectedVersion),
      strategyId: input.strategyId,
    });
    return transactional(this.pool, async (client) => {
      await client.query('SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE', [
        input.workspaceId,
        input.poolId,
      ]);
      const begun = await IdempotencyRepository.beginOn(client, {
        scopeKind: 'pool',
        scopeId,
        key: input.idempotencyKey,
        requestDigest,
      });
      if (begun.kind === 'conflict') {
        violate('IDEMPOTENCY_BODY_CONFLICT', 'idempotency key has different content');
      }
      if (begun.kind === 'replay') {
        const prior = begun.body as {
          archived: boolean;
          version: number | null;
          invalidation: UnmarkedInvalidation;
        };
        return { ...prior, replayed: true };
      }
      if (begun.kind === 'replay-expired') {
        violate('IDEMPOTENCY_BODY_CONFLICT', 'idempotency response expired; key remains used');
      }
      const result = await client.query<{ version: number }>(
        `UPDATE strategies SET archived_at=now(), version=version+1, updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3
            AND archived_at IS NULL AND version=$4 RETURNING version`,
        [input.workspaceId, input.poolId, input.strategyId, input.expectedVersion],
      );
      let outcome: {
        archived: boolean;
        version: number | null;
        invalidation: UnmarkedInvalidation;
        replayed: boolean;
      };
      if (result.rows[0] === undefined) {
        outcome = {
          archived: false,
          version: null,
          invalidation: { plansInvalidated: 0, reservationsReleased: 0, attemptsVoided: 0 },
          replayed: false,
        };
      } else {
        const invalidation = await invalidateUnmarkedPlans(client, {
          reason: `strategy ${input.strategyId} archived by owner`,
          releaseKind: 'strategy-archive',
          scope: { workspaceId: input.workspaceId, poolId: input.poolId },
        });
        outcome = {
          archived: true,
          version: result.rows[0].version,
          invalidation,
          replayed: false,
        };
      }
      await IdempotencyRepository.recordOn(client, {
        scopeKind: 'pool',
        scopeId,
        key: input.idempotencyKey,
        requestDigest,
        action: 'STRATEGY_ARCHIVE',
        economicRef: input.strategyId,
        status: outcome.archived ? 200 : 409,
        body: outcome,
        retentionMs: 86_400_000,
      });
      return outcome;
    });
  }

  defer(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly symbol: string;
    readonly expectedVersion: number;
    readonly untilAt: Date | null;
    readonly idempotencyKey: string;
    readonly actor: Principal;
  }): Promise<TargetControlOutcome> {
    assertAuthorized(input.actor, 'intent.defer', input);
    if (
      input.untilAt !== null &&
      (!Number.isFinite(input.untilAt.getTime()) || input.untilAt.getTime() <= Date.now())
    ) {
      violate('INTENT_EXPIRED', 'deferral untilAt must be a valid future instant');
    }
    return this.changeTargetControl({ ...input, action: 'INTENT_DEFER' });
  }

  reinstate(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly symbol: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly actor: Principal;
  }): Promise<TargetControlOutcome> {
    assertAuthorized(input.actor, 'intent.reinstate', input);
    return this.changeTargetControl({ ...input, action: 'INTENT_REINSTATE', untilAt: null });
  }

  private changeTargetControl(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly symbol: string;
    readonly expectedVersion: number;
    readonly untilAt: Date | null;
    readonly idempotencyKey: string;
    readonly actor: Principal;
    readonly action: 'INTENT_DEFER' | 'INTENT_REINSTATE';
  }): Promise<TargetControlOutcome> {
    const scopeId = targetScope(input.workspaceId, input.poolId, input.strategyId, input.symbol);
    const requestDigest = digestOf({
      action: input.action,
      expectedVersion: String(input.expectedVersion),
      untilAt: input.untilAt?.toISOString() ?? null,
    });
    return transactional(this.pool, async (client): Promise<TargetControlOutcome> => {
      await currentEpochAndMarket(client, input.workspaceId, input.poolId, input.strategyId);
      const replay = await IdempotencyRepository.beginOn(client, {
        scopeKind: 'strategyTarget',
        scopeId,
        key: input.idempotencyKey,
        requestDigest,
      });
      if (replay.kind === 'conflict') return { ok: false, reason: 'IDEMPOTENCY_CONFLICT' };
      if (replay.kind === 'replay') {
        const prior = replay.body as TargetControlOutcome;
        return prior.ok ? { ...prior, replayed: true } : prior;
      }
      if (replay.kind === 'replay-expired') {
        return { ok: false, reason: 'IDEMPOTENCY_CONFLICT' };
      }

      const control = await client.query<{ version: number }>(
        `SELECT version FROM strategy_target_controls
          WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4 FOR UPDATE`,
        [input.workspaceId, input.poolId, input.strategyId, input.symbol],
      );
      const priorVersion = control.rows[0]?.version ?? 0;
      if (
        priorVersion !== input.expectedVersion ||
        (input.action === 'INTENT_REINSTATE' && priorVersion === 0)
      ) {
        const outcome: TargetControlOutcome = { ok: false, reason: 'VERSION_CONFLICT' };
        await IdempotencyRepository.recordOn(client, {
          scopeKind: 'strategyTarget',
          scopeId,
          key: input.idempotencyKey,
          requestDigest,
          action: input.action,
          economicRef: null,
          status: 409,
          body: outcome,
          retentionMs: 86_400_000,
        });
        return outcome;
      }
      const nextVersion = priorVersion + 1;
      if (priorVersion === 0) {
        await client.query(
          `INSERT INTO strategy_target_controls
            (workspace_id,pool_id,strategy_id,symbol,deferred_at,until_at,reinstated_at,version)
           VALUES ($1,$2,$3,$4,CASE WHEN $5='INTENT_DEFER' THEN now() ELSE NULL END,
                   $6,CASE WHEN $5='INTENT_REINSTATE' THEN now() ELSE NULL END,1)`,
          [
            input.workspaceId,
            input.poolId,
            input.strategyId,
            input.symbol,
            input.action,
            input.untilAt,
          ],
        );
      } else {
        await client.query(
          `UPDATE strategy_target_controls
              SET deferred_at=CASE WHEN $5='INTENT_DEFER' THEN now() ELSE deferred_at END,
                  until_at=CASE WHEN $5='INTENT_DEFER' THEN $6 ELSE until_at END,
                  reinstated_at=CASE WHEN $5='INTENT_REINSTATE' THEN now() ELSE NULL END,
                  version=version+1,updated_at=now()
            WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4`,
          [
            input.workspaceId,
            input.poolId,
            input.strategyId,
            input.symbol,
            input.action,
            input.untilAt,
          ],
        );
      }
      await client.query(
        `UPDATE strategy_intents
            SET state=CASE WHEN $5='INTENT_DEFER' THEN 'DEFERRED'
                           WHEN is_next_cohort THEN 'QUEUED_NEXT_COHORT' ELSE 'VALIDATED' END,
                updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4
            AND (is_current OR is_next_cohort)`,
        [input.workspaceId, input.poolId, input.strategyId, input.symbol, input.action],
      );
      const invalidation =
        input.action === 'INTENT_DEFER'
          ? await invalidateUnmarkedPlans(client, {
              reason: `target ${scopeId} deferred by owner`,
              releaseKind: 'intent-defer',
              scope: { workspaceId: input.workspaceId, poolId: input.poolId },
            })
          : { plansInvalidated: 0, reservationsReleased: 0, attemptsVoided: 0 };
      await client.query(
        `INSERT INTO strategy_target_control_events
          (workspace_id,pool_id,strategy_id,symbol,action,actor_subject_id,expected_version,
           resulting_version,until_at,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.workspaceId,
          input.poolId,
          input.strategyId,
          input.symbol,
          input.action,
          input.actor.subjectId,
          input.expectedVersion,
          nextVersion,
          input.untilAt,
          input.idempotencyKey,
        ],
      );
      const outcome: TargetControlOutcome = {
        ok: true,
        state: input.action === 'INTENT_DEFER' ? 'DEFERRED' : 'ACTIVE',
        version: nextVersion,
        replayed: false,
        invalidation,
      };
      await IdempotencyRepository.recordOn(client, {
        scopeKind: 'strategyTarget',
        scopeId,
        key: input.idempotencyKey,
        requestDigest,
        action: input.action,
        economicRef: scopeId,
        status: 200,
        body: outcome,
        retentionMs: 86_400_000,
      });
      return outcome;
    });
  }

  async propose(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly idempotencyKey: string;
    readonly proposal: StrategyTargetProposal;
    readonly actor: Principal;
    readonly now?: Date;
  }): Promise<ProposeIntentOutcome> {
    assertAuthorized(input.actor, 'intent.propose', input);
    const requestDigest = digestOf(canonicalProposal(input.proposal));
    const scopeId = targetScope(
      input.workspaceId,
      input.poolId,
      input.strategyId,
      input.proposal.symbol,
    );
    // READ COMMITTED plus the pool row lock is intentional here. A SERIALIZABLE transaction
    // takes its snapshot before waiting for a concurrent holder; after the wait it can still
    // miss the just-committed idempotency row and surface a raw unique violation. The lock is
    // the complete write predicate for one pool, and READ COMMITTED refreshes the statement
    // snapshot after waiting, so every contender observes the winner before deciding.
    return await transactional(this.pool, async (client): Promise<ProposeIntentOutcome> => {
      const market = await currentEpochAndMarket(
        client,
        input.workspaceId,
        input.poolId,
        input.strategyId,
      );
      const replay = await IdempotencyRepository.beginOn(client, {
        scopeKind: 'strategyTarget',
        scopeId,
        key: input.idempotencyKey,
        requestDigest,
      });
      const replayResult = this.replayOutcome(replay);
      if (replayResult !== null) return replayResult;

      const strategy = await client.query(
        `SELECT 1 FROM strategies
          WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND archived_at IS NULL
          FOR UPDATE`,
        [input.workspaceId, input.poolId, input.strategyId],
      );
      if (strategy.rowCount !== 1) {
        violate('IDENTITY_SCOPE_MISMATCH', 'strategy is not active in the requested pool');
      }
      const validated = validateStrategyTarget(
        input.proposal,
        {
          symbol: market.selected_symbol,
          baseAsset: configuredAsset(market.base_asset_code, market.base_asset_scale),
          quoteAsset: configuredAsset(market.quote_asset_code, market.quote_asset_scale),
          maxTargetBaseAtoms: BigInt(market.strategy_max_target_base_atoms),
          activePolicyVersion: BigInt(market.active_policy_version),
        },
        input.now ?? new Date(),
      );
      if (validated.maxQuoteDebit.atoms > BigInt(market.strategy_max_plan_quote_debit_atoms)) {
        violate('POLICY_BUDGET_EXCEEDED', 'target exceeds the strategy per-plan quote debit limit');
      }

      const sameRevision = await client.query<IntentRow>(
        `SELECT intent_id,strategy_revision::text,request_digest,accepted_sequence::text,
                state,is_current,is_next_cohort
           FROM strategy_intents
          WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4
            AND strategy_revision=$5`,
        [
          input.workspaceId,
          input.poolId,
          input.strategyId,
          validated.symbol,
          validated.strategyRevision.toString(),
        ],
      );
      const existingRevision = sameRevision.rows[0];
      if (existingRevision !== undefined) {
        const outcome: ProposeIntentOutcome =
          existingRevision.request_digest !== requestDigest
            ? { ok: false, reason: 'REVISION_CONFLICT' }
            : { ok: true, intent: accepted(existingRevision, true) };
        await this.recordOutcome(client, {
          scopeId,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          outcome,
          economicRef: outcome.ok ? outcome.intent.intentId : null,
        });
        return outcome;
      }

      const latest = await client.query<{ strategy_revision: string }>(
        `SELECT strategy_revision::text FROM strategy_intents
          WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4
          ORDER BY strategy_revision DESC LIMIT 1`,
        [input.workspaceId, input.poolId, input.strategyId, validated.symbol],
      );
      const latestRevision = latest.rows[0]?.strategy_revision;
      if (latestRevision !== undefined && validated.strategyRevision <= BigInt(latestRevision)) {
        const outcome: ProposeIntentOutcome = {
          ok: false,
          reason: 'REVISION_NOT_MONOTONIC',
          currentRevision: latestRevision,
        };
        await this.recordOutcome(client, {
          scopeId,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          outcome,
          economicRef: null,
        });
        return outcome;
      }

      const inFlight = await client.query<{ active: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM plans WHERE workspace_id=$1 AND pool_id=$2
          AND state IN ('SEALED_AWAITING_APPROVAL','APPROVED','DISPATCH_PENDING','EXECUTING',
                        'RECONCILING','MANUAL_REVIEW')) AS active`,
        [input.workspaceId, input.poolId],
      );
      const deferred = await isTargetDeferred(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        strategyId: input.strategyId,
        symbol: validated.symbol,
      });
      const queue = inFlight.rows[0]?.active === true;

      if (queue) {
        await client.query(
          `UPDATE strategy_intents SET state='SUPERSEDED',is_next_cohort=false,updated_at=now()
            WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4 AND is_next_cohort`,
          [input.workspaceId, input.poolId, input.strategyId, validated.symbol],
        );
      } else {
        await client.query(
          `UPDATE strategy_intents SET state='SUPERSEDED',is_current=false,updated_at=now()
            WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4 AND is_current`,
          [input.workspaceId, input.poolId, input.strategyId, validated.symbol],
        );
      }

      const state = deferred ? 'DEFERRED' : queue ? 'QUEUED_NEXT_COHORT' : 'VALIDATED';
      const inserted = await client.query<IntentRow>(
        `INSERT INTO strategy_intents
          (workspace_id,pool_id,epoch,intent_id,strategy_id,symbol,
           base_asset_code,base_asset_scale,quote_asset_code,quote_asset_scale,
           target_base_atoms,max_buy_price,min_sell_price,max_quote_debit_atoms,expires_at,
           strategy_revision,policy_version,idempotency_key,request_digest,state,is_current,is_next_cohort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING intent_id,strategy_revision::text,request_digest,accepted_sequence::text,
                   state,is_current,is_next_cohort`,
        [
          input.workspaceId,
          input.poolId,
          market.epoch,
          validated.intentId,
          input.strategyId,
          validated.symbol,
          validated.targetBase.asset.code,
          validated.targetBase.asset.scaleVersion,
          validated.maxQuoteDebit.asset.code,
          validated.maxQuoteDebit.asset.scaleVersion,
          validated.targetBase.atoms.toString(),
          validated.maxBuyPrice,
          validated.minSellPrice,
          validated.maxQuoteDebit.atoms.toString(),
          validated.expiresAt.toISOString(),
          validated.strategyRevision.toString(),
          validated.policyVersion.toString(),
          input.idempotencyKey,
          requestDigest,
          state,
          !queue,
          queue,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('accepted intent insert returned no row');
      const body = accepted(row, false);
      const outcome: ProposeIntentOutcome = { ok: true, intent: body };
      await this.recordOutcome(client, {
        scopeId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        outcome,
        economicRef: validated.intentId,
      });
      return outcome;
    });
  }

  private replayOutcome(replay: BeginOutcome): ProposeIntentOutcome | null {
    if (replay.kind === 'fresh') return null;
    if (replay.kind === 'conflict') return { ok: false, reason: 'IDEMPOTENCY_CONFLICT' };
    if (replay.kind === 'replay-expired') {
      return { ok: false, reason: 'IDEMPOTENCY_RESPONSE_EXPIRED', intentId: replay.economicRef };
    }
    const body = replay.body as ProposeIntentOutcome;
    return body.ok ? { ok: true, intent: { ...body.intent, replayed: true } } : body;
  }

  private async recordOutcome(
    client: Queryable,
    input: {
      readonly scopeId: string;
      readonly idempotencyKey: string;
      readonly requestDigest: string;
      readonly outcome: ProposeIntentOutcome;
      readonly economicRef: string | null;
    },
  ): Promise<void> {
    await IdempotencyRepository.recordOn(client, {
      scopeKind: 'strategyTarget',
      scopeId: input.scopeId,
      key: input.idempotencyKey,
      requestDigest: input.requestDigest,
      action: 'INTENT_PROPOSE',
      economicRef: input.economicRef,
      status: input.outcome.ok ? 201 : 409,
      body: input.outcome,
      retentionMs: 86_400_000,
    });
  }

  /**
   * Promote the newest queued revision after the previous cohort is terminal.
   * Planner/reconciler callers use this inside the transaction that observes closure.
   */
  static async promoteQueuedOn(
    client: Queryable,
    input: { readonly workspaceId: string; readonly poolId: string },
  ): Promise<number> {
    const active = await client.query(
      `SELECT 1 FROM plans WHERE workspace_id=$1 AND pool_id=$2
        AND state IN ('SEALED_AWAITING_APPROVAL','APPROVED','DISPATCH_PENDING','EXECUTING',
                      'RECONCILING','MANUAL_REVIEW') LIMIT 1`,
      [input.workspaceId, input.poolId],
    );
    if (active.rowCount !== 0) return 0;
    const queued = await client.query<{ strategy_id: string; symbol: string; intent_id: string }>(
      `SELECT strategy_id,symbol,intent_id FROM strategy_intents
        WHERE workspace_id=$1 AND pool_id=$2 AND is_next_cohort
        ORDER BY accepted_sequence,strategy_id,intent_id FOR UPDATE`,
      [input.workspaceId, input.poolId],
    );
    for (const row of queued.rows) {
      await client.query(
        `UPDATE strategy_intents SET state='SUPERSEDED',is_current=false,updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND symbol=$4 AND is_current`,
        [input.workspaceId, input.poolId, row.strategy_id, row.symbol],
      );
      await client.query(
        `UPDATE strategy_intents SET state='VALIDATED',is_current=true,is_next_cohort=false,
                                     updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND intent_id=$3`,
        [input.workspaceId, input.poolId, row.intent_id],
      );
    }
    return queued.rows.length;
  }

  async list(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly actor: Principal;
  }): Promise<readonly AcceptedIntent[]> {
    assertAuthorized(input.actor, 'intent.read', input);
    const result = await this.pool.query<IntentRow>(
      `SELECT intent_id,strategy_revision::text,request_digest,accepted_sequence::text,
              state,is_current,is_next_cohort
         FROM strategy_intents
        WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3
        ORDER BY accepted_sequence,strategy_id,intent_id`,
      [input.workspaceId, input.poolId, input.strategyId],
    );
    return result.rows.map((row) => accepted(row, false));
  }

  async progress(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly strategyId: string;
    readonly actor: Principal;
  }): Promise<TargetProgress | null> {
    assertAuthorized(input.actor, 'intent.read', input);
    const row = await this.pool.query<{
      target_base_atoms: string;
      base_asset_code: string;
      base_asset_scale: string;
      epoch: number;
    }>(
      `SELECT target_base_atoms::text,base_asset_code,base_asset_scale,epoch
         FROM strategy_intents
        WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND is_current`,
      [input.workspaceId, input.poolId, input.strategyId],
    );
    const intent = row.rows[0];
    if (intent === undefined) return null;
    const owned = await this.pool.query<{ atoms: string }>(
      `SELECT coalesce(sum(e.delta_atoms),0)::text AS atoms
         FROM ledger_entries e
         JOIN ledger_transactions t USING (workspace_id,pool_id,ledger_txn_id)
        WHERE e.workspace_id=$1 AND e.pool_id=$2 AND t.epoch=$3
          AND e.account_kind='STRATEGY' AND e.account_owner=$4
          AND e.claim_state IN ('AVAILABLE','RESERVED')
          AND e.asset_code=$5 AND e.asset_scale=$6`,
      [
        input.workspaceId,
        input.poolId,
        intent.epoch,
        input.strategyId,
        intent.base_asset_code,
        intent.base_asset_scale,
      ],
    );
    const commitments = await this.pool.query<{ incoming: string; outgoing: string }>(
      `SELECT
          coalesce(sum(b.base_atoms) FILTER (WHERE b.base_direction='BUY'),0)::text AS incoming,
          coalesce(sum(b.base_atoms) FILTER (WHERE b.base_direction='SELL'),0)::text AS outgoing
         FROM intent_plan_bindings b
         JOIN plans p USING (workspace_id,pool_id,epoch,plan_id)
        WHERE b.workspace_id=$1 AND b.pool_id=$2
          AND b.intent_id=(SELECT intent_id FROM strategy_intents
                            WHERE workspace_id=$1 AND pool_id=$2 AND strategy_id=$3 AND is_current)
          AND p.state IN ('SEALED_AWAITING_APPROVAL','APPROVED','DISPATCH_PENDING','EXECUTING',
                          'RECONCILING','MANUAL_REVIEW')`,
      [input.workspaceId, input.poolId, input.strategyId],
    );
    const asset = configuredAsset(intent.base_asset_code, intent.base_asset_scale);
    return targetProgress({
      target: { kind: 'AssetAmount', asset, atoms: BigInt(intent.target_base_atoms) },
      owned: { kind: 'AssetAmount', asset, atoms: BigInt(owned.rows[0]?.atoms ?? '0') },
      incomingCommittedAtoms: BigInt(commitments.rows[0]?.incoming ?? '0'),
      outgoingCommittedAtoms: BigInt(commitments.rows[0]?.outgoing ?? '0'),
    });
  }
}
