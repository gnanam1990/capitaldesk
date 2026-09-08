import { violate } from './errors.js';
import type { PlanState } from './states.js';

/**
 * Owner lifecycle actions (ADR-0006).
 *
 * The original route table promised owner defer/revise, policy management and credential
 * lifecycle in the UI without contracts, leaving each implementer to invent consequential
 * mutations. This table is the frozen enumeration: actor scope, idempotency scope and the
 * effect on a sealed plan are stated once, here.
 */

export const LIFECYCLE_ACTIONS = [
  'INTENT_DEFER',
  'INTENT_REINSTATE',
  'POLICY_VERSION_PUBLISH',
  'CREDENTIAL_ISSUE',
  'CREDENTIAL_REVOKE',
  'CREDENTIAL_ROTATE',
  'STRATEGY_ARCHIVE',
  'ACCOUNT_LINK',
  'ACCOUNT_UNLINK',
  'POOL_CREATE',
  'POOL_HALT',
  'POOL_RESUME',
  'POOL_EPOCH_ROTATE',
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export type ActorScope = 'owner' | 'operator' | 'viewer' | 'agent';

/**
 * Declared policy for what an action does to a plan that is already sealed.
 *
 * `INVALIDATE_UNMARKED` invalidates a sealed plan that has not yet committed its dispatch
 * marker. Once marked it does not refuse and does not pretend to recall the order: see
 * {@link resolveSealedPlanEffect} for what actually happens after the marker.
 *
 * `REFUSED_WHILE_IN_FLIGHT` is for actions whose meaning would be incoherent mid-flight —
 * unlinking the account or rotating the epoch under an order that may be live.
 */
export type SealedPlanEffect = 'NONE' | 'INVALIDATE_UNMARKED' | 'REFUSED_WHILE_IN_FLIGHT';

/** What actually happens to the current plan when the action is applied now. */
export type ResolvedSealedPlanEffect =
  /** Nothing about the current plan changes. */
  | 'NONE'
  /** The sealed but unmarked plan is invalidated and its reservations released with it. */
  | 'INVALIDATE'
  /**
   * The marker is already committed. The action takes effect on FUTURE dispatch authority
   * only: it does not invalidate the in-flight plan, does not release or alter its
   * reservations, and is not a cancellation of anything the venue has accepted. Owner halt
   * is a durable refusal to dispatch again, never a venue instruction (TDD section 9).
   */
  | 'FUTURE_AUTHORITY_ONLY'
  /** The action is refused entirely while a dispatch is in flight. */
  | 'REFUSED';

export interface LifecycleContract {
  readonly action: LifecycleAction;
  /**
   * Explicit allowlist of actor scopes. This is an allowlist rather than a single required
   * role: the single owner of a pool can perform operator actions such as halting, and an
   * equality check against one role would have locked the owner out of their own kill
   * switch.
   */
  readonly allowedActors: readonly ActorScope[];
  /** Scope within which the Idempotency-Key must be unique. */
  readonly idempotencyScope: 'pool' | 'workspace' | 'strategyTarget' | 'credential';
  /** Optimistic concurrency: the client must send the version it observed. */
  readonly requiresExpectedVersion: boolean;
  readonly sealedPlanEffect: SealedPlanEffect;
  readonly event: string;
}

export const LIFECYCLE_CONTRACTS: Readonly<Record<LifecycleAction, LifecycleContract>> =
  Object.freeze({
    INTENT_DEFER: {
      action: 'INTENT_DEFER',
      allowedActors: ['owner'],
      idempotencyScope: 'strategyTarget',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'INVALIDATE_UNMARKED',
      event: 'intent.deferred',
    },
    INTENT_REINSTATE: {
      action: 'INTENT_REINSTATE',
      allowedActors: ['owner'],
      idempotencyScope: 'strategyTarget',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'NONE',
      event: 'intent.reinstated',
    },
    POLICY_VERSION_PUBLISH: {
      action: 'POLICY_VERSION_PUBLISH',
      allowedActors: ['owner'],
      idempotencyScope: 'pool',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'INVALIDATE_UNMARKED',
      event: 'policy.published',
    },
    CREDENTIAL_ISSUE: {
      action: 'CREDENTIAL_ISSUE',
      allowedActors: ['owner'],
      idempotencyScope: 'credential',
      requiresExpectedVersion: false,
      sealedPlanEffect: 'NONE',
      event: 'credential.issued',
    },
    CREDENTIAL_REVOKE: {
      action: 'CREDENTIAL_REVOKE',
      allowedActors: ['owner'],
      idempotencyScope: 'credential',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'INVALIDATE_UNMARKED',
      event: 'credential.revoked',
    },
    CREDENTIAL_ROTATE: {
      action: 'CREDENTIAL_ROTATE',
      allowedActors: ['owner'],
      idempotencyScope: 'credential',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'INVALIDATE_UNMARKED',
      event: 'credential.rotated',
    },
    STRATEGY_ARCHIVE: {
      action: 'STRATEGY_ARCHIVE',
      allowedActors: ['owner'],
      idempotencyScope: 'pool',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'INVALIDATE_UNMARKED',
      event: 'strategy.archived',
    },
    ACCOUNT_LINK: {
      action: 'ACCOUNT_LINK',
      allowedActors: ['owner'],
      idempotencyScope: 'workspace',
      requiresExpectedVersion: false,
      sealedPlanEffect: 'NONE',
      event: 'account.linked',
    },
    ACCOUNT_UNLINK: {
      action: 'ACCOUNT_UNLINK',
      allowedActors: ['owner'],
      idempotencyScope: 'workspace',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'REFUSED_WHILE_IN_FLIGHT',
      event: 'account.unlinked',
    },
    POOL_CREATE: {
      action: 'POOL_CREATE',
      allowedActors: ['owner'],
      idempotencyScope: 'workspace',
      requiresExpectedVersion: false,
      sealedPlanEffect: 'NONE',
      event: 'pool.created',
    },
    POOL_HALT: {
      action: 'POOL_HALT',
      allowedActors: ['owner', 'operator'],
      idempotencyScope: 'pool',
      requiresExpectedVersion: false,
      sealedPlanEffect: 'INVALIDATE_UNMARKED',
      event: 'pool.halted',
    },
    POOL_RESUME: {
      action: 'POOL_RESUME',
      allowedActors: ['owner'],
      idempotencyScope: 'pool',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'NONE',
      event: 'pool.resumed',
    },
    POOL_EPOCH_ROTATE: {
      action: 'POOL_EPOCH_ROTATE',
      allowedActors: ['owner'],
      idempotencyScope: 'pool',
      requiresExpectedVersion: true,
      sealedPlanEffect: 'REFUSED_WHILE_IN_FLIGHT',
      event: 'pool.epochRotated',
    },
  });

/**
 * Whether a dispatch marker has been committed for this plan.
 *
 * This is *evidence*, not an inference from the plan's state. `MANUAL_REVIEW` is reachable
 * before the marker — an invalid preview or a failed eligibility check lands there — so
 * treating it as always in flight meant a halt or credential revocation against an unmarked
 * plan returned FUTURE_AUTHORITY_ONLY and left the plan live instead of invalidating it.
 *
 * Once the marker is committed nothing local can retract the order: a halt, revocation or
 * policy change disables future authority, never releases reservations, never rewrites the
 * approval and never asserts the venue cancelled anything (TDD section 9, INV-09, INV-10).
 */
/**
 * The operational phase of a pool's plan, as three mutually exclusive values.
 *
 * Deliberately not a pair of booleans. An earlier version used `sealedPlanExists`, which is
 * unsafe in an append-only system: sealed economic records are retained forever, so the flag
 * stays true long after the plan stopped being invalidatable, and "exists" quietly stops
 * meaning "still open". A phase makes the invalid combinations unrepresentable rather than
 * merely rejected.
 */
export type PlanDispatchPhase =
  /** No sealed plan is open: pre-seal, or a previous one reached a terminal state. */
  | 'NO_ACTIVE_SEALED_PLAN'
  /** A sealed plan is open and no dispatch marker has been committed. */
  | 'SEALED_UNMARKED'
  /** A dispatch marker exists, so an order may be live at the venue. */
  | 'MARKED';

export interface PlanDispatchContext {
  /**
   * The plan's state. Diagnostic: the phase decides the outcome, because `MANUAL_REVIEW` is
   * reachable in all three phases and no state determines the phase on its own.
   */
  readonly state: PlanState;
  readonly dispatchPhase: PlanDispatchPhase;
}

/**
 * States that can only occur in one phase. `MANUAL_REVIEW` is absent on purpose: it is
 * reachable before sealing, while sealed and unmarked, and after a marker, which is exactly
 * why the phase is supplied rather than inferred.
 */
const PHASE_BY_STATE: Partial<Record<PlanState, PlanDispatchPhase>> = {
  PREVIEW: 'NO_ACTIVE_SEALED_PLAN',
  COMPLETED: 'NO_ACTIVE_SEALED_PLAN',
  PARTIAL: 'NO_ACTIVE_SEALED_PLAN',
  UNFILLED: 'NO_ACTIVE_SEALED_PLAN',
  INVALIDATED: 'NO_ACTIVE_SEALED_PLAN',
  DECLINED: 'NO_ACTIVE_SEALED_PLAN',
  EXPIRED: 'NO_ACTIVE_SEALED_PLAN',
  SEALED_AWAITING_APPROVAL: 'SEALED_UNMARKED',
  APPROVED: 'SEALED_UNMARKED',
  DISPATCH_PENDING: 'SEALED_UNMARKED',
  EXECUTING: 'MARKED',
  RECONCILING: 'MARKED',
};

/**
 * Refuse a phase the state cannot be in.
 *
 * Checked before any early return, so an incoherent context is never silently accepted just
 * because the action happened not to care about the plan.
 */
export function assertPhaseConsistent(plan: PlanDispatchContext): void {
  const required = PHASE_BY_STATE[plan.state];
  if (required !== undefined && required !== plan.dispatchPhase) {
    violate(
      'IDENTITY_MALFORMED',
      `plan state ${plan.state} cannot be in phase ${plan.dispatchPhase}`,
      {
        state: plan.state,
        dispatchPhase: plan.dispatchPhase,
        expected: required,
      },
    );
  }
}

export function mayActorPerform(action: LifecycleAction, actor: ActorScope): boolean {
  return LIFECYCLE_CONTRACTS[action].allowedActors.includes(actor);
}

/** What the action does to the current plan, given where that plan actually is. */
export function resolveSealedPlanEffect(
  action: LifecycleAction,
  plan: PlanDispatchContext | null,
): ResolvedSealedPlanEffect {
  const contract = LIFECYCLE_CONTRACTS[action];
  if (plan === null) return 'NONE';

  // Validated before the early return below, so an incoherent context is refused whether or
  // not this particular action cares about the plan.
  assertPhaseConsistent(plan);
  if (contract.sealedPlanEffect === 'NONE') return 'NONE';

  if (contract.sealedPlanEffect === 'REFUSED_WHILE_IN_FLIGHT') {
    // The marker is what makes the action incoherent: an order may be live at the venue.
    return plan.dispatchPhase === 'MARKED' ? 'REFUSED' : 'NONE';
  }

  // INVALIDATE_UNMARKED
  switch (plan.dispatchPhase) {
    case 'SEALED_UNMARKED':
      return 'INVALIDATE';
    case 'MARKED':
      return 'FUTURE_AUTHORITY_ONLY';
    case 'NO_ACTIVE_SEALED_PLAN':
      return 'NONE';
  }
}

export function assertLifecycleActionPermitted(
  action: LifecycleAction,
  actor: ActorScope,
  plan: PlanDispatchContext | null,
): void {
  const contract = LIFECYCLE_CONTRACTS[action];
  if (!mayActorPerform(action, actor)) {
    violate('AUTHZ_SCOPE_DENIED', 'actor scope may not perform this lifecycle action', {
      action,
      actor,
      allowed: contract.allowedActors.join(','),
    });
  }
  if (resolveSealedPlanEffect(action, plan) === 'REFUSED') {
    violate('PLAN_IN_FLIGHT_FOR_POOL', 'action is refused while a dispatch is in flight', {
      action,
      planState: plan?.state ?? 'none',
    });
  }
}

/**
 * Owner deferral scope (ADR-0006/ADR-0008): a deferral binds the strategyTargetKey, not one
 * revision, so a later revision N+1 from the same agent cannot evade it. It ends only when
 * the owner reinstates, or when an explicit `untilAt` passes.
 */
export interface DeferralScope {
  readonly strategyTargetKey: string;
  readonly deferredAt: string;
  readonly untilAt: string | null;
  readonly reinstatedAt: string | null;
}

export function isDeferredAt(scope: DeferralScope, nowIso: string): boolean {
  if (scope.reinstatedAt !== null && Date.parse(scope.reinstatedAt) <= Date.parse(nowIso)) {
    return false;
  }
  if (scope.untilAt !== null && Date.parse(scope.untilAt) <= Date.parse(nowIso)) {
    return false;
  }
  return Date.parse(scope.deferredAt) <= Date.parse(nowIso);
}
