import { violate } from '@capitaldesk/contracts';
import type { ActorRole, Capability } from './capabilities.js';
import { NEVER_GRANTED, roleHasCapability } from './capabilities.js';

/**
 * Who is asking, and what they are bound to.
 *
 * **This factory validates shape; it does not establish provenance.** `principal()` is
 * exported and will accept any object that satisfies its invariants, so it cannot by itself
 * guarantee that the fields came from a stored credential rather than a request body. What it
 * rules out is an internally incoherent principal: an agent credential carrying a human role,
 * an owner session carrying the agent role, an agent not bound to one pool and one strategy.
 *
 * Provenance is enforced one layer up, by the authentication adapter, which constructs a
 * principal *only* from columns it has just read from the database and never from request
 * input. That is the acceptance gate for this module — no agent-controlled field selects its
 * owner, permission level or execution account — and it is proved by route-level tests that
 * send forged identity fields, not by this type.
 */
export type PrincipalKind = 'owner-session' | 'agent-credential';

/**
 * The scope a principal is confined to.
 *
 * `null` means "not narrowed", and is only legitimate for human roles, whose membership is
 * workspace-wide. An agent is always narrowed to exactly one pool and one strategy, which
 * `principal()` enforces rather than trusting the caller to have set.
 */
export interface PrincipalScope {
  readonly workspaceId: string;
  readonly poolId: string | null;
  readonly strategyId: string | null;
}

export interface Principal {
  readonly kind: PrincipalKind;
  readonly role: ActorRole;
  /** The user id or agent credential id this principal was authenticated as. */
  readonly subjectId: string;
  readonly scope: PrincipalScope;
}

export function principal(init: Principal): Principal {
  if (init.subjectId.length === 0) {
    violate('AUTHZ_SCOPE_DENIED', 'a principal must name the subject it authenticated as');
  }
  if (init.scope.workspaceId.length === 0) {
    violate('AUTHZ_SCOPE_DENIED', 'a principal must be bound to a workspace');
  }

  // An agent credential is issued for one strategy in one pool. A credential that failed to
  // record either is not a narrower agent, it is an unbounded one.
  if (init.kind === 'agent-credential') {
    if (init.role !== 'agent') {
      violate(
        'AUTHZ_CREDENTIAL_CLASS_DENIED',
        'an agent credential can only carry the agent role',
        {
          role: init.role,
        },
      );
    }
    if (init.scope.poolId === null || init.scope.strategyId === null) {
      violate(
        'AUTHZ_SCOPE_DENIED',
        'an agent credential must be bound to one pool and one strategy',
      );
    }
  }

  // A session never carries the agent role: the two credential kinds authenticate on separate
  // route paths and must not be able to impersonate one another (token-type confusion).
  if (init.kind === 'owner-session' && init.role === 'agent') {
    violate('AUTHZ_CREDENTIAL_CLASS_DENIED', 'an owner session cannot carry the agent role');
  }

  return Object.freeze({
    kind: init.kind,
    role: init.role,
    subjectId: init.subjectId,
    scope: Object.freeze({ ...init.scope }),
  });
}

/** What the request is asking to act on. Supplied by the route, from the URL path. */
export interface RequestedScope {
  readonly workspaceId: string;
  readonly poolId?: string | undefined;
  readonly strategyId?: string | undefined;
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | 'CAPABILITY_NOT_GRANTED'
        | 'CAPABILITY_NEVER_GRANTED'
        | 'WORKSPACE_SCOPE_MISMATCH'
        | 'POOL_SCOPE_MISMATCH'
        | 'STRATEGY_SCOPE_MISMATCH'
        | 'SCOPE_NOT_SPECIFIED';
      readonly detail: string;
    };

/**
 * Decide whether this principal may perform this capability on this scope.
 *
 * Capability and scope are checked separately and both must pass. Checking only the
 * capability is how a correctly-roled principal reaches another tenant's object with a valid
 * identifier; checking only the scope is how a viewer approves a plan in a workspace they can
 * legitimately read.
 */
export function authorize(
  actor: Principal,
  capability: Capability,
  requested: RequestedScope,
): AuthorizationDecision {
  if (NEVER_GRANTED.includes(capability)) {
    return {
      allowed: false,
      reason: 'CAPABILITY_NEVER_GRANTED',
      detail: `${capability} is not reachable through an authenticated request by any role`,
    };
  }

  if (!roleHasCapability(actor.role, capability)) {
    return {
      allowed: false,
      reason: 'CAPABILITY_NOT_GRANTED',
      detail: `role ${actor.role} does not hold ${capability}`,
    };
  }

  if (requested.workspaceId !== actor.scope.workspaceId) {
    return {
      allowed: false,
      reason: 'WORKSPACE_SCOPE_MISMATCH',
      detail: 'the request names a workspace this principal is not a member of',
    };
  }

  // A narrowed principal may only act inside its narrowing. A request that omits the pool
  // while the principal is pool-bound is refused rather than treated as "all pools": an
  // absent scope must never widen authority.
  if (actor.scope.poolId !== null) {
    if (requested.poolId === undefined) {
      return {
        allowed: false,
        reason: 'SCOPE_NOT_SPECIFIED',
        detail: 'this principal is bound to one pool, so the request must name it',
      };
    }
    if (requested.poolId !== actor.scope.poolId) {
      return {
        allowed: false,
        reason: 'POOL_SCOPE_MISMATCH',
        detail: 'the request names a pool this principal is not bound to',
      };
    }
  }

  if (actor.scope.strategyId !== null) {
    if (requested.strategyId === undefined) {
      return {
        allowed: false,
        reason: 'SCOPE_NOT_SPECIFIED',
        detail: 'this principal is bound to one strategy, so the request must name it',
      };
    }
    if (requested.strategyId !== actor.scope.strategyId) {
      return {
        allowed: false,
        reason: 'STRATEGY_SCOPE_MISMATCH',
        detail: 'the request names a strategy this principal is not bound to',
      };
    }
  }

  return { allowed: true };
}

/** Throwing form, for route guards. Carries a stable reason code, never the scope values. */
export function assertAuthorized(
  actor: Principal,
  capability: Capability,
  requested: RequestedScope,
): void {
  const decision = authorize(actor, capability, requested);
  if (decision.allowed) return;
  violate(
    decision.reason === 'CAPABILITY_NOT_GRANTED' || decision.reason === 'CAPABILITY_NEVER_GRANTED'
      ? 'AUTHZ_SCOPE_DENIED'
      : 'IDENTITY_SCOPE_MISMATCH',
    decision.detail,
    { capability, role: actor.role, reason: decision.reason },
  );
}
