import { describe, expect, it } from 'vitest';
import { authorizeAllocation, type AllocationRequest } from './allocation.js';

/**
 * An owner allocation moves an internal claim, and nothing else (TDD section 6; prompt 06 task 3).
 *
 * It does not move funds at the venue. Every rule below exists so that it cannot be mistaken
 * for one, or used to give a strategy something HOUSE does not have.
 */
const OWNER = { role: 'owner', credentialClass: 'OWNER_SESSION' } as const;

const REQUEST: AllocationRequest = {
  actor: OWNER,
  from: 'HOUSE',
  to: 'strategy-a',
  asset: { code: 'USDT', scaleVersion: 'v1' },
  atoms: 500n,
  houseAvailableAtoms: 1_000n,
  strategyIsActive: true,
};

describe('allocation authorization', () => {
  it('authorizes an owner moving HOUSE availability to an active strategy', () => {
    expect(authorizeAllocation(REQUEST)).toEqual({ ok: true });
  });

  it('authorizes the return leg, strategy back to HOUSE', () => {
    expect(
      authorizeAllocation({
        ...REQUEST,
        from: 'strategy-a',
        to: 'HOUSE',
        strategyAvailableAtoms: 500n,
      }),
    ).toEqual({ ok: true });
  });

  describe('only the owner may allocate', () => {
    it('refuses an agent credential', () => {
      // An agent proposes. Giving it budget authority would let a proposal fund itself.
      expect(
        authorizeAllocation({
          ...REQUEST,
          actor: { role: 'agent', credentialClass: 'AGENT_PROPOSAL' },
        }),
      ).toEqual({ ok: false, reason: 'ACTOR_MAY_NOT_ALLOCATE' });
    });

    it('refuses an operator and a viewer', () => {
      for (const role of ['operator', 'viewer'] as const) {
        expect(
          authorizeAllocation({ ...REQUEST, actor: { role, credentialClass: 'OWNER_SESSION' } }),
          role,
        ).toEqual({ ok: false, reason: 'ACTOR_MAY_NOT_ALLOCATE' });
      }
    });

    it('refuses an owner role presented on a non-session credential', () => {
      // The role alone is a claim; the credential class is what carries it.
      expect(
        authorizeAllocation({
          ...REQUEST,
          actor: { role: 'owner', credentialClass: 'AGENT_PROPOSAL' },
        }),
      ).toEqual({ ok: false, reason: 'ACTOR_MAY_NOT_ALLOCATE' });
    });
  });

  describe('only HOUSE and a strategy, never two strategies', () => {
    it('refuses a strategy-to-strategy move', () => {
      // T-020: an internal transfer between strategies would look like a sale that never
      // happened, and cross-strategy inventory transfer is explicitly a future release.
      expect(authorizeAllocation({ ...REQUEST, from: 'strategy-a', to: 'strategy-b' })).toEqual({
        ok: false,
        reason: 'NOT_A_HOUSE_LEG',
      });
    });

    it('refuses a move from HOUSE to HOUSE', () => {
      expect(authorizeAllocation({ ...REQUEST, from: 'HOUSE', to: 'HOUSE' })).toEqual({
        ok: false,
        reason: 'NOT_A_HOUSE_LEG',
      });
    });

    it('refuses a move to ASSET_CONTROL, which is not an owner at all', () => {
      // Crediting control without a matching claim is how units stop having an owner.
      expect(authorizeAllocation({ ...REQUEST, to: 'ASSET_CONTROL' })).toEqual({
        ok: false,
        reason: 'NOT_A_HOUSE_LEG',
      });
    });
  });

  describe('the amount', () => {
    it('refuses zero and negative amounts', () => {
      for (const atoms of [0n, -1n, -500n]) {
        expect(authorizeAllocation({ ...REQUEST, atoms }), String(atoms)).toEqual({
          ok: false,
          reason: 'NONPOSITIVE_AMOUNT',
        });
      }
    });

    it('refuses more than HOUSE has available', () => {
      expect(authorizeAllocation({ ...REQUEST, atoms: 1_001n })).toEqual({
        ok: false,
        reason: 'EXCEEDS_AVAILABLE',
        availableAtoms: 1_000n,
      });
    });

    it('allows exactly what HOUSE has available', () => {
      expect(authorizeAllocation({ ...REQUEST, atoms: 1_000n })).toEqual({ ok: true });
    });

    it('measures the return leg against the strategy, not against HOUSE', () => {
      // Using HOUSE availability for a return would let a strategy give back more than it has.
      expect(
        authorizeAllocation({
          ...REQUEST,
          from: 'strategy-a',
          to: 'HOUSE',
          atoms: 600n,
          strategyAvailableAtoms: 500n,
        }),
      ).toEqual({ ok: false, reason: 'EXCEEDS_AVAILABLE', availableAtoms: 500n });
    });

    it('refuses a return leg with no strategy availability supplied', () => {
      // Absent is not zero and certainly not unlimited: the caller has not established it.
      expect(authorizeAllocation({ ...REQUEST, from: 'strategy-a', to: 'HOUSE' })).toEqual({
        ok: false,
        reason: 'AVAILABILITY_UNKNOWN',
      });
    });
  });

  it('refuses an archived strategy', () => {
    expect(authorizeAllocation({ ...REQUEST, strategyIsActive: false })).toEqual({
      ok: false,
      reason: 'STRATEGY_NOT_ACTIVE',
    });
  });

  it('reports the first failing rule, deterministically', () => {
    // A request that breaks several rules always names the same one, so an operator retrying
    // sees progress rather than a different complaint each time.
    const broken = authorizeAllocation({
      ...REQUEST,
      actor: { role: 'agent', credentialClass: 'AGENT_PROPOSAL' },
      from: 'strategy-a',
      to: 'strategy-b',
      atoms: -1n,
    });
    expect(broken).toEqual({ ok: false, reason: 'ACTOR_MAY_NOT_ALLOCATE' });
  });
});
