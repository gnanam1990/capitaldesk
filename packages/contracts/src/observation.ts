import type { ObservationCoverageState } from './states.js';

/**
 * The account observation boundary (ADR-0002).
 *
 * The original contract required "proof of no intervening economic observations" without
 * saying how that proof is constructed. These are the five executable conditions. All five
 * must hold; matching balances alone are explicitly not sufficient, and no global upstream
 * sequence guarantee is claimed.
 */

export interface CoverageConditions {
  /** 1. The user-data stream was continuously connected across the window, or the gap was backfilled. */
  readonly streamContinuous: boolean;
  /** 2. An account-wide open-order scan at t1 revealed no order unknown to the journal. */
  readonly accountWideOpenOrderScanClean: boolean;
  /** 3. For every observed symbol, trades were backfilled by cursor with no gap to the last booked trade. */
  readonly tradeBackfillComplete: boolean;
  /** 4. Bracketing balance snapshots at t0/t1 differ by exactly the booked economic effects between them. */
  readonly bracketingSnapshotsAgree: boolean;
  /** 5. Every source observation used is inside its declared freshness class bound. */
  readonly sourcesFresh: boolean;
  /**
   * Whether every movement type that could have occurred is observable at all on this
   * account and environment. Deposits, withdrawals and internal transfers are not
   * observable in the v1 testnet surface, so this is false whenever such a movement is
   * possible and unobservable.
   */
  readonly allMovementTypesObservable: boolean;
}

export interface CoverageAssessment {
  readonly state: ObservationCoverageState;
  /** Human-readable unmet conditions, in a stable order, for the console and exports. */
  readonly unmet: readonly string[];
}

const CONDITION_LABELS: ReadonlyArray<readonly [keyof CoverageConditions, string]> = [
  ['streamContinuous', 'user-data stream had an unbackfilled gap'],
  ['accountWideOpenOrderScanClean', 'account-wide open-order scan found an unknown order'],
  ['tradeBackfillComplete', 'completed-trade backfill did not reach the last booked trade'],
  ['bracketingSnapshotsAgree', 'bracketing balance snapshots disagree with booked effects'],
  ['sourcesFresh', 'a source observation is outside its freshness class'],
  ['allMovementTypesObservable', 'a possible movement type is not observable on this account'],
];

export function assessCoverage(conditions: CoverageConditions): CoverageAssessment {
  const unmet = CONDITION_LABELS.filter(([key]) => !conditions[key]).map(([, label]) => label);
  if (unmet.length === 0) {
    return { state: 'COMPLETE', unmet: [] };
  }
  if (!conditions.allMovementTypesObservable) {
    return { state: 'UNSUPPORTED', unmet };
  }
  if (!conditions.streamContinuous || !conditions.tradeBackfillComplete) {
    return { state: 'GAP_OPEN', unmet };
  }
  return { state: 'INCOMPLETE', unmet };
}

/**
 * Governed dispatch requires COMPLETE coverage. There is no "probably fine" path and no
 * delay that substitutes for the predicate (INV-10).
 */
export function coveragePermitsDispatch(state: ObservationCoverageState): boolean {
  return state === 'COMPLETE';
}
