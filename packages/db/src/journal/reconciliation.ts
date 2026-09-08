import type { Pool } from 'pg';
import type { VenueOrderStatus } from '@capitaldesk/contracts';
import {
  allocateCompleteFills,
  type ApprovedAllocation,
  type FillAsset,
  type FinalFillCell,
} from '@capitaldesk/ledger';
import { assessFinancialFinality, type CoverageProof } from '@capitaldesk/reconciler';
import { LedgerRepository, type LedgerEntryInput } from './ledger.js';
import { serializable, type Queryable } from './transaction.js';

export interface ReservationBinding {
  readonly strategyId: string;
  readonly asset: FillAsset;
  readonly reservationId: string;
}

export interface StartReconciliationInput {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly epoch: number;
  readonly reconciliationId: string;
  readonly attemptId?: string;
  readonly symbol?: string;
  readonly venueOrderId?: string;
  readonly observedStableAccountId: string;
  readonly coverageProof: CoverageProof;
  readonly beforeObservationId?: string;
  readonly afterObservationId?: string;
  readonly cursorEvidence: unknown;
  readonly observedBaseAtoms: bigint;
  readonly observedQuoteAtoms: bigint;
}

export type FinalizeOutcome =
  | {
      readonly ok: true;
      readonly planState: 'COMPLETED' | 'PARTIAL' | 'UNFILLED';
      readonly ledgerRevision: number;
      readonly allocations: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'UNKNOWN_RECONCILIATION'
        | 'NOT_FINANCIALLY_FINAL'
        | 'ALLOCATION_INFEASIBLE'
        | 'FEE_ASSET_UNSUPPORTED'
        | 'RESERVATION_MISSING';
      readonly detail: string;
    };

const assetKey = (asset: FillAsset): string => `${asset.code}:${asset.scaleVersion}`;

function parseStoredAsset(value: string): FillAsset {
  const at = value.lastIndexOf(':');
  if (at < 1 || at === value.length - 1) throw new Error(`invalid stored asset ${value}`);
  return { code: value.slice(0, at), scaleVersion: value.slice(at + 1) };
}

function pushPair(
  entries: LedgerEntryInput[],
  asset: FillAsset,
  atoms: bigint,
  claim: Omit<LedgerEntryInput, 'asset' | 'deltaAtoms'>,
): void {
  if (atoms === 0n) return;
  entries.push({
    accountKind: 'ASSET_CONTROL',
    owner: 'ASSET_CONTROL',
    claimState: 'CONTROL',
    asset: { code: asset.code, scale: asset.scaleVersion },
    deltaAtoms: atoms,
  });
  entries.push({
    ...claim,
    asset: { code: asset.code, scale: asset.scaleVersion },
    deltaAtoms: atoms,
  });
}

function bindingOf(
  bindings: readonly ReservationBinding[],
  strategyId: string,
  asset: FillAsset,
): ReservationBinding | undefined {
  return bindings.find(
    (binding) => binding.strategyId === strategyId && assetKey(binding.asset) === assetKey(asset),
  );
}

async function persistIncident(
  client: Queryable,
  input: {
    workspaceId: string;
    poolId: string;
    epoch: number;
    reconciliationId: string;
    kind: 'FILL_CONFLICT' | 'FEE_DISCREPANCY';
    detail: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO incidents
      (workspace_id,pool_id,epoch,incident_id,kind,subject_ref,detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
    [
      input.workspaceId,
      input.poolId,
      input.epoch,
      `incident-${input.reconciliationId}`,
      input.kind,
      input.reconciliationId,
      JSON.stringify(input.detail),
    ],
  );
  await client.query(
    `UPDATE pools SET state='QUARANTINED',version=version+1,updated_at=now()
      WHERE workspace_id=$1 AND pool_id=$2 AND state<>'QUARANTINED'`,
    [input.workspaceId, input.poolId],
  );
}

export class ReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  start(input: StartReconciliationInput): Promise<{ coverage: string }> {
    return serializable(this.pool, async (client) => {
      const coverage =
        input.coverageProof.upstreamSupportsRecovery &&
        input.coverageProof.movementUniverseProven &&
        input.coverageProof.streamOrGapCertificate &&
        input.coverageProof.openOrdersComplete &&
        input.coverageProof.tradeBackfillComplete &&
        input.coverageProof.balanceBracketMatches &&
        input.coverageProof.freshnessComplete
          ? 'COMPLETE'
          : input.coverageProof.upstreamSupportsRecovery
            ? 'INCOMPLETE'
            : 'UNSUPPORTED';
      await client.query(
        `INSERT INTO reconciliation_runs
          (workspace_id,pool_id,epoch,reconciliation_id,attempt_id,symbol,venue_order_id,
           observed_stable_account_id,
           coverage,movement_universe_proven,stream_or_gap_certificate,open_orders_complete,
           trade_backfill_complete,balance_bracket_matches,freshness_complete,
           before_observation_id,after_observation_id,cursor_evidence,
           observed_base_atoms,observed_quote_atoms,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,now())
         ON CONFLICT (workspace_id,pool_id,reconciliation_id) DO NOTHING`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.reconciliationId,
          input.attemptId ?? null,
          input.symbol ?? null,
          input.venueOrderId ?? null,
          input.observedStableAccountId,
          coverage,
          input.coverageProof.movementUniverseProven,
          input.coverageProof.streamOrGapCertificate,
          input.coverageProof.openOrdersComplete,
          input.coverageProof.tradeBackfillComplete,
          input.coverageProof.balanceBracketMatches,
          input.coverageProof.freshnessComplete,
          input.beforeObservationId ?? null,
          input.afterObservationId ?? null,
          JSON.stringify(input.cursorEvidence),
          input.observedBaseAtoms.toString(),
          input.observedQuoteAtoms.toString(),
        ],
      );
      return { coverage };
    });
  }

  finalize(input: {
    readonly workspaceId: string;
    readonly poolId: string;
    readonly epoch: number;
    readonly reconciliationId: string;
    readonly attemptId: string;
    readonly planId: string;
    readonly symbol: string;
    readonly venueOrderId: string;
    readonly side: 'BUY' | 'SELL';
    readonly baseAsset: FillAsset;
    readonly quoteAsset: FillAsset;
    readonly fifo: readonly ApprovedAllocation[];
    readonly reservations: readonly ReservationBinding[];
    readonly netSatisfiedStrategyIds?: readonly string[];
  }): Promise<FinalizeOutcome> {
    return serializable(this.pool, async (client): Promise<FinalizeOutcome> => {
      await client.query('SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE', [
        input.workspaceId,
        input.poolId,
      ]);
      const run = await client.query<{
        coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNSUPPORTED';
        movement_universe_proven: boolean;
        stream_or_gap_certificate: boolean;
        open_orders_complete: boolean;
        trade_backfill_complete: boolean;
        balance_bracket_matches: boolean;
        freshness_complete: boolean;
        observed_base_atoms: string;
        observed_quote_atoms: string;
        accounting_state: string;
      }>(
        `SELECT coverage,movement_universe_proven,stream_or_gap_certificate,open_orders_complete,
                trade_backfill_complete,balance_bracket_matches,freshness_complete,
                observed_base_atoms::text,observed_quote_atoms::text,accounting_state
           FROM reconciliation_runs
          WHERE workspace_id=$1 AND pool_id=$2 AND reconciliation_id=$3 FOR UPDATE`,
        [input.workspaceId, input.poolId, input.reconciliationId],
      );
      const evidence = run.rows[0];
      if (evidence === undefined) {
        return { ok: false, reason: 'UNKNOWN_RECONCILIATION', detail: 'run does not exist' };
      }
      if (evidence.accounting_state === 'RECONCILED') {
        const existing = await client.query<{
          state: 'COMPLETED' | 'PARTIAL' | 'UNFILLED';
          revision: string;
        }>(
          `SELECT p.state,(SELECT ledger_revision::text FROM pools WHERE workspace_id=p.workspace_id AND pool_id=p.pool_id) revision
             FROM plans p WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3`,
          [input.workspaceId, input.poolId, input.planId],
        );
        return {
          ok: true,
          planState: existing.rows[0]?.state ?? 'PARTIAL',
          ledgerRevision: Number(existing.rows[0]?.revision ?? '0'),
          allocations: 0,
        };
      }
      const order = await client.query<{ status: VenueOrderStatus }>(
        `SELECT status FROM venue_orders WHERE workspace_id=$1 AND pool_id=$2 AND epoch=$3
          AND symbol=$4 AND venue_order_id=$5 FOR UPDATE`,
        [input.workspaceId, input.poolId, input.epoch, input.symbol, input.venueOrderId],
      );
      const fillRows = await client.query<{
        venue_trade_id: string;
        observation_id: string;
        base_atoms: string;
        quote_atoms: string;
        commission_asset: string;
        commission_atoms: string;
        exchange_sequence: string | null;
      }>(
        `SELECT venue_trade_id,observation_id,base_atoms::text,quote_atoms::text,
                commission_asset,commission_atoms::text,exchange_sequence::text
           FROM venue_fills WHERE workspace_id=$1 AND pool_id=$2 AND epoch=$3
            AND symbol=$4 AND venue_order_id=$5 ORDER BY exchange_sequence NULLS LAST,venue_trade_id`,
        [input.workspaceId, input.poolId, input.epoch, input.symbol, input.venueOrderId],
      );
      if (fillRows.rows.some((row) => row.exchange_sequence === null)) {
        return {
          ok: false,
          reason: 'NOT_FINANCIALLY_FINAL',
          detail: 'VERIFIED_EXCHANGE_ORDER_MISSING',
        };
      }
      const fills = fillRows.rows.map((row) => ({
        tradeId: row.venue_trade_id,
        baseAtoms: BigInt(row.base_atoms),
        quoteAtoms: BigInt(row.quote_atoms),
        commissionAsset: parseStoredAsset(row.commission_asset),
        commissionAtoms: BigInt(row.commission_atoms),
      }));
      const sumBase = fills.reduce((sum, fill) => sum + fill.baseAtoms, 0n);
      const sumQuote = fills.reduce((sum, fill) => sum + fill.quoteAtoms, 0n);
      const conflicts = await client.query(
        `SELECT 1 FROM evidence_conflicts WHERE workspace_id=$1 AND pool_id=$2 AND epoch=$3
          AND subject_kind IN ('fill','order-status','order-correlation')
          AND subject_ref LIKE $4 LIMIT 1`,
        [input.workspaceId, input.poolId, input.epoch, `${input.symbol}/${input.venueOrderId}%`],
      );
      const finality = assessFinancialFinality({
        venueStatus: order.rows[0]?.status ?? 'UNSUPPORTED_OBSERVATION',
        coverageProof: {
          movementUniverseProven: evidence.movement_universe_proven,
          streamOrGapCertificate: evidence.stream_or_gap_certificate,
          openOrdersComplete: evidence.open_orders_complete,
          tradeBackfillComplete: evidence.trade_backfill_complete,
          balanceBracketMatches: evidence.balance_bracket_matches,
          freshnessComplete: evidence.freshness_complete,
          upstreamSupportsRecovery: evidence.coverage !== 'UNSUPPORTED',
        },
        orderCumulativeBaseAtoms: BigInt(evidence.observed_base_atoms),
        orderCumulativeQuoteAtoms: BigInt(evidence.observed_quote_atoms),
        fillBaseAtoms: sumBase,
        fillQuoteAtoms: sumQuote,
        hasEvidenceConflict: (conflicts.rowCount ?? 0) > 0,
      });
      if (!finality.ready) {
        await client.query(
          'UPDATE reconciliation_runs SET accounting_state=$4 WHERE workspace_id=$1 AND pool_id=$2 AND reconciliation_id=$3',
          [input.workspaceId, input.poolId, input.reconciliationId, finality.accounting],
        );
        return { ok: false, reason: 'NOT_FINANCIALLY_FINAL', detail: finality.reason };
      }
      const allocation = allocateCompleteFills({
        side: input.side,
        baseAsset: input.baseAsset,
        quoteAsset: input.quoteAsset,
        fills,
        fifo: input.fifo,
      });
      if (!allocation.ok) {
        await persistIncident(client, {
          ...input,
          kind: allocation.reason === 'FEE_ASSET_UNSUPPORTED' ? 'FEE_DISCREPANCY' : 'FILL_CONFLICT',
          detail: { reason: allocation.reason, detail: allocation.detail },
        });
        await client.query(
          "UPDATE reconciliation_runs SET accounting_state='CONFLICT' WHERE workspace_id=$1 AND pool_id=$2 AND reconciliation_id=$3",
          [input.workspaceId, input.poolId, input.reconciliationId],
        );
        return allocation;
      }

      const entries: LedgerEntryInput[] = [];
      const cellsByStrategy = new Map<string, FinalFillCell[]>();
      for (const cell of allocation.cells) {
        const values = cellsByStrategy.get(cell.strategyId) ?? [];
        values.push(cell);
        cellsByStrategy.set(cell.strategyId, values);
      }

      for (const [strategyId, cells] of cellsByStrategy) {
        const grossBase = cells.reduce((sum, cell) => sum + cell.grossBaseAtoms, 0n);
        const grossQuote = cells.reduce((sum, cell) => sum + cell.grossQuoteAtoms, 0n);
        const fees = new Map<string, { asset: FillAsset; atoms: bigint }>();
        for (const cell of cells) {
          const key = assetKey(cell.commissionAsset);
          const value = fees.get(key) ?? { asset: cell.commissionAsset, atoms: 0n };
          value.atoms += cell.commissionAtoms;
          fees.set(key, value);
        }
        const baseFee = fees.get(assetKey(input.baseAsset))?.atoms ?? 0n;
        const quoteFee = fees.get(assetKey(input.quoteAsset))?.atoms ?? 0n;
        const baseReservation = bindingOf(input.reservations, strategyId, input.baseAsset);
        const quoteReservation = bindingOf(input.reservations, strategyId, input.quoteAsset);

        if (input.side === 'BUY') {
          const quoteDebit = grossQuote + quoteFee;
          if (quoteReservation === undefined && quoteDebit > 0n) {
            return { ok: false, reason: 'RESERVATION_MISSING', detail: `${strategyId} quote` };
          }
          pushPair(entries, input.baseAsset, grossBase, {
            accountKind: 'STRATEGY',
            owner: strategyId,
            claimState: 'AVAILABLE',
          });
          pushPair(entries, input.baseAsset, -baseFee, {
            accountKind: 'STRATEGY',
            owner: strategyId,
            claimState: 'AVAILABLE',
          });
          if (quoteDebit > 0n && quoteReservation !== undefined) {
            pushPair(entries, input.quoteAsset, -quoteDebit, {
              accountKind: 'STRATEGY',
              owner: strategyId,
              claimState: 'RESERVED',
              reservationId: quoteReservation.reservationId,
            });
          }
        } else {
          const baseDebit = grossBase + baseFee;
          if (baseReservation === undefined && baseDebit > 0n) {
            return { ok: false, reason: 'RESERVATION_MISSING', detail: `${strategyId} base` };
          }
          if (baseDebit > 0n && baseReservation !== undefined) {
            pushPair(entries, input.baseAsset, -baseDebit, {
              accountKind: 'STRATEGY',
              owner: strategyId,
              claimState: 'RESERVED',
              reservationId: baseReservation.reservationId,
            });
          }
          pushPair(entries, input.quoteAsset, grossQuote, {
            accountKind: 'STRATEGY',
            owner: strategyId,
            claimState: 'AVAILABLE',
          });
          if (quoteFee > 0n) {
            const fromProceeds = quoteFee < grossQuote ? quoteFee : grossQuote;
            pushPair(entries, input.quoteAsset, -fromProceeds, {
              accountKind: 'STRATEGY',
              owner: strategyId,
              claimState: 'AVAILABLE',
            });
            const fromReserved = quoteFee - fromProceeds;
            if (fromReserved > 0n && quoteReservation === undefined) {
              return {
                ok: false,
                reason: 'RESERVATION_MISSING',
                detail: `${strategyId} quote fee`,
              };
            }
            if (fromReserved > 0n && quoteReservation !== undefined) {
              pushPair(entries, input.quoteAsset, -fromReserved, {
                accountKind: 'STRATEGY',
                owner: strategyId,
                claimState: 'RESERVED',
                reservationId: quoteReservation.reservationId,
              });
            }
          }
        }
        for (const { asset, atoms } of fees.values()) {
          if (
            assetKey(asset) === assetKey(input.baseAsset) ||
            assetKey(asset) === assetKey(input.quoteAsset)
          )
            continue;
          const binding = bindingOf(input.reservations, strategyId, asset);
          if (binding === undefined && atoms > 0n) {
            return {
              ok: false,
              reason: 'RESERVATION_MISSING',
              detail: `${strategyId} ${assetKey(asset)}`,
            };
          }
          if (atoms > 0n && binding !== undefined) {
            pushPair(entries, asset, -atoms, {
              accountKind: 'STRATEGY',
              owner: strategyId,
              claimState: 'RESERVED',
              reservationId: binding.reservationId,
            });
          }
        }
      }

      // No persistence precedes the reservation/cap validation above. From this point every
      // allocation row, ledger effect and release either commits together or rolls back.
      for (const cell of allocation.cells) {
        await client.query(
          `INSERT INTO fill_allocations
            (workspace_id,pool_id,epoch,symbol,venue_order_id,venue_trade_id,strategy_id,intent_id,
             gross_base_atoms,gross_quote_atoms,commission_asset,commission_scale,commission_atoms,
             algorithm_version,reconciliation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            input.workspaceId,
            input.poolId,
            input.epoch,
            input.symbol,
            input.venueOrderId,
            cell.tradeId,
            cell.strategyId,
            cell.intentId,
            cell.grossBaseAtoms.toString(),
            cell.grossQuoteAtoms.toString(),
            cell.commissionAsset.code,
            cell.commissionAsset.scaleVersion,
            cell.commissionAtoms.toString(),
            allocation.algorithm,
            input.reconciliationId,
          ],
        );
      }

      let revision: number;
      if (entries.length > 0) {
        const posted = await LedgerRepository.postOn(client, {
          workspaceId: input.workspaceId,
          poolId: input.poolId,
          epoch: input.epoch,
          ledgerTxnId: `txn-reconcile-${input.reconciliationId}`,
          source: { kind: 'reconciliation', ref: input.reconciliationId },
          description: `final fills for ${input.symbol}/${input.venueOrderId}`,
          entries,
        });
        if (!posted.ok) throw new Error(`final fill posting refused: ${posted.reason}`);
        await client.query(
          `UPDATE raw_observations SET applied_ledger_txn_id=$4
            WHERE workspace_id=$1 AND pool_id=$2 AND observation_id=ANY($3::text[])
              AND applied_ledger_txn_id IS NULL`,
          [
            input.workspaceId,
            input.poolId,
            fillRows.rows.map((row) => row.observation_id),
            `txn-reconcile-${input.reconciliationId}`,
          ],
        );
        revision = posted.revision;
      } else {
        const current = await client.query<{ ledger_revision: string }>(
          'SELECT ledger_revision::text FROM pools WHERE workspace_id=$1 AND pool_id=$2',
          [input.workspaceId, input.poolId],
        );
        revision = Number(current.rows[0]?.ledger_revision ?? '0');
      }
      for (const binding of input.reservations) {
        const remaining = await client.query<{ atoms: string }>(
          `SELECT coalesce(sum(delta_atoms),0)::text atoms FROM ledger_entries
            WHERE workspace_id=$1 AND pool_id=$2 AND reservation_id=$3`,
          [input.workspaceId, input.poolId, binding.reservationId],
        );
        const released = await LedgerRepository.releaseOn(client, {
          workspaceId: input.workspaceId,
          poolId: input.poolId,
          reservationId: binding.reservationId,
          atoms: BigInt(remaining.rows[0]?.atoms ?? '0'),
          source: {
            kind: 'reconciliation-release',
            ref: `${input.reconciliationId}-${binding.reservationId}`,
          },
        });
        if (!released.ok) throw new Error(`reservation release refused: ${released.reason}`);
        revision = released.revision;
      }
      const requested = input.fifo.reduce((sum, item) => sum + item.requestedGrossBaseAtoms, 0n);
      const planState: 'COMPLETED' | 'PARTIAL' | 'UNFILLED' =
        sumBase === 0n ? 'UNFILLED' : sumBase === requested ? 'COMPLETED' : 'PARTIAL';
      await client.query(
        `UPDATE plans SET state=$4,version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3 AND state IN ('RECONCILING','MANUAL_REVIEW')`,
        [input.workspaceId, input.poolId, input.planId, planState],
      );
      const satisfied = new Set(input.netSatisfiedStrategyIds ?? []);
      for (const approved of input.fifo) {
        const allocated = allocation.cells
          .filter((cell) => cell.strategyId === approved.strategyId)
          .reduce((sum, cell) => sum + cell.grossBaseAtoms, 0n);
        const state = satisfied.has(approved.strategyId)
          ? 'SATISFIED'
          : allocated === 0n
            ? 'UNFILLED'
            : 'PARTIAL';
        await client.query(
          `UPDATE strategy_intents SET state=$4,updated_at=now()
            WHERE workspace_id=$1 AND pool_id=$2 AND intent_id=$3 AND state='PLANNED'`,
          [input.workspaceId, input.poolId, approved.intentId, state],
        );
      }
      await client.query(
        `UPDATE reconciliation_runs SET accounting_state='RECONCILED'
          WHERE workspace_id=$1 AND pool_id=$2 AND reconciliation_id=$3`,
        [input.workspaceId, input.poolId, input.reconciliationId],
      );
      await client.query(
        `UPDATE dispatch_attempts SET state='ACKNOWLEDGED',resolved_at=coalesce(resolved_at,now())
          WHERE workspace_id=$1 AND pool_id=$2 AND attempt_id=$3 AND state IN ('SEND_ATTEMPTED','UNKNOWN')`,
        [input.workspaceId, input.poolId, input.attemptId],
      );
      return {
        ok: true,
        planState,
        ledgerRevision: revision,
        allocations: allocation.cells.length,
      };
    });
  }

  proveNotSent(input: {
    workspaceId: string;
    poolId: string;
    attemptId: string;
    reconciliationId: string;
    evidenceId: string;
    senderFenced: boolean;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<{ ok: boolean; reason?: string }> {
    return serializable(this.pool, async (client) => {
      const run = await client.query<{ coverage: string }>(
        `SELECT coverage FROM reconciliation_runs WHERE workspace_id=$1 AND pool_id=$2
          AND reconciliation_id=$3 FOR UPDATE`,
        [input.workspaceId, input.poolId, input.reconciliationId],
      );
      const attempt = await client.query<{
        state: string;
        send_attempted_at: Date | null;
        plan_id: string;
      }>(
        `SELECT state,send_attempted_at,plan_id FROM dispatch_attempts WHERE workspace_id=$1 AND pool_id=$2
          AND attempt_id=$3 FOR UPDATE`,
        [input.workspaceId, input.poolId, input.attemptId],
      );
      const row = attempt.rows[0];
      if (
        !input.senderFenced ||
        run.rows[0]?.coverage !== 'COMPLETE' ||
        row === undefined ||
        row.send_attempted_at !== null ||
        !['DISPATCH_MARKED', 'UNKNOWN'].includes(row.state)
      ) {
        return { ok: false, reason: 'DISPATCH_SENDER_UNFENCED_OR_EVIDENCE_INCOMPLETE' };
      }
      await client.query(
        `INSERT INTO non_send_evidence
          (workspace_id,pool_id,evidence_id,reconciliation_id,attempt_id,sender_fenced,
           no_send_attempt_recorded,client_order_absent,uncertainty_window_start,uncertainty_window_end)
         VALUES ($1,$2,$3,$4,$5,true,true,true,$6,$7)`,
        [
          input.workspaceId,
          input.poolId,
          input.evidenceId,
          input.reconciliationId,
          input.attemptId,
          input.windowStart,
          input.windowEnd,
        ],
      );
      await client.query(
        `UPDATE dispatch_attempts SET state='NOT_SENT_PROVEN',non_send_evidence_id=$4,resolved_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND attempt_id=$3`,
        [input.workspaceId, input.poolId, input.attemptId, input.evidenceId],
      );
      const reservations = await client.query<{ reservation_id: string; remaining: string }>(
        `SELECT r.reservation_id,coalesce(sum(e.delta_atoms),0)::text remaining
           FROM reservations r JOIN ledger_entries e
             ON e.workspace_id=r.workspace_id AND e.pool_id=r.pool_id
            AND e.reservation_id=r.reservation_id
          WHERE r.workspace_id=$1 AND r.pool_id=$2 AND r.plan_id=$3 AND r.state='HELD'
          GROUP BY r.reservation_id ORDER BY r.reservation_id`,
        [input.workspaceId, input.poolId, row.plan_id],
      );
      for (const reservation of reservations.rows) {
        const released = await LedgerRepository.releaseOn(client, {
          workspaceId: input.workspaceId,
          poolId: input.poolId,
          reservationId: reservation.reservation_id,
          atoms: BigInt(reservation.remaining),
          source: {
            kind: 'not-sent-release',
            ref: `${input.evidenceId}-${reservation.reservation_id}`,
          },
        });
        if (!released.ok) throw new Error(`non-send release refused: ${released.reason}`);
      }
      await client.query(
        `UPDATE plans SET state='UNFILLED',version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND plan_id=$3
            AND state IN ('RECONCILING','MANUAL_REVIEW')`,
        [input.workspaceId, input.poolId, row.plan_id],
      );
      return { ok: true };
    });
  }
}
