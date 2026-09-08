import type { Pool } from 'pg';
import {
  assertFeePolicyDispatchable,
  feePolicy,
  formatAssetKey,
  planDigest,
  planDigestPayload,
  violate,
  type AssetKey,
  type FeeBoundEvidence,
  type SealedPlanPayload,
} from '@capitaldesk/contracts';
import { assertAuthorized, type Principal } from '@capitaldesk/domain';
import { requireAuthorityPool } from './dispatch.js';
import { LedgerRepository } from './ledger.js';
import { OutboxRepository } from './outbox.js';
import { serializable, type Queryable } from './transaction.js';

export interface SealReservation {
  readonly reservationId: string;
  readonly strategyId: string;
  readonly asset: AssetKey;
  readonly atoms: bigint;
}

export interface VerifiedVenueCapacity {
  readonly evidenceId: string;
  readonly complete: boolean;
  readonly free: readonly { readonly asset: AssetKey; readonly atoms: bigint }[];
}

export type SealOutcome =
  | {
      readonly ok: true;
      readonly planId: string;
      readonly digest: string;
      readonly ledgerRevision: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'STALE_PREVIEW'
        | 'POLICY_VERSION_STALE'
        | 'PLAN_IN_FLIGHT_FOR_POOL'
        | 'INTENT_ALREADY_SEALED'
        | 'INSUFFICIENT_STRATEGY_CLAIM'
        | 'INSUFFICIENT_VENUE_CAPACITY'
        | 'POLICY_BUDGET_EXCEEDED'
        | 'AUTHORITY_UNAVAILABLE';
    };

function capacityKey(asset: AssetKey): string {
  return formatAssetKey(asset);
}

async function availableClaim(
  client: Queryable,
  input: {
    workspaceId: string;
    poolId: string;
    epoch: number;
    strategyId: string;
    asset: AssetKey;
  },
): Promise<bigint> {
  const result = await client.query<{ atoms: string }>(
    `SELECT coalesce(sum(delta_atoms),0)::text AS atoms FROM ledger_entries
      WHERE workspace_id=$1 AND pool_id=$2 AND epoch=$3 AND account_owner=$4
        AND asset_code=$5 AND asset_scale=$6 AND claim_state='AVAILABLE'`,
    [
      input.workspaceId,
      input.poolId,
      input.epoch,
      input.strategyId,
      input.asset.code,
      input.asset.scaleVersion,
    ],
  );
  return BigInt(result.rows[0]?.atoms ?? '0');
}

async function holdBuyBudgets(
  client: Queryable,
  input: {
    workspaceId: string;
    poolId: string;
    policyVersion: string;
    utcBucket: string;
    payload: SealedPlanPayload;
    reservations: readonly SealReservation[];
  },
): Promise<'POLICY_BUDGET_EXCEEDED' | null> {
  if (input.payload.side !== 'BUY') return null;
  for (const cap of [...input.payload.strategyCaps].sort((a, b) =>
    a.strategyId.localeCompare(b.strategyId),
  )) {
    const quoteReservation = input.reservations.find(
      (entry) =>
        entry.strategyId === cap.strategyId &&
        capacityKey(entry.asset) === capacityKey(cap.maxDebit.asset),
    );
    if (quoteReservation === undefined || quoteReservation.atoms < cap.maxDebit.atoms) {
      violate('PLAN_INSUFFICIENT_CLAIM', 'BUY cap is not backed by its strategy quote reservation');
    }
    const limits = await client.query<{ strategy_limit: string; pool_limit: string }>(
      `SELECT s.max_daily_gross_buy_quote_atoms::text strategy_limit,
              p.max_daily_gross_buy_quote_atoms::text pool_limit
         FROM strategy_policy_limits s JOIN policy_versions p
           USING (workspace_id,pool_id,policy_version)
        WHERE s.workspace_id=$1 AND s.pool_id=$2 AND s.policy_version=$3 AND s.strategy_id=$4`,
      [input.workspaceId, input.poolId, input.policyVersion, cap.strategyId],
    );
    const limit = limits.rows[0];
    if (limit === undefined) return 'POLICY_BUDGET_EXCEEDED';
    const used = await client.query<{ strategy_used: string; pool_used: string }>(
      `SELECT coalesce(sum(CASE WHEN strategy_id=$4 THEN
                CASE WHEN state='HELD' THEN max_quote_debit_atoms ELSE consumed_quote_atoms END ELSE 0 END),0)::text strategy_used,
              coalesce(sum(CASE WHEN state='HELD' THEN max_quote_debit_atoms ELSE consumed_quote_atoms END),0)::text pool_used
         FROM policy_budget_holds
        WHERE workspace_id=$1 AND pool_id=$2 AND utc_bucket=$3 AND state IN ('HELD','CONSUMED')`,
      [input.workspaceId, input.poolId, input.utcBucket, cap.strategyId],
    );
    const totals = used.rows[0];
    if (
      BigInt(totals?.strategy_used ?? '0') + cap.maxDebit.atoms > BigInt(limit.strategy_limit) ||
      BigInt(totals?.pool_used ?? '0') + cap.maxDebit.atoms > BigInt(limit.pool_limit)
    )
      return 'POLICY_BUDGET_EXCEEDED';
    await client.query(
      `INSERT INTO policy_budget_holds
        (workspace_id,pool_id,policy_version,strategy_id,budget_ref,utc_bucket,max_quote_debit_atoms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.workspaceId,
        input.poolId,
        input.policyVersion,
        cap.strategyId,
        quoteReservation.reservationId,
        input.utcBucket,
        cap.maxDebit.atoms.toString(),
      ],
    );
  }
  return null;
}

/** Seal the complete owner-review payload and every capital hold in one serializable commit. */
export class SealingRepository {
  constructor(private readonly pool: Pool) {}

  seal(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly planId: string;
    readonly payload: SealedPlanPayload;
    readonly expectedLedgerRevision: number;
    readonly expectedPolicyVersion: string;
    readonly reservations: readonly SealReservation[];
    readonly venueCapacity: VerifiedVenueCapacity;
    readonly feeBoundEvidence: FeeBoundEvidence | null;
    readonly verifiedAccountSettings: readonly string[];
    readonly actor: Principal;
  }): Promise<SealOutcome> {
    assertAuthorized(input.actor, 'plan.seal', input);
    if (!input.venueCapacity.complete) {
      violate('OBSERVATION_COVERAGE_INCOMPLETE', 'venue free-capacity evidence is incomplete');
    }
    const digest = planDigest(input.payload);
    if (input.payload.mandatePolicyVersion !== input.expectedPolicyVersion) {
      violate('POLICY_MANDATE_VERSION_STALE', 'payload policy version differs from seal request');
    }
    return serializable(this.pool, async (client): Promise<SealOutcome> => {
      const authority = await requireAuthorityPool(client, input);
      if (!authority.ok) return { ok: false, reason: 'AUTHORITY_UNAVAILABLE' };
      const pool = await client.query<{
        ledger_revision: string;
        active_policy_version: string | null;
        environment: 'local' | 'testnet' | 'production';
        venue: string;
        stable_account_id: string;
      }>(
        `SELECT ledger_revision::text,active_policy_version::text,environment,venue,stable_account_id FROM pools
          WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE`,
        [input.workspaceId, input.poolId],
      );
      const poolRow = pool.rows[0];
      if (
        poolRow === undefined ||
        Number(poolRow.ledger_revision) !== input.expectedLedgerRevision ||
        input.payload.baselineLedgerRevision !== input.expectedLedgerRevision
      ) {
        return { ok: false, reason: 'STALE_PREVIEW' };
      }
      if (
        input.payload.pool.workspaceId !== input.workspaceId ||
        input.payload.pool.baselineEpoch < 1 ||
        input.payload.pool.account.venue !== poolRow.venue ||
        input.payload.pool.account.environment !== poolRow.environment ||
        input.payload.pool.account.stableAccountId !== poolRow.stable_account_id
      ) {
        violate(
          'IDENTITY_SCOPE_MISMATCH',
          'sealed payload does not name the governed pool account',
        );
      }
      const currentEpoch = await client.query<{ epoch: number }>(
        `SELECT epoch FROM baseline_epochs WHERE workspace_id=$1 AND pool_id=$2 AND closed_at IS NULL`,
        [input.workspaceId, input.poolId],
      );
      if (currentEpoch.rows[0]?.epoch !== input.payload.pool.baselineEpoch) {
        return { ok: false, reason: 'STALE_PREVIEW' };
      }
      if (poolRow.active_policy_version !== input.expectedPolicyVersion) {
        return { ok: false, reason: 'POLICY_VERSION_STALE' };
      }
      assertFeePolicyDispatchable(
        feePolicy(input.payload.feePolicyVersion),
        poolRow.environment,
        input.feeBoundEvidence,
        input.verifiedAccountSettings,
      );
      const inFlight = await client.query(
        `SELECT 1 FROM plans WHERE workspace_id=$1 AND pool_id=$2 AND state IN
          ('SEALED_AWAITING_APPROVAL','APPROVED','DISPATCH_PENDING','EXECUTING','RECONCILING','MANUAL_REVIEW')`,
        [input.workspaceId, input.poolId],
      );
      if ((inFlight.rowCount ?? 0) > 0) return { ok: false, reason: 'PLAN_IN_FLIGHT_FOR_POOL' };
      const intentIds = input.payload.allocation.map((entry) => entry.intentId);
      if (new Set(intentIds).size !== intentIds.length)
        violate('IDENTITY_MALFORMED', 'plan repeats an intent');
      const intentRows = await client.query<{
        intent_id: string;
        strategy_revision: string;
        accepted_sequence: string;
      }>(
        `SELECT intent_id,strategy_revision::text,accepted_sequence::text FROM strategy_intents
          WHERE workspace_id=$1 AND pool_id=$2 AND epoch=$3 AND intent_id=ANY($4::text[])
            AND is_current AND state='VALIDATED' FOR UPDATE`,
        [input.workspaceId, input.poolId, input.payload.pool.baselineEpoch, intentIds],
      );
      if (intentRows.rowCount !== intentIds.length) return { ok: false, reason: 'STALE_PREVIEW' };
      const rows = new Map(intentRows.rows.map((row) => [row.intent_id, row]));
      for (const allocation of input.payload.allocation) {
        const row = rows.get(allocation.intentId);
        if (
          row === undefined ||
          BigInt(row.strategy_revision) !== BigInt(allocation.intentRevision) ||
          BigInt(row.accepted_sequence) > BigInt(input.payload.cohortClosedAtSequence)
        ) {
          return { ok: false, reason: 'STALE_PREVIEW' };
        }
      }
      const already = await client.query(
        `SELECT 1 FROM intent_plan_bindings WHERE workspace_id=$1 AND pool_id=$2 AND intent_id=ANY($3::text[])`,
        [input.workspaceId, input.poolId, intentIds],
      );
      if ((already.rowCount ?? 0) > 0) return { ok: false, reason: 'INTENT_ALREADY_SEALED' };

      const ordered = [...input.reservations].sort((a, b) =>
        a.strategyId === b.strategyId
          ? capacityKey(a.asset).localeCompare(capacityKey(b.asset))
          : a.strategyId.localeCompare(b.strategyId),
      );
      if (new Set(ordered.map((item) => item.reservationId)).size !== ordered.length) {
        violate('IDENTITY_MALFORMED', 'reservation ids must be unique');
      }
      const venueRemaining = new Map(
        input.venueCapacity.free.map((item) => [capacityKey(item.asset), item.atoms]),
      );
      for (const reservation of ordered) {
        if (reservation.atoms <= 0n)
          violate('MONEY_NEGATIVE_RESULT', 'reservation must be positive');
        if (
          (await availableClaim(client, {
            workspaceId: input.workspaceId,
            poolId: input.poolId,
            epoch: input.payload.pool.baselineEpoch,
            strategyId: reservation.strategyId,
            asset: reservation.asset,
          })) < reservation.atoms
        )
          return { ok: false, reason: 'INSUFFICIENT_STRATEGY_CLAIM' };
        const key = capacityKey(reservation.asset);
        const free = venueRemaining.get(key) ?? 0n;
        if (free < reservation.atoms) return { ok: false, reason: 'INSUFFICIENT_VENUE_CAPACITY' };
        venueRemaining.set(key, free - reservation.atoms);
      }

      const budgetRefusal = await holdBuyBudgets(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        policyVersion: input.expectedPolicyVersion,
        utcBucket: input.payload.submissionDeadlineAt.slice(0, 10),
        payload: input.payload,
        reservations: ordered,
      });
      if (budgetRefusal !== null) return { ok: false, reason: budgetRefusal };

      await client.query(
        `INSERT INTO plans (workspace_id,pool_id,epoch,plan_id,state,payload,payload_digest)
         VALUES ($1,$2,$3,$4,'SEALED_AWAITING_APPROVAL',$5::jsonb,$6)`,
        [
          input.workspaceId,
          input.poolId,
          input.payload.pool.baselineEpoch,
          input.planId,
          JSON.stringify(planDigestPayload(input.payload)),
          digest,
        ],
      );
      await client.query(
        `INSERT INTO plan_seals
          (workspace_id,pool_id,epoch,plan_id,preview_digest,source_ledger_revision,
           policy_version,cohort_closed_at_sequence,venue_capacity_evidence_id,venue_capacity_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          input.workspaceId,
          input.poolId,
          input.payload.pool.baselineEpoch,
          input.planId,
          digest,
          input.expectedLedgerRevision,
          input.expectedPolicyVersion,
          input.payload.cohortClosedAtSequence,
          input.venueCapacity.evidenceId,
          JSON.stringify(
            input.venueCapacity.free.map((item) => ({
              asset: capacityKey(item.asset),
              atoms: item.atoms.toString(),
            })),
          ),
        ],
      );
      for (const allocation of input.payload.allocation) {
        await client.query(
          `INSERT INTO intent_plan_bindings
            (workspace_id,pool_id,epoch,intent_id,plan_id,base_direction,base_atoms)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.workspaceId,
            input.poolId,
            input.payload.pool.baselineEpoch,
            allocation.intentId,
            input.planId,
            input.payload.side,
            allocation.requestedGrossBase.atoms.toString(),
          ],
        );
        await client.query(
          `UPDATE strategy_intents SET state='PLANNED',is_current=false,updated_at=now()
            WHERE workspace_id=$1 AND pool_id=$2 AND intent_id=$3`,
          [input.workspaceId, input.poolId, allocation.intentId],
        );
      }
      let revision = input.expectedLedgerRevision;
      for (const reservation of ordered) {
        await client.query(
          `INSERT INTO reservations
            (workspace_id,pool_id,epoch,reservation_id,strategy_id,plan_id,asset_code,asset_scale,reserved_atoms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.workspaceId,
            input.poolId,
            input.payload.pool.baselineEpoch,
            reservation.reservationId,
            reservation.strategyId,
            input.planId,
            reservation.asset.code,
            reservation.asset.scaleVersion,
            reservation.atoms.toString(),
          ],
        );
        const posted = await LedgerRepository.postOn(client, {
          workspaceId: input.workspaceId,
          poolId: input.poolId,
          epoch: input.payload.pool.baselineEpoch,
          ledgerTxnId: `txn-reserve-${reservation.reservationId}`,
          source: { kind: 'reserve', ref: reservation.reservationId },
          description: `seal ${input.planId}`,
          entries: [
            {
              accountKind: 'STRATEGY',
              owner: reservation.strategyId,
              claimState: 'AVAILABLE',
              asset: { code: reservation.asset.code, scale: reservation.asset.scaleVersion },
              deltaAtoms: -reservation.atoms,
            },
            {
              accountKind: 'STRATEGY',
              owner: reservation.strategyId,
              claimState: 'RESERVED',
              asset: { code: reservation.asset.code, scale: reservation.asset.scaleVersion },
              deltaAtoms: reservation.atoms,
              reservationId: reservation.reservationId,
            },
          ],
        });
        if (!posted.ok) throw new Error(`atomic reservation failed: ${posted.reason}`);
        revision = posted.revision;
      }
      await OutboxRepository.enqueueOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        outboxId: `sealed-${input.planId}`,
        kind: 'plan.sealed',
        payload: { planId: input.planId, digest },
      });
      return { ok: true, planId: input.planId, digest, ledgerRevision: revision };
    });
  }
}
