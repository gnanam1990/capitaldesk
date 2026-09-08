import type { Pool } from 'pg';
import { assertAuthorized, type Principal } from '@capitaldesk/domain';
import { assessDrift, mayOpenResetEpoch, mayResume } from '@capitaldesk/reconciler';
import { LedgerRepository, type LedgerEntryInput } from './ledger.js';
import { serializable } from './transaction.js';

export class RecoveryRepository {
  constructor(private readonly pool: Pool) {}

  halt(input: {
    workspaceId: string;
    poolId: string;
    actor: Principal;
  }): Promise<{ state: 'HALTED' }> {
    assertAuthorized(input.actor, 'pool.halt', input);
    return serializable(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE pools SET state='HALTED',version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 RETURNING 1`,
        [input.workspaceId, input.poolId],
      );
      if (result.rowCount !== 1) throw new Error('unknown pool');
      return { state: 'HALTED' };
    });
  }

  assess(input: {
    workspaceId: string;
    poolId: string;
    epoch: number;
    reconciliationId: string;
    expectedAccountId: string;
    observedAccountId: string;
    coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNSUPPORTED';
    expectedBalances: Readonly<Record<string, bigint>>;
    observedBalances: Readonly<Record<string, bigint>>;
    externalActivityObserved: boolean;
    unknownOpenOrderObserved: boolean;
    scaleChanged: boolean;
    resetPositivelyDetected: boolean;
  }): Promise<{ quarantined: boolean; incidentIds: readonly string[] }> {
    const assessment = assessDrift(input);
    return serializable(this.pool, async (client) => {
      const ids: string[] = [];
      for (const [index, kind] of assessment.incidents.entries()) {
        const incidentId = `${input.reconciliationId.slice(0, 61)}-${String(index + 1)}`;
        ids.push(incidentId);
        await client.query(
          `INSERT INTO incidents
            (workspace_id,pool_id,epoch,incident_id,kind,subject_ref,detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
          [
            input.workspaceId,
            input.poolId,
            input.epoch,
            incidentId,
            kind,
            input.reconciliationId,
            JSON.stringify({
              attribution: kind === 'EXTERNAL_ACTIVITY' ? 'UNEXPLAINED' : undefined,
              balancesEqual: assessment.balancesEqual,
            }),
          ],
        );
      }
      if (assessment.quarantine) {
        await client.query(
          `UPDATE pools SET state='QUARANTINED',version=version+1,updated_at=now()
            WHERE workspace_id=$1 AND pool_id=$2 AND state<>'QUARANTINED'`,
          [input.workspaceId, input.poolId],
        );
      }
      return { quarantined: assessment.quarantine, incidentIds: ids };
    });
  }

  acknowledge(input: {
    workspaceId: string;
    poolId: string;
    incidentId: string;
    actor: Principal;
  }): Promise<{ ok: boolean }> {
    assertAuthorized(input.actor, 'incident.resolve', input);
    return serializable(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE incidents SET state='ACKNOWLEDGED',acknowledged_by=$4,acknowledged_at=now()
          WHERE workspace_id=$1 AND pool_id=$2 AND incident_id=$3 AND state='OPEN'`,
        [input.workspaceId, input.poolId, input.incidentId, input.actor.subjectId],
      );
      return { ok: result.rowCount === 1 };
    });
  }

  correct(input: {
    workspaceId: string;
    poolId: string;
    epoch: number;
    correctionId: string;
    incidentId: string;
    reason: string;
    sourceEvidenceRef: string;
    entries: readonly LedgerEntryInput[];
    actor: Principal;
  }): Promise<{ ok: boolean; revision?: number }> {
    assertAuthorized(input.actor, 'incident.resolve', input);
    if (input.reason.trim().length === 0 || input.sourceEvidenceRef.trim().length === 0) {
      return Promise.resolve({ ok: false });
    }
    return serializable(this.pool, async (client) => {
      const incident = await client.query(
        `SELECT 1 FROM incidents WHERE workspace_id=$1 AND pool_id=$2 AND incident_id=$3
          AND state<>'RESOLVED' FOR UPDATE`,
        [input.workspaceId, input.poolId, input.incidentId],
      );
      if (incident.rowCount !== 1) return { ok: false };
      const evidence = await client.query(
        `SELECT 1 FROM raw_observations WHERE workspace_id=$1 AND pool_id=$2
            AND observation_id=$3
         UNION ALL
         SELECT 1 FROM reconciliation_runs WHERE workspace_id=$1 AND pool_id=$2
            AND reconciliation_id=$3 LIMIT 1`,
        [input.workspaceId, input.poolId, input.sourceEvidenceRef],
      );
      if (evidence.rowCount !== 1) return { ok: false };
      const posted = await LedgerRepository.postOn(client, {
        workspaceId: input.workspaceId,
        poolId: input.poolId,
        epoch: input.epoch,
        ledgerTxnId: `txn-correction-${input.correctionId}`,
        source: { kind: 'recovery-correction', ref: input.correctionId },
        description: input.reason,
        entries: input.entries,
      });
      if (!posted.ok) return { ok: false };
      await client.query(
        `INSERT INTO recovery_corrections
          (workspace_id,pool_id,epoch,correction_id,incident_id,actor_subject_id,reason,
           source_evidence_ref,ledger_txn_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.workspaceId,
          input.poolId,
          input.epoch,
          input.correctionId,
          input.incidentId,
          input.actor.subjectId,
          input.reason,
          input.sourceEvidenceRef,
          `txn-correction-${input.correctionId}`,
        ],
      );
      return { ok: true, revision: posted.revision };
    });
  }

  resolve(input: {
    workspaceId: string;
    poolId: string;
    incidentId: string;
    resolutionEvidenceRef: string;
    actor: Principal;
  }): Promise<{ ok: boolean; reason?: string }> {
    assertAuthorized(input.actor, 'incident.resolve', input);
    return serializable(this.pool, async (client) => {
      const evidence = await client.query(
        `SELECT 1 FROM reconciliation_runs WHERE workspace_id=$1 AND pool_id=$2
            AND reconciliation_id=$3 AND accounting_state='RECONCILED'
         UNION ALL
         SELECT 1 FROM recovery_corrections WHERE workspace_id=$1 AND pool_id=$2
            AND correction_id=$3 LIMIT 1`,
        [input.workspaceId, input.poolId, input.resolutionEvidenceRef],
      );
      if (evidence.rowCount !== 1) return { ok: false, reason: 'EVIDENCE_REQUIRED' };
      const result = await client.query(
        `UPDATE incidents SET state='RESOLVED',resolved_by=$4,resolved_at=now(),resolution_evidence_ref=$5
          WHERE workspace_id=$1 AND pool_id=$2 AND incident_id=$3 AND state<>'RESOLVED'`,
        [
          input.workspaceId,
          input.poolId,
          input.incidentId,
          input.actor.subjectId,
          input.resolutionEvidenceRef,
        ],
      );
      return { ok: result.rowCount === 1 };
    });
  }

  resume(input: {
    workspaceId: string;
    poolId: string;
    actor: Principal;
  }): Promise<{ ok: boolean; reason?: string }> {
    assertAuthorized(input.actor, 'pool.resume', input);
    return serializable(this.pool, async (client) => {
      const pool = await client.query<{ stable_account_id: string }>(
        'SELECT stable_account_id FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE',
        [input.workspaceId, input.poolId],
      );
      const latest = await client.query<{
        coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNSUPPORTED';
        accounting_state: string;
        observed_stable_account_id: string;
      }>(
        `SELECT coverage,accounting_state,observed_stable_account_id FROM reconciliation_runs
          WHERE workspace_id=$1 AND pool_id=$2 ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
        [input.workspaceId, input.poolId],
      );
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text count FROM incidents WHERE workspace_id=$1 AND pool_id=$2 AND state<>'RESOLVED'",
        [input.workspaceId, input.poolId],
      );
      const unresolved = await client.query<{ count: string }>(
        `SELECT count(*)::text count FROM dispatch_attempts WHERE workspace_id=$1 AND pool_id=$2
          AND state IN ('DISPATCH_MARKED','SEND_ATTEMPTED','UNKNOWN','IRRECOVERABLE_UNCERTAINTY')`,
        [input.workspaceId, input.poolId],
      );
      const row = latest.rows[0];
      const allowed =
        row !== undefined &&
        row.accounting_state === 'RECONCILED' &&
        mayResume({
          coverage: row.coverage,
          activeIncidentCount: BigInt(active.rows[0]?.count ?? '0'),
          unresolvedDispatchCount: BigInt(unresolved.rows[0]?.count ?? '0'),
          accountIdentityMatches:
            row.observed_stable_account_id === pool.rows[0]?.stable_account_id,
        });
      if (!allowed) return { ok: false, reason: 'RECOVERY_GATE_UNMET' };
      await client.query(
        `UPDATE pools SET state='READY',version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2`,
        [input.workspaceId, input.poolId],
      );
      return { ok: true };
    });
  }

  rotateResetEpoch(input: {
    workspaceId: string;
    poolId: string;
    currentEpoch: number;
    resetIncidentId: string;
    senderFenced: boolean;
    actor: Principal;
  }): Promise<{ ok: boolean; epoch?: number; reason?: string }> {
    assertAuthorized(input.actor, 'pool.epochRotate', input);
    return serializable(this.pool, async (client) => {
      await client.query('SELECT 1 FROM pools WHERE workspace_id=$1 AND pool_id=$2 FOR UPDATE', [
        input.workspaceId,
        input.poolId,
      ]);
      const reset = await client.query(
        `SELECT 1 FROM incidents WHERE workspace_id=$1 AND pool_id=$2 AND incident_id=$3
          AND kind='EPOCH_RESET'`,
        [input.workspaceId, input.poolId, input.resetIncidentId],
      );
      const run = await client.query<{ coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNSUPPORTED' }>(
        `SELECT coverage FROM reconciliation_runs WHERE workspace_id=$1 AND pool_id=$2
          ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
        [input.workspaceId, input.poolId],
      );
      const unresolved = await client.query<{ count: string }>(
        `SELECT count(*)::text count FROM dispatch_attempts WHERE workspace_id=$1 AND pool_id=$2
          AND state IN ('DISPATCH_MARKED','SEND_ATTEMPTED','UNKNOWN','IRRECOVERABLE_UNCERTAINTY')`,
        [input.workspaceId, input.poolId],
      );
      if (
        reset.rowCount !== 1 ||
        !mayOpenResetEpoch({
          resetPositivelyDetected: true,
          senderFenced: input.senderFenced,
          unresolvedDispatchCount: BigInt(unresolved.rows[0]?.count ?? '0'),
          coverage: run.rows[0]?.coverage ?? 'INCOMPLETE',
        })
      ) {
        return { ok: false, reason: 'RESET_GATE_UNMET' };
      }
      const next = input.currentEpoch + 1;
      await client.query(
        `UPDATE baseline_epochs SET closed_at=now(),closed_reason=$4
          WHERE workspace_id=$1 AND pool_id=$2 AND epoch=$3 AND closed_at IS NULL`,
        [input.workspaceId, input.poolId, input.currentEpoch, `reset:${input.resetIncidentId}`],
      );
      await client.query(
        'INSERT INTO baseline_epochs(workspace_id,pool_id,epoch) VALUES ($1,$2,$3)',
        [input.workspaceId, input.poolId, next],
      );
      await client.query(
        `UPDATE pools SET state='BOOTSTRAPPING',version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND pool_id=$2`,
        [input.workspaceId, input.poolId],
      );
      return { ok: true, epoch: next };
    });
  }
}
