import { createHash } from 'node:crypto';

export interface AuthorizationEvidence {
  readonly bundleVersion: 'capitaldesk-authorization/v1';
  readonly planId: string;
  readonly planDigest: string;
  readonly canonicalPlan: string;
  readonly approvalId: string;
  readonly approvalDigest: string;
  readonly allocationPolicyVersion: string;
  readonly feePolicyVersion: string;
  readonly fifo: ReadonlyArray<{
    readonly sequence: string;
    readonly strategyId: string;
    readonly intentId: string;
    readonly approvedBaseAtoms: string;
  }>;
  readonly dispatchMarkerId: string;
}

export interface AuthorizationBundle {
  readonly evidence: AuthorizationEvidence;
  readonly digest: string;
}

function digestOf(evidence: AuthorizationEvidence): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
}

export function createAuthorizationBundle(
  evidence: Omit<AuthorizationEvidence, 'bundleVersion'>,
): AuthorizationBundle {
  if (evidence.allocationPolicyVersion === '' || evidence.feePolicyVersion === '') {
    throw new Error('allocation and fee policy versions are required');
  }
  if (evidence.fifo.length === 0) throw new Error('FIFO allocation is required');
  const complete: AuthorizationEvidence = {
    bundleVersion: 'capitaldesk-authorization/v1',
    ...evidence,
  };
  return { evidence: complete, digest: digestOf(complete) };
}

export type AuthorizationRecovery =
  | { readonly state: 'RECOVERED'; readonly fifo: AuthorizationEvidence['fifo'] }
  | { readonly state: 'RESTORE_ATTRIBUTION_UNRECOVERABLE'; readonly reason: string };

export function recoverAuthorization(bundle: AuthorizationBundle | null): AuthorizationRecovery {
  if (bundle === null) {
    return {
      state: 'RESTORE_ATTRIBUTION_UNRECOVERABLE',
      reason: 'neither database authorization nor an external evidence bundle survived',
    };
  }
  if (digestOf(bundle.evidence) !== bundle.digest) {
    return { state: 'RESTORE_ATTRIBUTION_UNRECOVERABLE', reason: 'bundle digest mismatch' };
  }
  if (
    bundle.evidence.allocationPolicyVersion === '' ||
    bundle.evidence.feePolicyVersion === '' ||
    bundle.evidence.fifo.length === 0
  ) {
    return { state: 'RESTORE_ATTRIBUTION_UNRECOVERABLE', reason: 'bundle is incomplete' };
  }
  return { state: 'RECOVERED', fifo: bundle.evidence.fifo };
}
