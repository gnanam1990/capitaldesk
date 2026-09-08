import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  assessBaselineReadiness,
  authorizeAllocation,
  openingFromSnapshot,
  type AllocationActor,
  type BaselineAssessment,
  type BaselinePreconditions,
  type OpeningPosition,
  type SnapshotBalance,
  type SupportedAssets,
} from '@capitaldesk/ledger';
import { formatAssetKey, type AssetKey } from '@capitaldesk/contracts';
import { LedgerRepository, type AssetRef } from './ledger.js';
import { serializable, type Queryable } from './transaction.js';

/**
 * The baseline and owner-allocation service (module 06).
 *
 * Both operations are single transactions by necessity rather than by preference. A baseline
 * that posted its opening balances and then failed to record itself would be an opening nobody
 * could name, and one that recorded itself without the postings would be a claim to an opening
 * that never happened. An allocation is the same shape: the postings look like any other claim
 * transfer, and only the record says an owner authorised it.
 *
 * The rules live in `@capitaldesk/ledger` and are evaluated here against facts read under the
 * same lock the postings take, so nothing can change between deciding and writing.
 */

/** The asset shape the ledger postings use, which carries `scale` rather than `scaleVersion`. */
function assetRefOf(asset: AssetKey): AssetRef {
  return { code: asset.code, scale: asset.scaleVersion };
}

export interface BootstrapInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly baselineId: string;
  /**
   * The observation cut this opening is taken from.
   *
   * The opening amounts are *derived* from that cut's closing snapshot inside this
   * transaction. There is deliberately no `balances` argument: a caller that named a cut and
   * then stated its own balances could state anything, and the first version of this service
   * accepted an opening of 1000 against a snapshot holding nothing.
   */
  readonly cutId: string;
  readonly supported: SupportedAssets;
  /** Assets deliberately excluded, kept visible for T-042. */
  readonly excludedAssets: readonly string[];
}

export type BootstrapOutcome =
  | { readonly ok: true; readonly baselineId: string; readonly ledgerTxnId: string | null }
  | { readonly ok: false; readonly reason: 'NOT_READY'; readonly assessment: BaselineAssessment }
  | { readonly ok: false; readonly reason: 'UNKNOWN_POOL' }
  | { readonly ok: false; readonly reason: 'UNKNOWN_CUT' }
  /** The same baseline id, already established from the same cut. Replay, not a conflict. */
  | {
      readonly ok: true;
      readonly baselineId: string;
      readonly ledgerTxnId: string;
      readonly replayed: true;
    }
  /** The same baseline id claiming a different opening. Immutable facts do not change. */
  | { readonly ok: false; readonly reason: 'BASELINE_CONFLICT'; readonly storedCutId: string };

export interface AllocationInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly allocationId: string;
  readonly actor: AllocationActor;
  /** The owner session that authorised it, for provenance. */
  readonly authorizedBy: string;
  readonly from: string;
  readonly to: string;
  readonly asset: AssetKey;
  readonly atoms: bigint;
}

export type AllocationOutcome =
  | { readonly ok: true; readonly revision: number; readonly ledgerTxnId: string }
  | {
      readonly ok: true;
      readonly revision: number;
      readonly ledgerTxnId: string;
      readonly replayed: true;
    }
  | { readonly ok: false; readonly reason: 'UNAUTHORIZED'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ALLOCATION_CONFLICT' }
  | { readonly ok: false; readonly reason: 'NO_BASELINE' };

export class BaselineRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Establish the opening position, or refuse and say why.
   *
   * Preconditions are read under the pool lock, so the lease, the epoch and the cut cannot
   * change between the decision and the postings. Every opening unit is credited to HOUSE:
   * inventory belongs to the owner until the owner allocates it, never to whichever strategy
   * happens to trade the same symbol.
   */
  bootstrap(input: BootstrapInput): Promise<BootstrapOutcome> {
    return serializable(this.pool, async (client): Promise<BootstrapOutcome> => {
      const pool = await client.query<{
        stable_account_id: string;
        environment: string;
      }>(
        `SELECT stable_account_id, environment FROM pools
          WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE`,
        [input.workspaceId, input.poolId],
      );
      const poolRow = pool.rows[0];
      if (poolRow === undefined) return { ok: false, reason: 'UNKNOWN_POOL' };

      // A replay of the same request is the same answer, not a second opening — and "the same
      // request" means every immutable fact, not just the id. Comparing the cut alone let a
      // caller replay with a different supported set or different exclusions and silently
      // rewrite what the baseline claims to cover.
      const existing = await client.query<{
        cut_id: string;
        epoch: number;
        ledger_txn_id: string | null;
        supported_assets: string[];
        excluded_assets: string[];
      }>(
        `SELECT cut_id, epoch, ledger_txn_id, supported_assets, excluded_assets
           FROM account_baselines
          WHERE workspace_id = $1 AND pool_id = $2 AND baseline_id = $3`,
        [input.workspaceId, input.poolId, input.baselineId],
      );
      const stored = existing.rows[0];
      if (stored !== undefined) {
        const sameRequest =
          stored.cut_id === input.cutId &&
          stored.epoch === input.epoch &&
          sameStrings(stored.supported_assets, input.supported.assets.map(formatAssetKey)) &&
          sameStrings(stored.excluded_assets, input.excludedAssets);
        return sameRequest
          ? {
              ok: true,
              replayed: true,
              baselineId: input.baselineId,
              ledgerTxnId: stored.ledger_txn_id,
            }
          : { ok: false, reason: 'BASELINE_CONFLICT', storedCutId: stored.cut_id };
      }

      // The closing snapshot is read here, inside the same transaction that will post from
      // it, so nothing can change between the evidence and the entries it produces.
      const evidence = await readCutEvidence(client, input);
      if (evidence === null) return { ok: false, reason: 'UNKNOWN_CUT' };

      const opening = openingFromSnapshot(evidence.balances, input.supported);
      const preconditions = readinessFrom(input, poolRow, evidence, opening);
      const assessment = assessBaselineReadiness(preconditions, input.supported);
      if (!assessment.ready) return { ok: false, reason: 'NOT_READY', assessment };

      // Opening balances post to ASSET_CONTROL and matching HOUSE claims, per asset. Nothing
      // balances across assets: each asset's control and claim entries sum to zero on their
      // own, which is what the deferred trigger from module 04 enforces at COMMIT.
      const ledgerTxnId = ledgerTxnIdFor('baseline', input.baselineId);
      const entries = opening.flatMap((balance) => [
        {
          accountKind: 'ASSET_CONTROL' as const,
          owner: 'ASSET_CONTROL',
          claimState: 'CONTROL' as const,
          asset: assetRefOf(balance.asset),
          deltaAtoms: balance.atoms,
        },
        {
          accountKind: 'HOUSE' as const,
          owner: 'HOUSE',
          claimState: 'AVAILABLE' as const,
          asset: assetRefOf(balance.asset),
          deltaAtoms: balance.atoms,
        },
      ]);

      // An account holding nothing still gets a baseline — "the opening was zero" is a fact,
      // and without it the next reader cannot tell it from "never taken" — but it posts no
      // ledger transaction, because there is nothing to post. The record's `ledger_txn_id` is
      // null in that case rather than naming an empty transaction.
      if (entries.length > 0) {
        const posted = await LedgerRepository.postOn(client, {
          workspaceId: input.workspaceId,
          poolId: input.poolId,
          epoch: input.epoch,
          ledgerTxnId,
          source: { kind: 'baseline', ref: input.baselineId },
          description: `opening baseline from cut ${input.cutId}`,
          entries,
        });
        if (!posted.ok) {
          // The ledger refused. No recovery preserves the opening's meaning, so the whole
          // transaction fails and nothing is written.
          throw new Error(`baseline postings refused: ${posted.reason}`);
        }
      }
      const postedTxnId = entries.length > 0 ? ledgerTxnId : null;

      await client.query(
        `INSERT INTO account_baselines
           (workspace_id, pool_id, epoch, baseline_id, stable_account_id, environment, cut_id,
            ledger_txn_id, supported_assets, excluded_assets, cost_basis_known)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.baselineId,
          poolRow.stable_account_id,
          poolRow.environment,
          input.cutId,
          postedTxnId,
          JSON.stringify(input.supported.assets.map(formatAssetKey)),
          JSON.stringify([...input.excludedAssets]),
          // A baseline taken from a balance snapshot knows what is held, not what it cost.
          // Saying so is the point: T-042 forbids presenting an incomplete basis as complete.
          false,
        ],
      );

      return { ok: true, baselineId: input.baselineId, ledgerTxnId: postedTxnId };
    });
  }

  /**
   * Move an AVAILABLE claim between HOUSE and one strategy.
   *
   * Availability is read under the pool lock and the authorization is decided against those
   * values, so two concurrent allocations cannot both spend the same HOUSE balance.
   */
  allocate(input: AllocationInput): Promise<AllocationOutcome> {
    return serializable(this.pool, async (client): Promise<AllocationOutcome> => {
      await client.query(
        'SELECT 1 FROM pools WHERE workspace_id = $1 AND pool_id = $2 FOR UPDATE',
        [input.workspaceId, input.poolId],
      );

      const existing = await client.query<{
        revision: number;
        epoch: number;
        ledger_txn_id: string;
        from_owner: string;
        to_owner: string;
        atoms: string;
        asset_code: string;
        asset_scale: string;
        authorized_by: string;
      }>(
        `SELECT revision, epoch, ledger_txn_id, from_owner, to_owner, atoms::text, asset_code,
                asset_scale, authorized_by
           FROM owner_allocations
          WHERE workspace_id = $1 AND pool_id = $2 AND allocation_id = $3`,
        [input.workspaceId, input.poolId, input.allocationId],
      );
      const stored = existing.rows[0];
      if (stored !== undefined) {
        const same =
          stored.epoch === input.epoch &&
          stored.from_owner === input.from &&
          stored.to_owner === input.to &&
          stored.asset_code === input.asset.code &&
          stored.asset_scale === input.asset.scaleVersion &&
          BigInt(stored.atoms) === input.atoms &&
          // The authorising session is part of what was decided. A replay under a different
          // authorisation is a different decision wearing the same id.
          stored.authorized_by === input.authorizedBy;
        // Same id, same facts is a replay. Same id, different facts is a caller contradicting
        // itself, and the recorded decision does not change.
        return same
          ? {
              ok: true,
              replayed: true,
              revision: stored.revision,
              ledgerTxnId: stored.ledger_txn_id,
            }
          : { ok: false, reason: 'ALLOCATION_CONFLICT' };
      }

      const baseline = await client.query(
        `SELECT 1 FROM account_baselines
          WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3`,
        [input.workspaceId, input.poolId, input.epoch],
      );
      // Allocating before an opening exists would credit a strategy from a HOUSE balance that
      // was never established.
      if (baseline.rowCount !== 1) return { ok: false, reason: 'NO_BASELINE' };

      const strategyId = input.from === 'HOUSE' ? input.to : input.from;
      const active = await client.query(
        `SELECT 1 FROM strategies
          WHERE workspace_id = $1 AND pool_id = $2 AND strategy_id = $3 AND archived_at IS NULL`,
        [input.workspaceId, input.poolId, strategyId],
      );

      const [houseAvailableAtoms, strategyAvailableAtoms] = await Promise.all([
        availableOf(client, input, 'HOUSE'),
        availableOf(client, input, strategyId),
      ]);

      const authorization = authorizeAllocation({
        actor: input.actor,
        from: input.from,
        to: input.to,
        asset: input.asset,
        atoms: input.atoms,
        houseAvailableAtoms,
        strategyAvailableAtoms,
        strategyIsActive: active.rowCount === 1,
      });
      if (!authorization.ok) {
        return { ok: false, reason: 'UNAUTHORIZED', detail: authorization.reason };
      }

      const revision = await nextRevision(client, input);
      const ledgerTxnId = ledgerTxnIdFor('allocation', input.allocationId);
      const posted = await LedgerRepository.postOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        epoch: input.epoch,
        ledgerTxnId,
        source: { kind: 'owner-allocation', ref: input.allocationId },
        description: `internal budget allocation ${input.from} to ${input.to}`,
        entries: [
          {
            accountKind: input.from === 'HOUSE' ? 'HOUSE' : 'STRATEGY',
            owner: input.from,
            claimState: 'AVAILABLE',
            asset: assetRefOf(input.asset),
            deltaAtoms: -input.atoms,
          },
          {
            accountKind: input.to === 'HOUSE' ? 'HOUSE' : 'STRATEGY',
            owner: input.to,
            claimState: 'AVAILABLE',
            asset: assetRefOf(input.asset),
            deltaAtoms: input.atoms,
          },
        ],
      });
      if (!posted.ok) throw new Error(`allocation postings refused: ${posted.reason}`);

      await client.query(
        `INSERT INTO owner_allocations
           (workspace_id, pool_id, epoch, allocation_id, revision, from_owner, to_owner,
            asset_code, asset_scale, atoms, authorized_by, ledger_txn_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.allocationId,
          revision,
          input.from,
          input.to,
          input.asset.code,
          input.asset.scaleVersion,
          input.atoms.toString(),
          input.authorizedBy,
          ledgerTxnId,
        ],
      );

      return { ok: true, revision, ledgerTxnId };
    });
  }

  /** The baseline for one pool and epoch, with its coverage disclosures. */
  async baseline(scope: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
  }): Promise<{
    readonly baselineId: string;
    readonly stableAccountId: string;
    readonly cutId: string;
    readonly supportedAssets: readonly string[];
    readonly excludedAssets: readonly string[];
    readonly costBasisKnown: boolean;
  } | null> {
    const result = await this.pool.query<{
      baseline_id: string;
      stable_account_id: string;
      cut_id: string;
      supported_assets: string[];
      excluded_assets: string[];
      cost_basis_known: boolean;
    }>(
      `SELECT baseline_id, stable_account_id, cut_id, supported_assets, excluded_assets,
              cost_basis_known
         FROM account_baselines
        WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3`,
      [scope.workspaceId, scope.poolId, scope.epoch],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          baselineId: row.baseline_id,
          stableAccountId: row.stable_account_id,
          cutId: row.cut_id,
          supportedAssets: row.supported_assets,
          excludedAssets: row.excluded_assets,
          costBasisKnown: row.cost_basis_known,
        };
  }
}

/** The AVAILABLE claim of one owner in one asset, summed from immutable entries. */
async function availableOf(
  client: Queryable,
  input: AllocationInput,
  owner: string,
): Promise<bigint> {
  // Scoped to the epoch being allocated in. A closed epoch's claims are history: after a
  // reset they must not fund anything, and summing across epochs let exactly that happen.
  const result = await client.query<{ atoms: string }>(
    `SELECT coalesce(sum(delta_atoms), 0)::text AS atoms FROM ledger_entries
      WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $6 AND account_owner = $3
        AND claim_state = 'AVAILABLE' AND asset_code = $4 AND asset_scale = $5`,
    [
      input.workspaceId,
      input.poolId,
      owner,
      input.asset.code,
      input.asset.scaleVersion,
      input.epoch,
    ],
  );
  return BigInt(result.rows[0]?.atoms ?? '0');
}

async function nextRevision(client: Queryable, input: AllocationInput): Promise<number> {
  const result = await client.query<{ next: string }>(
    `SELECT coalesce(max(revision), 0) + 1 AS next FROM owner_allocations
      WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3`,
    [input.workspaceId, input.poolId, input.epoch],
  );
  return Number(result.rows[0]?.next ?? 1);
}

/** Two string lists carrying the same members, order-insensitively. */
function sameStrings(stored: readonly string[], incoming: readonly string[]): boolean {
  if (stored.length !== incoming.length) return false;
  const a = [...stored].sort();
  const b = [...incoming].sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * A bounded, deterministic ledger transaction id.
 *
 * `ledger_txn_id` is capped at 64 characters by its shape CHECK, and a baseline or allocation
 * id may itself be 64. Prefixing alone overflowed that for a long id, and the insert then
 * failed after the evidence had already been read. The long form keeps a digest of the whole
 * id, which also keeps two ids sharing a prefix distinct.
 */
export function ledgerTxnIdFor(prefix: 'baseline' | 'allocation', id: string): string {
  const plain = `${prefix}-${id}`;
  if (plain.length <= 64) return plain;
  const digest = createHash('sha256').update(plain).digest('hex').slice(0, 16);
  return `${plain.slice(0, 64 - 17)}-${digest}`;
}

/** The cut, its closing snapshot and the pool facts the readiness predicate needs. */
interface CutEvidence {
  readonly coverageState: BaselinePreconditions['coverageState'];
  readonly detectionScope: BaselinePreconditions['detectionScope'];
  readonly snapshotAccountId: string;
  readonly closingSnapshotId: string;
  readonly balances: readonly SnapshotBalance[];
  readonly openEpoch: number;
  readonly epochClosed: boolean;
  readonly holdsGovernanceLease: boolean;
  readonly unknownOpenOrders: number;
  readonly alreadyBootstrapped: boolean;
}

/**
 * Everything the decision rests on, read under the caller's lock.
 *
 * The closing snapshot's own balances come back with it, so the opening is derived from the
 * same row the cut names rather than from anything the caller supplied.
 */
async function readCutEvidence(
  client: Queryable,
  input: BootstrapInput,
): Promise<CutEvidence | null> {
  const cut = await client.query<{
    coverage_state: string;
    detection_scope: string;
    stable_account_id: string;
    snapshot_id: string;
    balances: SnapshotBalance[];
  }>(
    `SELECT c.coverage_state, c.detection_scope, s.stable_account_id, s.snapshot_id, s.balances
       FROM venue_observation_cuts c
       JOIN venue_account_snapshots s
         ON s.workspace_id = c.workspace_id AND s.pool_id = c.pool_id
        AND s.epoch = c.epoch AND s.snapshot_id = c.closing_snapshot_id
      WHERE c.workspace_id = $1 AND c.pool_id = $2 AND c.epoch = $3 AND c.cut_id = $4
      FOR SHARE OF c, s`,
    [input.workspaceId, input.poolId, input.epoch, input.cutId],
  );
  const row = cut.rows[0];
  if (row === undefined) return null;

  const epoch = await client.query<{ epoch: number; closed_at: Date | null }>(
    `SELECT epoch, closed_at FROM baseline_epochs
      WHERE workspace_id = $1 AND pool_id = $2
      ORDER BY (closed_at IS NULL) DESC, epoch DESC LIMIT 1`,
    [input.workspaceId, input.poolId],
  );
  const epochRow = epoch.rows[0];

  const lease = await client.query(
    `SELECT 1 FROM governance_leases
      WHERE workspace_id = $1 AND pool_id = $2 AND released_at IS NULL`,
    [input.workspaceId, input.poolId],
  );

  // An unknown resting order is one the journal never marked. Adopting the inventory it would
  // move means inventing an owner for it.
  const unknown = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM venue_orders o
      WHERE o.workspace_id = $1 AND o.pool_id = $2 AND o.epoch = $3
        AND o.status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL')
        AND o.client_order_id IS NULL`,
    [input.workspaceId, input.poolId, input.epoch],
  );

  const bootstrapped = await client.query(
    `SELECT 1 FROM account_baselines
      WHERE workspace_id = $1 AND pool_id = $2 AND epoch = $3`,
    [input.workspaceId, input.poolId, input.epoch],
  );

  return {
    coverageState: row.coverage_state as BaselinePreconditions['coverageState'],
    detectionScope: row.detection_scope as BaselinePreconditions['detectionScope'],
    snapshotAccountId: row.stable_account_id,
    closingSnapshotId: row.snapshot_id,
    balances: row.balances,
    openEpoch: epochRow?.epoch ?? -1,
    epochClosed: epochRow?.closed_at !== null && epochRow?.closed_at !== undefined,
    holdsGovernanceLease: lease.rowCount === 1,
    unknownOpenOrders: Number(unknown.rows[0]?.count ?? '0'),
    alreadyBootstrapped: bootstrapped.rowCount === 1,
  };
}

/** The readiness inputs, assembled from evidence rather than from the request. */
function readinessFrom(
  input: BootstrapInput,
  poolRow: { stable_account_id: string; environment: string },
  evidence: CutEvidence,
  opening: readonly OpeningPosition[],
): BaselinePreconditions {
  return {
    coverageState: evidence.coverageState,
    detectionScope: evidence.detectionScope,
    cutStableAccountId: evidence.snapshotAccountId,
    poolStableAccountId: poolRow.stable_account_id,
    cutEnvironment: poolRow.environment as BaselinePreconditions['cutEnvironment'],
    poolEnvironment: poolRow.environment as BaselinePreconditions['poolEnvironment'],
    cutEpoch: input.epoch,
    openEpoch: evidence.openEpoch,
    epochClosed: evidence.epochClosed,
    holdsGovernanceLease: evidence.holdsGovernanceLease,
    unknownOpenOrders: evidence.unknownOpenOrders,
    // The assets actually observed, from the snapshot. `openingFromSnapshot` has already
    // refused an unsupported one, so this is the belt to that brace.
    observedAssets: opening.map((position) => position.asset),
    alreadyBootstrapped: evidence.alreadyBootstrapped,
  };
}
