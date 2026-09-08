/**
 * What a principal may do, as a closed set.
 *
 * Capabilities are named for the action, not the route, so a later route rename cannot
 * silently widen authority. Anything absent from this list cannot be authorized at all: the
 * matrix is exhaustive by construction, and a capability with no matrix entry fails the
 * completeness test rather than defaulting to permitted.
 */
export const CAPABILITIES = [
  // --- reading ----------------------------------------------------------------------
  'pool.read',
  'strategy.read',
  'intent.read',
  'plan.read',
  'ledger.read',
  'incident.read',
  'evidence.read',
  'market.read',

  // --- owner economic authority -------------------------------------------------------
  'pool.bootstrap',
  'allocation.write',
  'plan.seal',
  'plan.approve',
  'plan.decline',
  'policy.publish',
  'pool.resume',
  'pool.epochRotate',
  'account.link',
  'account.unlink',
  'incident.resolve',

  // --- owner administration -----------------------------------------------------------
  'strategy.create',
  'strategy.archive',
  'credential.issue',
  'credential.revoke',
  'credential.rotate',
  'intent.defer',
  'intent.reinstate',

  // --- shared operational -------------------------------------------------------------
  'pool.halt',
  'pool.reconcile',
  'plan.preview',
  'export.create',

  // --- proposal -----------------------------------------------------------------------
  'intent.propose',

  /**
   * Signing and sending a venue order. Present so it can be named and denied: no principal
   * holds it, and no HTTP route exposes it. The executor consumes internally authenticated
   * sealed jobs (TDD section 11, INV-01).
   */
  'venue.dispatch',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ACTOR_ROLES = ['owner', 'operator', 'viewer', 'agent'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

/**
 * The permission matrix.
 *
 * Written as an explicit grant list per role rather than as denials, so a capability added
 * later is denied to everyone until someone grants it deliberately. The completeness test
 * asserts every capability appears in this file, so a new one cannot be forgotten into a
 * default.
 */
const GRANTS: Readonly<Record<ActorRole, readonly Capability[]>> = Object.freeze({
  owner: [
    'pool.read',
    'strategy.read',
    'intent.read',
    'plan.read',
    'ledger.read',
    'incident.read',
    'evidence.read',
    'market.read',
    'pool.bootstrap',
    'allocation.write',
    'plan.seal',
    'plan.approve',
    'plan.decline',
    'policy.publish',
    'pool.resume',
    'pool.epochRotate',
    'account.link',
    'account.unlink',
    'incident.resolve',
    'strategy.create',
    'strategy.archive',
    'credential.issue',
    'credential.revoke',
    'credential.rotate',
    'intent.defer',
    'intent.reinstate',
    'pool.halt',
    'pool.reconcile',
    'plan.preview',
    'export.create',
  ],

  /**
   * Recovery without new exposure. An operator can stop the pool and ask for reconciliation,
   * and can read everything; they cannot resume it, approve anything, move claims or touch
   * credentials. Halting reduces risk, resuming reintroduces it — which is why only the owner
   * resumes (ADR-0006).
   */
  operator: [
    'pool.read',
    'strategy.read',
    'intent.read',
    'plan.read',
    'ledger.read',
    'incident.read',
    'evidence.read',
    'market.read',
    'pool.halt',
    'pool.reconcile',
    'plan.preview',
    'export.create',
  ],

  viewer: [
    'pool.read',
    'strategy.read',
    'intent.read',
    'plan.read',
    'ledger.read',
    'incident.read',
    'evidence.read',
    'market.read',
  ],

  /**
   * An agent proposes and reads its own strategy's state. It holds no capability that
   * commits capital, changes authority, or reaches the venue. Note what is absent:
   * `plan.seal`, `plan.approve`, `allocation.write`, every credential capability, and
   * `venue.dispatch` (INV-01).
   *
   * `plan.read` is granted because an agent must learn the outcome of a plan its own intent
   * participated in; the scope check confines that to its own strategy.
   */
  agent: ['intent.propose', 'intent.read', 'plan.read', 'strategy.read', 'market.read'],
});

export function grantsFor(role: ActorRole): readonly Capability[] {
  return GRANTS[role];
}

export function roleHasCapability(role: ActorRole, capability: Capability): boolean {
  return GRANTS[role].includes(capability);
}

/** Capabilities no role may hold through the API, whatever the matrix says. */
export const NEVER_GRANTED: readonly Capability[] = ['venue.dispatch'];
