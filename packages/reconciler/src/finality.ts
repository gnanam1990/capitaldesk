import {
  isTerminalVenueStatus,
  type AccountingState,
  type ObservationCoverageState,
  type VenueOrderStatus,
} from '@capitaldesk/contracts';

export interface CoverageProof {
  readonly movementUniverseProven: boolean;
  readonly streamOrGapCertificate: boolean;
  readonly openOrdersComplete: boolean;
  readonly tradeBackfillComplete: boolean;
  readonly balanceBracketMatches: boolean;
  readonly freshnessComplete: boolean;
  readonly upstreamSupportsRecovery: boolean;
}

export function coverageOf(proof: CoverageProof): ObservationCoverageState {
  if (!proof.upstreamSupportsRecovery) return 'UNSUPPORTED';
  return proof.movementUniverseProven &&
    proof.streamOrGapCertificate &&
    proof.openOrdersComplete &&
    proof.tradeBackfillComplete &&
    proof.balanceBracketMatches &&
    proof.freshnessComplete
    ? 'COMPLETE'
    : 'INCOMPLETE';
}

export type FinancialFinality =
  | { readonly ready: true; readonly accounting: 'RECONCILED'; readonly coverage: 'COMPLETE' }
  | {
      readonly ready: false;
      readonly accounting: AccountingState;
      readonly coverage: ObservationCoverageState;
      readonly reason:
        | 'VENUE_NOT_TERMINAL'
        | 'EVIDENCE_INCOMPLETE'
        | 'CUMULATIVE_TOTAL_MISMATCH'
        | 'EVIDENCE_CONTRADICTORY';
    };

export function assessFinancialFinality(input: {
  readonly venueStatus: VenueOrderStatus;
  readonly coverageProof: CoverageProof;
  readonly orderCumulativeBaseAtoms: bigint;
  readonly orderCumulativeQuoteAtoms: bigint;
  readonly fillBaseAtoms: bigint;
  readonly fillQuoteAtoms: bigint;
  readonly hasEvidenceConflict: boolean;
}): FinancialFinality {
  const coverage = coverageOf(input.coverageProof);
  if (!isTerminalVenueStatus(input.venueStatus)) {
    return { ready: false, accounting: 'PROVISIONAL', coverage, reason: 'VENUE_NOT_TERMINAL' };
  }
  if (input.hasEvidenceConflict) {
    return {
      ready: false,
      accounting: 'CONFLICT',
      coverage,
      reason: 'EVIDENCE_CONTRADICTORY',
    };
  }
  if (coverage !== 'COMPLETE') {
    return { ready: false, accounting: 'INCOMPLETE', coverage, reason: 'EVIDENCE_INCOMPLETE' };
  }
  if (
    input.orderCumulativeBaseAtoms !== input.fillBaseAtoms ||
    input.orderCumulativeQuoteAtoms !== input.fillQuoteAtoms
  ) {
    return {
      ready: false,
      accounting: 'CONFLICT',
      coverage,
      reason: 'CUMULATIVE_TOTAL_MISMATCH',
    };
  }
  return { ready: true, accounting: 'RECONCILED', coverage: 'COMPLETE' };
}

/** A read-only retry never changes this rule and never authorizes another placement. */
export function unresolvedLookupDisposition(input: {
  readonly notFoundCount: bigint;
  readonly decisiveNonSendEvidence: boolean;
}): 'UNRESOLVED' | 'NOT_SENT_PROVEN' {
  return input.decisiveNonSendEvidence ? 'NOT_SENT_PROVEN' : 'UNRESOLVED';
}
