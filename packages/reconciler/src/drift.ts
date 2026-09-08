import type { ObservationCoverageState } from '@capitaldesk/contracts';

export type DriftKind =
  | 'EXTERNAL_ACTIVITY'
  | 'INCOMPLETE_HISTORY'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'SCALE_CHANGE'
  | 'EPOCH_RESET'
  | 'BALANCE_DRIFT'
  | 'UNKNOWN_ORDER';

export interface DriftAssessment {
  readonly quarantine: boolean;
  readonly incidents: readonly DriftKind[];
  readonly balancesEqual: boolean;
}

export function assessDrift(input: {
  readonly expectedAccountId: string;
  readonly observedAccountId: string;
  readonly coverage: ObservationCoverageState;
  readonly expectedBalances: Readonly<Record<string, bigint>>;
  readonly observedBalances: Readonly<Record<string, bigint>>;
  readonly externalActivityObserved: boolean;
  readonly unknownOpenOrderObserved: boolean;
  readonly scaleChanged: boolean;
  readonly resetPositivelyDetected: boolean;
}): DriftAssessment {
  const keys = [
    ...new Set([...Object.keys(input.expectedBalances), ...Object.keys(input.observedBalances)]),
  ].sort();
  const balancesEqual = keys.every(
    (key) => (input.expectedBalances[key] ?? 0n) === (input.observedBalances[key] ?? 0n),
  );
  const incidents: DriftKind[] = [];
  if (input.expectedAccountId !== input.observedAccountId)
    incidents.push('ACCOUNT_IDENTITY_MISMATCH');
  if (input.coverage !== 'COMPLETE') incidents.push('INCOMPLETE_HISTORY');
  if (input.externalActivityObserved) incidents.push('EXTERNAL_ACTIVITY');
  if (input.unknownOpenOrderObserved) incidents.push('UNKNOWN_ORDER');
  if (input.scaleChanged) incidents.push('SCALE_CHANGE');
  if (input.resetPositivelyDetected) incidents.push('EPOCH_RESET');
  if (!balancesEqual) incidents.push('BALANCE_DRIFT');
  return { quarantine: incidents.length > 0, incidents, balancesEqual };
}

export function mayResume(input: {
  readonly coverage: ObservationCoverageState;
  readonly activeIncidentCount: bigint;
  readonly unresolvedDispatchCount: bigint;
  readonly accountIdentityMatches: boolean;
}): boolean {
  return (
    input.coverage === 'COMPLETE' &&
    input.activeIncidentCount === 0n &&
    input.unresolvedDispatchCount === 0n &&
    input.accountIdentityMatches
  );
}

export function mayOpenResetEpoch(input: {
  readonly resetPositivelyDetected: boolean;
  readonly senderFenced: boolean;
  readonly unresolvedDispatchCount: bigint;
  readonly coverage: ObservationCoverageState;
}): boolean {
  return (
    input.resetPositivelyDetected &&
    input.senderFenced &&
    input.unresolvedDispatchCount === 0n &&
    input.coverage === 'COMPLETE'
  );
}
