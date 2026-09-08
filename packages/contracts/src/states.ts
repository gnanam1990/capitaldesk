/**
 * State machines (TDD section 8), with the amendments recorded in ADR-0001 (unresolved
 * dispatch liveness) and ADR-0004 (self-trade prevention and unknown venue observations).
 *
 * Four state families are deliberately kept separate and must never be collapsed into one
 * "status" field: transport attempt state, observed venue state, accounting completeness
 * and intent satisfaction. A terminal venue status is not complete accounting (INV-15).
 */

export const INTENT_STATES = [
  'RECEIVED',
  'VALIDATED',
  'PLANNED',
  'SATISFIED',
  'PARTIAL',
  'UNFILLED',
  'REJECTED',
  'CONFLICT',
  'SUPERSEDED',
  'EXPIRED',
  'DEFERRED',
] as const;
export type IntentState = (typeof INTENT_STATES)[number];

export const PLAN_STATES = [
  'PREVIEW',
  'SEALED_AWAITING_APPROVAL',
  'APPROVED',
  'DISPATCH_PENDING',
  'EXECUTING',
  'RECONCILING',
  'COMPLETED',
  'PARTIAL',
  'UNFILLED',
  'INVALIDATED',
  'DECLINED',
  'EXPIRED',
  'MANUAL_REVIEW',
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/**
 * Dispatch attempt lifecycle.
 *
 * ADR-0001 amendment: `SEND_ATTEMPTED` is committed durably immediately before the first
 * network byte, and `NOT_SENT_PROVEN` is the recovery exit that the original contract
 * lacked. An attempt that reached `DISPATCH_MARKED` but never `SEND_ATTEMPTED`, whose
 * sender is provably fenced, cannot have sent anything — that is decisive absence
 * evidence. Elapsed time and repeated NOT_FOUND are never decisive.
 *
 * `IRRECOVERABLE_UNCERTAINTY` is an honest terminal record, not a release: it retains the
 * liability and never frees reservations or the governance lease.
 */
export const DISPATCH_ATTEMPT_STATES = [
  'PREPARED',
  'DISPATCH_MARKED',
  'SEND_ATTEMPTED',
  'ACKNOWLEDGED',
  'REJECTED',
  'UNKNOWN',
  'NOT_SENT_PROVEN',
  'IRRECOVERABLE_UNCERTAINTY',
] as const;
export type DispatchAttemptState = (typeof DISPATCH_ATTEMPT_STATES)[number];

/**
 * Observed venue order status.
 *
 * ADR-0004 amendment: `EXPIRED_IN_MATCH` is a real Binance terminal status produced by
 * self-trade prevention and was missing from the original enum. `UNSUPPORTED_OBSERVATION`
 * preserves an unknown future status as raw evidence with a fail-closed disposition
 * instead of guessing a mapping.
 */
export const VENUE_ORDER_STATUSES = [
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'PENDING_CANCEL',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'UNSUPPORTED_OBSERVATION',
] as const;
export type VenueOrderStatus = (typeof VENUE_ORDER_STATUSES)[number];

/** Venue execution report types we retain. TRADE_PREVENTION carries no traded quantity. */
export const VENUE_EXECUTION_TYPES = [
  'NEW',
  'TRADE',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'TRADE_PREVENTION',
  'UNSUPPORTED_OBSERVATION',
] as const;
export type VenueExecutionType = (typeof VENUE_EXECUTION_TYPES)[number];

export const ACCOUNTING_STATES = ['INCOMPLETE', 'PROVISIONAL', 'RECONCILED', 'CONFLICT'] as const;
export type AccountingState = (typeof ACCOUNTING_STATES)[number];

export const POOL_STATES = [
  'BOOTSTRAPPING',
  'READY',
  'AWAITING_APPROVAL',
  'IN_FLIGHT',
  'QUARANTINED',
  'HALTED',
] as const;
export type PoolState = (typeof POOL_STATES)[number];

/** Coverage of the account observation boundary (ADR-0002). */
export const OBSERVATION_COVERAGE_STATES = [
  'COMPLETE',
  'GAP_OPEN',
  'BACKFILLING',
  'INCOMPLETE',
  'UNSUPPORTED',
] as const;
export type ObservationCoverageState = (typeof OBSERVATION_COVERAGE_STATES)[number];

type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const INTENT_TRANSITIONS: TransitionTable<IntentState> = Object.freeze({
  RECEIVED: ['VALIDATED', 'REJECTED', 'SUPERSEDED', 'EXPIRED', 'DEFERRED'],
  VALIDATED: ['PLANNED', 'CONFLICT', 'SUPERSEDED', 'EXPIRED', 'DEFERRED', 'REJECTED'],
  PLANNED: ['SATISFIED', 'PARTIAL', 'UNFILLED', 'CONFLICT', 'EXPIRED', 'SUPERSEDED'],
  CONFLICT: ['VALIDATED', 'DEFERRED', 'SUPERSEDED', 'EXPIRED'],
  DEFERRED: ['VALIDATED', 'SUPERSEDED', 'EXPIRED'],
  SATISFIED: [],
  PARTIAL: ['SUPERSEDED', 'EXPIRED'],
  UNFILLED: ['SUPERSEDED', 'EXPIRED'],
  REJECTED: [],
  SUPERSEDED: [],
  EXPIRED: [],
});

export const PLAN_TRANSITIONS: TransitionTable<PlanState> = Object.freeze({
  PREVIEW: ['SEALED_AWAITING_APPROVAL', 'INVALIDATED', 'EXPIRED'],
  SEALED_AWAITING_APPROVAL: ['APPROVED', 'DECLINED', 'INVALIDATED', 'EXPIRED'],
  APPROVED: ['DISPATCH_PENDING', 'INVALIDATED', 'EXPIRED', 'DECLINED'],
  DISPATCH_PENDING: ['EXECUTING', 'INVALIDATED', 'EXPIRED', 'MANUAL_REVIEW'],
  EXECUTING: ['RECONCILING', 'MANUAL_REVIEW'],
  RECONCILING: ['COMPLETED', 'PARTIAL', 'UNFILLED', 'MANUAL_REVIEW'],
  COMPLETED: ['MANUAL_REVIEW'],
  PARTIAL: ['MANUAL_REVIEW'],
  UNFILLED: ['MANUAL_REVIEW'],
  INVALIDATED: [],
  DECLINED: [],
  EXPIRED: [],
  MANUAL_REVIEW: ['RECONCILING', 'COMPLETED', 'PARTIAL', 'UNFILLED'],
});

export const DISPATCH_ATTEMPT_TRANSITIONS: TransitionTable<DispatchAttemptState> = Object.freeze({
  PREPARED: ['DISPATCH_MARKED'],
  // A marked attempt may only ever move forward. It is never reset, retried or reused.
  DISPATCH_MARKED: ['SEND_ATTEMPTED', 'UNKNOWN', 'NOT_SENT_PROVEN'],
  SEND_ATTEMPTED: ['ACKNOWLEDGED', 'REJECTED', 'UNKNOWN'],
  UNKNOWN: ['ACKNOWLEDGED', 'REJECTED', 'NOT_SENT_PROVEN', 'IRRECOVERABLE_UNCERTAINTY'],
  ACKNOWLEDGED: [],
  REJECTED: [],
  NOT_SENT_PROVEN: [],
  IRRECOVERABLE_UNCERTAINTY: [],
});

export const POOL_TRANSITIONS: TransitionTable<PoolState> = Object.freeze({
  BOOTSTRAPPING: ['READY', 'QUARANTINED', 'HALTED'],
  READY: ['AWAITING_APPROVAL', 'IN_FLIGHT', 'QUARANTINED', 'HALTED'],
  AWAITING_APPROVAL: ['READY', 'IN_FLIGHT', 'QUARANTINED', 'HALTED'],
  IN_FLIGHT: ['READY', 'QUARANTINED', 'HALTED'],
  QUARANTINED: ['READY', 'HALTED', 'BOOTSTRAPPING'],
  HALTED: ['READY', 'QUARANTINED'],
});

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return (table[from] ?? []).includes(to);
}

/** Dispatch states after which an automatic re-dispatch is forbidden forever (INV-09). */
const RESEND_FORBIDDEN: ReadonlySet<DispatchAttemptState> = new Set<DispatchAttemptState>([
  'DISPATCH_MARKED',
  'SEND_ATTEMPTED',
  'ACKNOWLEDGED',
  'UNKNOWN',
  'IRRECOVERABLE_UNCERTAINTY',
  'NOT_SENT_PROVEN',
  'REJECTED',
]);

/**
 * There is no state in which the same dispatch attempt may be sent again. Recovery always
 * produces evidence or a new owner-approved plan, never a resend under an old marker.
 */
export function mayAutomaticallyResend(state: DispatchAttemptState): boolean {
  return !RESEND_FORBIDDEN.has(state) && state !== 'PREPARED';
}

const TERMINAL_VENUE_STATUSES: ReadonlySet<VenueOrderStatus> = new Set<VenueOrderStatus>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
]);

/**
 * Terminal means "the venue will produce no further executions for this order". It says
 * nothing about whether our accounting for it is complete (INV-15).
 */
export function isTerminalVenueStatus(status: VenueOrderStatus): boolean {
  return TERMINAL_VENUE_STATUSES.has(status);
}

/**
 * Releasing reserved capital requires a terminal venue status AND reconciled accounting
 * AND a complete account observation boundary. Any one of the three alone is insufficient
 * (INV-10, TEST-PLAN T-021).
 */
export function mayReleaseUnusedReservation(input: {
  /** Absent when no order was ever observed, as in a proven-unsent attempt. */
  readonly venueStatus: VenueOrderStatus | null;
  readonly accounting: AccountingState;
  readonly coverage: ObservationCoverageState;
  readonly dispatchState: DispatchAttemptState;
}): boolean {
  // ADR-0001's positive recovery path. A proven-unsent attempt has no venue status, because
  // no order exists to have one: requiring a terminal status made NOT_SENT_PROVEN unable to
  // release the reservations the ADR says it releases. Coverage must still be COMPLETE, since
  // that is what established the absence in the first place.
  if (input.dispatchState === 'NOT_SENT_PROVEN') {
    return input.coverage === 'COMPLETE';
  }

  // UNKNOWN and IRRECOVERABLE_UNCERTAINTY never release, whatever else is true.
  if (input.dispatchState === 'UNKNOWN' || input.dispatchState === 'IRRECOVERABLE_UNCERTAINTY') {
    return false;
  }

  return (
    input.venueStatus !== null &&
    isTerminalVenueStatus(input.venueStatus) &&
    input.accounting === 'RECONCILED' &&
    input.coverage === 'COMPLETE'
  );
}
