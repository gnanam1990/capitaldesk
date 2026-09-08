import { describe, expect, it } from 'vitest';
import {
  type RequestedScope,
  ACTOR_ROLES,
  CAPABILITIES,
  NEVER_GRANTED,
  assertAuthorized,
  authorize,
  grantsFor,
  principal,
  roleHasCapability,
  type Capability,
  type Principal,
} from './index.js';

const WORKSPACE = 'ws-primary';
const POOL = 'pool-a';
const STRATEGY = 'strategy-a';

const owner = principal({
  kind: 'owner-session',
  role: 'owner',
  subjectId: 'user-owner',
  scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
});
const operator = principal({ ...owner, role: 'operator', subjectId: 'user-operator' });
const viewer = principal({ ...owner, role: 'viewer', subjectId: 'user-viewer' });
const agent = principal({
  kind: 'agent-credential',
  role: 'agent',
  subjectId: 'cred-1',
  scope: { workspaceId: WORKSPACE, poolId: POOL, strategyId: STRATEGY },
});

const inWorkspace = { workspaceId: WORKSPACE };
const inPool = { workspaceId: WORKSPACE, poolId: POOL };
const inStrategy = { workspaceId: WORKSPACE, poolId: POOL, strategyId: STRATEGY };

// Annotated, not inferred: without this the default parameter narrows the type to the full
// tuple and every deliberately partial scope below becomes a type error.
const allowed = (a: Principal, c: Capability, s: RequestedScope = inStrategy): boolean =>
  authorize(a, c, s).allowed;

describe('the permission matrix is complete and closed', () => {
  it('assigns every capability a decision for every role', () => {
    // A capability with no entry would otherwise be silently denied by omission rather than
    // by decision, and a later reader could not tell which.
    for (const capability of CAPABILITIES) {
      for (const role of ACTOR_ROLES) {
        expect(typeof roleHasCapability(role, capability), `${role}/${capability}`).toBe('boolean');
      }
    }
  });

  it('grants no role a capability outside the declared set', () => {
    for (const role of ACTOR_ROLES) {
      for (const capability of grantsFor(role)) {
        expect(CAPABILITIES, `${role}/${capability}`).toContain(capability);
      }
    }
  });

  it('never grants venue dispatch to any role', () => {
    for (const role of ACTOR_ROLES) {
      expect(roleHasCapability(role, 'venue.dispatch'), role).toBe(false);
    }
    expect(NEVER_GRANTED).toContain('venue.dispatch');
  });

  it('denies a never-granted capability even to the owner', () => {
    // INV-01: no authenticated request reaches the signing boundary, whatever the role.
    const decision = authorize(owner, 'venue.dispatch', inPool);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : '').toBe('CAPABILITY_NEVER_GRANTED');
  });
});

describe('role capabilities', () => {
  it('lets the owner run the economic workflow', () => {
    for (const capability of [
      'pool.bootstrap',
      'allocation.write',
      'plan.seal',
      'plan.approve',
      'plan.decline',
      'policy.publish',
      'pool.resume',
      'credential.issue',
    ] as const) {
      expect(allowed(owner, capability, inPool), capability).toBe(true);
    }
  });

  describe('operator holds recovery authority but cannot create exposure', () => {
    it('can halt and reconcile', () => {
      expect(allowed(operator, 'pool.halt', inPool)).toBe(true);
      expect(allowed(operator, 'pool.reconcile', inPool)).toBe(true);
    });

    it('cannot resume, because resuming reintroduces risk', () => {
      expect(allowed(operator, 'pool.resume', inPool)).toBe(false);
    });

    it('cannot approve, seal, allocate or touch credentials', () => {
      for (const capability of [
        'plan.approve',
        'plan.seal',
        'allocation.write',
        'credential.issue',
        'credential.revoke',
        'credential.rotate',
        'policy.publish',
        'pool.bootstrap',
        'strategy.archive',
        'account.unlink',
      ] as const) {
        expect(allowed(operator, capability, inPool), capability).toBe(false);
      }
    });
  });

  describe('viewer is read-only', () => {
    it('can read', () => {
      for (const capability of [
        'pool.read',
        'ledger.read',
        'plan.read',
        'evidence.read',
      ] as const) {
        expect(allowed(viewer, capability, inPool), capability).toBe(true);
      }
    });

    it('holds no capability that changes anything', () => {
      const mutating = CAPABILITIES.filter(
        (capability) => !capability.endsWith('.read') && capability !== 'export.create',
      );
      for (const capability of mutating) {
        expect(allowed(viewer, capability, inPool), capability).toBe(false);
      }
    });

    it('cannot even halt, which an operator can', () => {
      expect(allowed(viewer, 'pool.halt', inPool)).toBe(false);
      expect(allowed(operator, 'pool.halt', inPool)).toBe(true);
    });
  });

  describe('agent proposes and reads, and holds nothing else', () => {
    it('can propose a target and read its own state', () => {
      expect(allowed(agent, 'intent.propose')).toBe(true);
      expect(allowed(agent, 'intent.read')).toBe(true);
      expect(allowed(agent, 'strategy.read')).toBe(true);
      expect(allowed(agent, 'market.read')).toBe(true);
    });

    it('cannot seal, approve, allocate, administer or dispatch', () => {
      for (const capability of [
        'plan.seal',
        'plan.approve',
        'plan.decline',
        'allocation.write',
        'pool.bootstrap',
        'pool.halt',
        'pool.resume',
        'pool.reconcile',
        'policy.publish',
        'strategy.create',
        'strategy.archive',
        'credential.issue',
        'credential.revoke',
        'credential.rotate',
        'intent.defer',
        'intent.reinstate',
        'account.link',
        'account.unlink',
        'incident.resolve',
        'pool.epochRotate',
        'export.create',
        'plan.preview',
        'venue.dispatch',
      ] as const) {
        expect(allowed(agent, capability), capability).toBe(false);
      }
    });

    it('holds strictly fewer capabilities than a viewer plus proposing', () => {
      const agentOnly = grantsFor('agent').filter((c) => !grantsFor('viewer').includes(c));
      expect(agentOnly).toEqual(['intent.propose']);
    });
  });
});

describe('scope binding', () => {
  it('refuses a workspace the principal is not a member of', () => {
    const decision = authorize(owner, 'pool.read', { workspaceId: 'ws-other', poolId: POOL });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : '').toBe('WORKSPACE_SCOPE_MISMATCH');
  });

  it('refuses another pool in the same workspace for a pool-bound principal', () => {
    const decision = authorize(agent, 'intent.propose', {
      workspaceId: WORKSPACE,
      poolId: 'pool-b',
      strategyId: STRATEGY,
    });
    expect(decision.allowed === false ? decision.reason : '').toBe('POOL_SCOPE_MISMATCH');
  });

  it("refuses another strategy's target, even in the agent's own pool", () => {
    const decision = authorize(agent, 'intent.propose', {
      workspaceId: WORKSPACE,
      poolId: POOL,
      strategyId: 'strategy-b',
    });
    expect(decision.allowed === false ? decision.reason : '').toBe('STRATEGY_SCOPE_MISMATCH');
  });

  it('refuses an omitted scope rather than treating it as unrestricted', () => {
    // An absent identifier must never widen authority: this is how a bound principal would
    // otherwise reach every pool by simply not naming one.
    expect(authorize(agent, 'intent.propose', inWorkspace).allowed).toBe(false);
    expect(authorize(agent, 'intent.propose', inPool).allowed).toBe(false);
    const decision = authorize(agent, 'intent.propose', inWorkspace);
    expect(decision.allowed === false ? decision.reason : '').toBe('SCOPE_NOT_SPECIFIED');
  });

  it('lets a workspace-wide human principal act across pools', () => {
    expect(allowed(owner, 'pool.read', { workspaceId: WORKSPACE, poolId: 'pool-b' })).toBe(true);
  });

  it('checks capability and scope independently', () => {
    // Right role, wrong tenant.
    expect(
      authorize(owner, 'plan.approve', { workspaceId: 'ws-other', poolId: POOL }).allowed,
    ).toBe(false);
    // Right tenant, wrong role.
    expect(authorize(viewer, 'plan.approve', inPool).allowed).toBe(false);
    // Both right.
    expect(authorize(owner, 'plan.approve', inPool).allowed).toBe(true);
  });
});

describe('a principal cannot be forged into wider authority', () => {
  it('refuses an agent credential that carries a human role', () => {
    for (const role of ['owner', 'operator', 'viewer'] as const) {
      expect(
        () =>
          principal({
            kind: 'agent-credential',
            role,
            subjectId: 'cred-1',
            scope: { workspaceId: WORKSPACE, poolId: POOL, strategyId: STRATEGY },
          }),
        role,
      ).toThrow(/agent credential can only carry the agent role/);
    }
  });

  it('refuses an owner session that carries the agent role', () => {
    // Token-type confusion in the other direction: the two credential kinds authenticate on
    // separate route paths and must not impersonate one another.
    expect(() =>
      principal({
        kind: 'owner-session',
        role: 'agent',
        subjectId: 'user-1',
        scope: { workspaceId: WORKSPACE, poolId: null, strategyId: null },
      }),
    ).toThrow(/owner session cannot carry the agent role/);
  });

  it('refuses an agent credential that is not bound to a pool and a strategy', () => {
    for (const scope of [
      { workspaceId: WORKSPACE, poolId: null, strategyId: STRATEGY },
      { workspaceId: WORKSPACE, poolId: POOL, strategyId: null },
      { workspaceId: WORKSPACE, poolId: null, strategyId: null },
    ]) {
      expect(
        () => principal({ kind: 'agent-credential', role: 'agent', subjectId: 'c', scope }),
        JSON.stringify(scope),
      ).toThrow(/bound to one pool and one strategy/);
    }
  });

  it('refuses a principal with no subject or no workspace', () => {
    expect(() => principal({ ...owner, subjectId: '' })).toThrow(/name the subject/);
    expect(() =>
      principal({ ...owner, scope: { workspaceId: '', poolId: null, strategyId: null } }),
    ).toThrow(/bound to a workspace/);
  });

  it('freezes the principal so a later handler cannot widen it in place', () => {
    const mutable = agent as { scope: { poolId: string | null } };
    expect(() => {
      mutable.scope.poolId = 'pool-b';
    }).toThrow();
    expect(agent.scope.poolId).toBe(POOL);
  });
});

describe('assertAuthorized', () => {
  it('passes silently when permitted', () => {
    expect(() => assertAuthorized(owner, 'plan.approve', inPool)).not.toThrow();
  });

  it('throws a scope-denied violation for a missing capability', () => {
    expect(() => assertAuthorized(agent, 'plan.approve', inStrategy)).toThrow(/AUTHZ_SCOPE_DENIED/);
  });

  it('throws a scope-mismatch violation for another tenant', () => {
    expect(() =>
      assertAuthorized(owner, 'pool.read', { workspaceId: 'ws-other', poolId: POOL }),
    ).toThrow(/IDENTITY_SCOPE_MISMATCH/);
  });

  it('does not leak the requested scope values into the error', () => {
    try {
      assertAuthorized(owner, 'pool.read', { workspaceId: 'ws-secret-tenant', poolId: POOL });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('ws-secret-tenant');
    }
  });
});
