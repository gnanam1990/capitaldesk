/**
 * Stable reason codes. These strings are a wire contract: they appear in API error
 * envelopes, evidence exports and the console. Renaming one is a breaking change that
 * requires an ADR and coordinated specification/test updates.
 *
 * Required by TDD section 11 and prompt 02 task 5.
 */
export const REASON_CODES = [
  // --- unit, precision and encoding -------------------------------------------------
  'MONEY_ASSET_MISMATCH',
  'MONEY_NEGATIVE_RESULT',
  'MONEY_NOT_AN_INTEGER',
  'MONEY_PRECISION_EXCEEDED',
  'MONEY_INEXACT_CONVERSION',
  'MONEY_UNIT_KIND_MISMATCH',
  'CANONICAL_ENCODING_REJECTED',

  // --- identity ---------------------------------------------------------------------
  'IDENTITY_MALFORMED',
  'IDENTITY_SCOPE_MISMATCH',
  'IDENTITY_EPOCH_MISMATCH',
  'IDENTITY_ENVIRONMENT_MISMATCH',
  'IDENTITY_UNSTABLE_ACCOUNT',
  'GOVERNANCE_LEASE_HELD_ELSEWHERE',

  // --- intent and planning ----------------------------------------------------------
  'INTENT_REVISION_NOT_MONOTONIC',
  'INTENT_REPLAY_BODY_CONFLICT',
  'INTENT_EXPIRED',
  'INTENT_SUPERSEDED',
  'INTENT_DEFERRED_BY_OWNER',
  'INTENT_ZERO_DELTA',
  'PLAN_OPPOSING_INTENT_CONFLICT',
  'PLAN_INSUFFICIENT_CLAIM',
  'PLAN_EXCHANGE_FILTER_UNSATISFIED',
  'PLAN_LIMIT_INCOMPATIBLE',
  'PLAN_COHORT_CLOSED',
  'PLAN_INVALIDATED_BY_OPPOSING_INTENT',
  'PLAN_IN_FLIGHT_FOR_POOL',

  // --- policy and risk --------------------------------------------------------------
  'POLICY_BUDGET_EXCEEDED',
  'POLICY_CONCENTRATION_EXCEEDED',
  'POLICY_CONCENTRATION_UNCOMPUTABLE',
  'POLICY_RISK_INCREASE_HALTED',
  'POLICY_MANDATE_VERSION_STALE',
  'POLICY_CONFIGURATION_MISSING',

  // --- approval and dispatch --------------------------------------------------------
  'APPROVAL_DIGEST_MISMATCH',
  'APPROVAL_EXPIRED',
  'APPROVAL_REVOKED',
  'APPROVAL_ACTOR_UNAUTHORIZED',
  'SUBMISSION_DEADLINE_PASSED',
  'CLOCK_SKEW_UNBOUNDED',
  'DISPATCH_ALREADY_MARKED',
  'DISPATCH_WRITE_CAPABILITY_DISABLED',
  'DISPATCH_NATIVE_CONFIRMATION_MISSING',

  // --- evidence, freshness and reconciliation ---------------------------------------
  'EVIDENCE_INCOMPLETE',
  'EVIDENCE_STALE',
  'EVIDENCE_CONTRADICTORY',
  'OBSERVATION_COVERAGE_INCOMPLETE',
  'OBSERVATION_COVERAGE_UNSUPPORTED',
  'VENUE_OBSERVATION_UNSUPPORTED',
  'EXTERNAL_ACTIVITY_DETECTED',
  'EPOCH_RESET_DETECTED',
  'FEE_ASSET_UNSUPPORTED',
  'FEE_BOUND_UNPROVEN',
  'FEE_EXCEEDED_APPROVED_CAP',
  'ALLOCATION_INFEASIBLE',

  // --- durability and recovery ------------------------------------------------------
  'AUTHORIZATION_DURABILITY_UNMET',
  'RESTORE_ATTRIBUTION_UNRECOVERABLE',
  'DISPATCH_OUTCOME_UNKNOWN',
  'DISPATCH_SENDER_UNFENCED',

  // --- authority and transport ------------------------------------------------------
  'AUTHZ_SCOPE_DENIED',
  'AUTHZ_CREDENTIAL_CLASS_DENIED',
  'IDEMPOTENCY_BODY_CONFLICT',
  'UNSUPPORTED_ACTION',
  'CAPABILITY_UNVERIFIED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set<string>(REASON_CODES);

export function isReasonCode(value: string): value is ReasonCode {
  return REASON_CODE_SET.has(value);
}
