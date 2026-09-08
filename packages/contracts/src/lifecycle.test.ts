import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_ACTIONS,
  LIFECYCLE_CONTRACTS,
  assertLifecycleActionPermitted,
  isDeferredAt,
  mayActorPerform,
  assertPhaseConsistent,
  resolveSealedPlanEffect,
  type PlanDispatchContext,
  type PlanDispatchPhase,
} from './lifecycle.js';
import type { PlanState } from './states.js';

/** A plan at a given state and operational phase. */
const at = (state: PlanState, dispatchPhase: PlanDispatchPhase): PlanDispatchContext => ({
  state,
  dispatchPhase,
});

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
        assertLifecycleActionPermitted(
          'POOL_HALT',
          'owner',
          at('SEALED_AWAITING_APPROVAL', 'SEALED_UNMARKED'),
        ),
      ).not.toThrow();
    });

    it('can still halt after the dispatch marker, to stop future dispatch', () => {
      expect(() =>
        assertLifecycleActionPermitted('POOL_HALT', 'owner', at('EXECUTING', 'MARKED')),
      ).not.toThrow();
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
  describe('effect on a plan, resolved from marker evidence', () => {
    const sealedUnmarked: readonly PlanState[] = [
      'SEALED_AWAITING_APPROVAL',
      'APPROVED',
      'DISPATCH_PENDING',
    ];
    const markedStates = ['EXECUTING', 'RECONCILING', 'MANUAL_REVIEW'] as const;

    it('invalidates a sealed but unmarked plan', () => {
      for (const state of sealedUnmarked) {
        expect(resolveSealedPlanEffect('POOL_HALT', at(state, 'SEALED_UNMARKED')), state).toBe(
          'INVALIDATE',
        );
        expect(
          resolveSealedPlanEffect('CREDENTIAL_REVOKE', at(state, 'SEALED_UNMARKED')),
          state,
        ).toBe('INVALIDATE');
      }
    });

    it('limits a halt after the marker to future authority only', () => {
      for (const state of markedStates) {
        expect(resolveSealedPlanEffect('POOL_HALT', at(state, 'MARKED')), state).toBe(
          'FUTURE_AUTHORITY_ONLY',
        );
      }
    });

    it('limits a credential revocation and policy publication after the marker', () => {
      expect(resolveSealedPlanEffect('CREDENTIAL_REVOKE', at('EXECUTING', 'MARKED'))).toBe(
        'FUTURE_AUTHORITY_ONLY',
      );
      expect(resolveSealedPlanEffect('POLICY_VERSION_PUBLISH', at('EXECUTING', 'MARKED'))).toBe(
        'FUTURE_AUTHORITY_ONLY',
      );
    });

    it('refuses account unlink and epoch rotation while in flight', () => {
      expect(resolveSealedPlanEffect('ACCOUNT_UNLINK', at('EXECUTING', 'MARKED'))).toBe('REFUSED');
      expect(resolveSealedPlanEffect('POOL_EPOCH_ROTATE', at('RECONCILING', 'MARKED'))).toBe(
        'REFUSED',
      );
      expect(() =>
        assertLifecycleActionPermitted('ACCOUNT_UNLINK', 'owner', at('EXECUTING', 'MARKED')),
      ).toThrow(/PLAN_IN_FLIGHT_FOR_POOL/);
    });

    it('permits account unlink when no plan is in flight', () => {
      expect(resolveSealedPlanEffect('ACCOUNT_UNLINK', at('APPROVED', 'SEALED_UNMARKED'))).toBe(
        'NONE',
      );
      expect(() => assertLifecycleActionPermitted('ACCOUNT_UNLINK', 'owner', null)).not.toThrow();
    });

    it('never reports an effect that would release or rewrite a marked plan', () => {
      for (const action of LIFECYCLE_ACTIONS) {
        for (const state of markedStates) {
          expect(
            resolveSealedPlanEffect(action, at(state, 'MARKED')),
            `${action}/${state}`,
          ).not.toBe('INVALIDATE');
        }
      }
    });

    // --- regression: PR 1 review, MANUAL_REVIEW resolved from the state alone -----------
    // MANUAL_REVIEW is reachable before sealing and after a sealed plan fails, and the two
    // want opposite answers. Inferring "in flight" left an unmarked sealed plan live when the
    // owner halted it; inferring "no sealed plan" left it live for the other reason. Both
    // facts are now supplied, and these assert the exact outcome rather than merely ruling
    // one out — the weaker assertion is what let the first fix pass while still wrong.
    describe('MANUAL_REVIEW is resolved from evidence, not from the state', () => {
      it('invalidates a sealed, unmarked MANUAL_REVIEW plan', () => {
        expect(resolveSealedPlanEffect('POOL_HALT', at('MANUAL_REVIEW', 'SEALED_UNMARKED'))).toBe(
          'INVALIDATE',
        );
        expect(
          resolveSealedPlanEffect('CREDENTIAL_REVOKE', at('MANUAL_REVIEW', 'SEALED_UNMARKED')),
        ).toBe('INVALIDATE');
      });

      it('reports no effect when MANUAL_REVIEW was reached without a sealed plan', () => {
        expect(
          resolveSealedPlanEffect('POOL_HALT', at('MANUAL_REVIEW', 'NO_ACTIVE_SEALED_PLAN')),
        ).toBe('NONE');
      });

      it('limits a marked MANUAL_REVIEW plan to future authority only', () => {
        expect(resolveSealedPlanEffect('POOL_HALT', at('MANUAL_REVIEW', 'MARKED'))).toBe(
          'FUTURE_AUTHORITY_ONLY',
        );
      });

      it('refuses account unlink only once the marker exists', () => {
        expect(
          resolveSealedPlanEffect('ACCOUNT_UNLINK', at('MANUAL_REVIEW', 'SEALED_UNMARKED')),
        ).toBe('NONE');
        expect(resolveSealedPlanEffect('ACCOUNT_UNLINK', at('MANUAL_REVIEW', 'MARKED'))).toBe(
          'REFUSED',
        );
      });

      it('covers all three phases with exact outcomes', () => {
        expect(resolveSealedPlanEffect('POOL_HALT', at('MANUAL_REVIEW', 'SEALED_UNMARKED'))).toBe(
          'INVALIDATE',
        );
        expect(resolveSealedPlanEffect('POOL_HALT', at('MANUAL_REVIEW', 'MARKED'))).toBe(
          'FUTURE_AUTHORITY_ONLY',
        );
        expect(
          resolveSealedPlanEffect('POOL_HALT', at('MANUAL_REVIEW', 'NO_ACTIVE_SEALED_PLAN')),
        ).toBe('NONE');
      });
    });

    // --- regression: PR 1 review, terminal states claimed an invalidation --------------
    // Only a plan that is still sealed and unmarked has something to invalidate.
    it('reports no effect on a pre-seal plan', () => {
      expect(resolveSealedPlanEffect('POOL_HALT', at('PREVIEW', 'NO_ACTIVE_SEALED_PLAN'))).toBe(
        'NONE',
      );
    });

    it('reports no effect on a terminal plan whose sealed version is closed', () => {
      for (const state of [
        'COMPLETED',
        'PARTIAL',
        'UNFILLED',
        'DECLINED',
        'EXPIRED',
        'INVALIDATED',
      ] as const) {
        expect(
          resolveSealedPlanEffect('POOL_HALT', at(state, 'NO_ACTIVE_SEALED_PLAN')),
          state,
        ).toBe('NONE');
      }
    });

    // --- regression: PR 1 review, an "exists" flag stayed true forever -----------------
    // Sealed records are retained in an append-only system, so existence stopped meaning
    // "still open". The phase is validated against the state, so combinations a state cannot
    // be in are refused rather than answered.
    describe('phase and state must be consistent', () => {
      it('refuses a terminal plan claiming an open sealed plan', () => {
        for (const phase of ['SEALED_UNMARKED', 'MARKED'] as const) {
          expect(() => assertPhaseConsistent(at('COMPLETED', phase)), phase).toThrow(
            /cannot be in phase/,
          );
        }
      });

      it('refuses a pre-seal plan claiming a marker', () => {
        expect(() => assertPhaseConsistent(at('PREVIEW', 'MARKED'))).toThrow(/cannot be in phase/);
      });

      it('refuses an executing plan claiming no active sealed plan', () => {
        expect(() => assertPhaseConsistent(at('EXECUTING', 'NO_ACTIVE_SEALED_PLAN'))).toThrow(
          /cannot be in phase/,
        );
      });

      it('refuses an approved plan claiming a marker', () => {
        expect(() => assertPhaseConsistent(at('APPROVED', 'MARKED'))).toThrow(/cannot be in phase/);
      });

      it('accepts MANUAL_REVIEW in any phase, which is why the phase is supplied', () => {
        for (const phase of ['NO_ACTIVE_SEALED_PLAN', 'SEALED_UNMARKED', 'MARKED'] as const) {
          expect(() => assertPhaseConsistent(at('MANUAL_REVIEW', phase)), phase).not.toThrow();
        }
      });

      it('validates before deciding, even for an action with no sealed-plan effect', () => {
        // CREDENTIAL_ISSUE declares NONE, so an early return would have skipped the check.
        expect(() =>
          resolveSealedPlanEffect('CREDENTIAL_ISSUE', at('COMPLETED', 'MARKED')),
        ).toThrow(/cannot be in phase/);
      });
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
