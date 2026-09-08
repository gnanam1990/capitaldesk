import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_ACTIONS,
  LIFECYCLE_CONTRACTS,
  assertLifecycleActionPermitted,
  isDeferredAt,
  isMarkedPlanState,
  mayActorPerform,
  resolveSealedPlanEffect,
} from './lifecycle.js';
import type { PlanState } from './states.js';

describe('lifecycle contracts', () => {
  it('gives every declared action a contract', () => {
    for (const action of LIFECYCLE_ACTIONS) {
      expect(LIFECYCLE_CONTRACTS[action].action).toBe(action);
      expect(LIFECYCLE_CONTRACTS[action].allowedActors.length).toBeGreaterThan(0);
    }
  });

  it('never grants an agent or viewer a lifecycle mutation', () => {
    for (const action of LIFECYCLE_ACTIONS) {
      expect(mayActorPerform(action, 'agent'), action).toBe(false);
      expect(mayActorPerform(action, 'viewer'), action).toBe(false);
    }
  });

  // --- regression: maintainer review, owner locked out of the kill switch ---------------
  // POOL_HALT declared a single required actor of 'operator' and the check compared for
  // equality, so the pool's owner could not halt their own pool.
  describe('owner authority (regression: draft review)', () => {
    it('lets the owner halt the pool', () => {
      expect(mayActorPerform('POOL_HALT', 'owner')).toBe(true);
      expect(() => assertLifecycleActionPermitted('POOL_HALT', 'owner', null)).not.toThrow();
    });

    it('still lets an operator halt the pool', () => {
      expect(() => assertLifecycleActionPermitted('POOL_HALT', 'operator', null)).not.toThrow();
    });

    it('can halt while a plan is awaiting approval', () => {
      expect(() =>
        assertLifecycleActionPermitted('POOL_HALT', 'owner', 'SEALED_AWAITING_APPROVAL'),
      ).not.toThrow();
    });

    it('can still halt after the dispatch marker, to stop future dispatch', () => {
      expect(() => assertLifecycleActionPermitted('POOL_HALT', 'owner', 'EXECUTING')).not.toThrow();
    });

    it('does not let an operator resume, which remains an owner decision', () => {
      expect(mayActorPerform('POOL_RESUME', 'operator')).toBe(false);
      expect(() => assertLifecycleActionPermitted('POOL_RESUME', 'operator', null)).toThrow(
        /AUTHZ_SCOPE_DENIED/,
      );
    });

    it('names the permitted actors when it refuses', () => {
      try {
        assertLifecycleActionPermitted('POOL_RESUME', 'agent', null);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as { detail: Record<string, string> }).detail['allowed']).toBe('owner');
      }
    });
  });

  // --- regression: maintainer review, contradictory sealed-plan effect -------------------
  // The comment said INVALIDATE_UNMARKED was "refused outright once marked" while the
  // helper permitted it. Neither was right: after the marker the action must take effect on
  // future authority without touching the in-flight plan.
  describe('effect on a plan that is already marked', () => {
    const marked: readonly PlanState[] = ['EXECUTING', 'RECONCILING', 'MANUAL_REVIEW'];
    const unmarked: readonly PlanState[] = [
      'SEALED_AWAITING_APPROVAL',
      'APPROVED',
      'DISPATCH_PENDING',
    ];

    it('classifies marked and unmarked plan states', () => {
      for (const state of marked) expect(isMarkedPlanState(state), state).toBe(true);
      for (const state of unmarked) expect(isMarkedPlanState(state), state).toBe(false);
    });

    it('invalidates a sealed but unmarked plan', () => {
      for (const state of unmarked) {
        expect(resolveSealedPlanEffect('POOL_HALT', state), state).toBe('INVALIDATE');
        expect(resolveSealedPlanEffect('CREDENTIAL_REVOKE', state), state).toBe('INVALIDATE');
      }
    });

    it('limits a halt after the marker to future authority only', () => {
      for (const state of marked) {
        expect(resolveSealedPlanEffect('POOL_HALT', state), state).toBe('FUTURE_AUTHORITY_ONLY');
      }
    });

    it('limits a credential revocation after the marker to future authority only', () => {
      expect(resolveSealedPlanEffect('CREDENTIAL_REVOKE', 'EXECUTING')).toBe(
        'FUTURE_AUTHORITY_ONLY',
      );
    });

    it('limits a policy publication after the marker to future authority only', () => {
      expect(resolveSealedPlanEffect('POLICY_VERSION_PUBLISH', 'EXECUTING')).toBe(
        'FUTURE_AUTHORITY_ONLY',
      );
    });

    it('refuses account unlink and epoch rotation while in flight', () => {
      expect(resolveSealedPlanEffect('ACCOUNT_UNLINK', 'EXECUTING')).toBe('REFUSED');
      expect(resolveSealedPlanEffect('POOL_EPOCH_ROTATE', 'RECONCILING')).toBe('REFUSED');
      expect(() => assertLifecycleActionPermitted('ACCOUNT_UNLINK', 'owner', 'EXECUTING')).toThrow(
        /PLAN_IN_FLIGHT_FOR_POOL/,
      );
    });

    it('permits account unlink when no plan is in flight', () => {
      expect(resolveSealedPlanEffect('ACCOUNT_UNLINK', 'APPROVED')).toBe('NONE');
      expect(() => assertLifecycleActionPermitted('ACCOUNT_UNLINK', 'owner', null)).not.toThrow();
    });

    it('never reports an effect that would release or rewrite an in-flight plan', () => {
      for (const action of LIFECYCLE_ACTIONS) {
        for (const state of marked) {
          expect(resolveSealedPlanEffect(action, state), `${action}/${state}`).not.toBe(
            'INVALIDATE',
          );
        }
      }
    });
  });

  describe('owner deferral binds the target, not one revision', () => {
    const scope = {
      strategyTargetKey: 'ws/binance-spot:testnet:81234567/e1/strategy-a/BTCUSDT',
      deferredAt: '2026-09-08T10:00:00.000Z',
      untilAt: null,
      reinstatedAt: null,
    };

    it('stays deferred indefinitely until the owner reinstates', () => {
      expect(isDeferredAt(scope, '2026-09-08T10:00:01.000Z')).toBe(true);
      expect(isDeferredAt(scope, '2027-01-01T00:00:00.000Z')).toBe(true);
    });

    it('ends on reinstatement', () => {
      expect(
        isDeferredAt(
          { ...scope, reinstatedAt: '2026-09-08T11:00:00.000Z' },
          '2026-09-08T12:00:00.000Z',
        ),
      ).toBe(false);
    });

    it('ends when an explicit window passes', () => {
      const windowed = { ...scope, untilAt: '2026-09-08T11:00:00.000Z' };
      expect(isDeferredAt(windowed, '2026-09-08T10:30:00.000Z')).toBe(true);
      expect(isDeferredAt(windowed, '2026-09-08T11:00:01.000Z')).toBe(false);
    });

    it('is not yet in effect before it was applied', () => {
      expect(isDeferredAt(scope, '2026-09-08T09:59:59.000Z')).toBe(false);
    });
  });
});
