import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { authorizeAllocation, type AllocationActor } from './allocation.js';
import { verifyConservation, type AssetPosition, type OwnerClaim } from './conservation.js';

/**
 * Property evidence for the claim model (T-023).
 *
 * Deterministic reference-model properties over pure functions. Not integration evidence and
 * not venue evidence: these say that the rules are self-consistent over generated states, and
 * the real-PostgreSQL suite says the service obeys them.
 *
 * Seeds are recorded by fast-check on failure; any counterexample is minimised and kept as a
 * regression fixture (TEST-PLAN section 2).
 */
const SEED = 20260908;
fc.configureGlobal({ seed: SEED, numRuns: 500 });

const OWNER: AllocationActor = { kind: 'owner-session', role: 'owner', subjectId: 'user-1' };
const ASSET = { code: 'USDT', scaleVersion: 'v1' } as const;

/** A non-negative claim, which is the only kind the ledger may produce. */
const claim = (owner: string): fc.Arbitrary<OwnerClaim> =>
  fc.record({
    owner: fc.constant(owner),
    availableAtoms: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    reservedAtoms: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    quarantinedAtoms: fc.bigInt({ min: 0n, max: 10n ** 12n }),
  });

const owners = ['HOUSE', 'strategy-a', 'strategy-b'];

describe('per-asset conservation, over generated states', () => {
  it('holds exactly when control equals the summed claims', () => {
    fc.assert(
      fc.property(fc.array(claim('HOUSE'), { maxLength: 3 }), (claims) => {
        const total = claims.reduce(
          (sum, c) => sum + c.availableAtoms + c.reservedAtoms + c.quarantinedAtoms,
          0n,
        );
        const position: AssetPosition = { asset: ASSET, controlAtoms: total, claims };
        expect(verifyConservation([position]).conserved).toBe(true);
      }),
    );
  });

  it('reports the exact difference whenever control is off by any amount', () => {
    fc.assert(
      fc.property(
        fc.array(claim('HOUSE'), { maxLength: 3 }),
        fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }).filter((d) => d !== 0n),
        (claims, drift) => {
          const total = claims.reduce(
            (sum, c) => sum + c.availableAtoms + c.reservedAtoms + c.quarantinedAtoms,
            0n,
          );
          const result = verifyConservation([
            { asset: ASSET, controlAtoms: total + drift, claims },
          ]);
          expect(result.conserved).toBe(false);
          // The difference is reported, never absorbed: there is no adjustment term.
          expect(result.discrepancies[0]?.differenceAtoms).toBe(drift);
        },
      ),
    );
  });

  it('never balances a shortfall in one asset against a surplus in another', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 9n }), (drift) => {
        const result = verifyConservation([
          {
            asset: { code: 'USDT', scaleVersion: 'v1' },
            controlAtoms: drift,
            claims: [],
          },
          {
            asset: { code: 'BTC', scaleVersion: 'v1' },
            controlAtoms: 0n,
            claims: [
              { owner: 'HOUSE', availableAtoms: drift, reservedAtoms: 0n, quarantinedAtoms: 0n },
            ],
          },
        ]);
        // A perfectly offsetting pair across two assets is still two discrepancies.
        expect(result.discrepancies).toHaveLength(2);
      }),
    );
  });
});

/**
 * A sequence of authorized allocations conserves the total and never produces a negative
 * claim. This is the invariant the golden 1000 → 500/500 case is one instance of.
 */
describe('allocation sequences, over generated moves', () => {
  const move = fc.record({
    strategy: fc.constantFrom('strategy-a', 'strategy-b'),
    outbound: fc.boolean(),
    atoms: fc.bigInt({ min: 1n, max: 2_000n }),
  });

  it('conserves the total and keeps every claim non-negative', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        fc.array(move, { maxLength: 40 }),
        (opening, moves) => {
          const balances = new Map<string, bigint>(owners.map((owner) => [owner, 0n]));
          balances.set('HOUSE', opening);

          for (const step of moves) {
            const from = step.outbound ? 'HOUSE' : step.strategy;
            const to = step.outbound ? step.strategy : 'HOUSE';
            const authorization = authorizeAllocation({
              actor: OWNER,
              from,
              to,
              asset: ASSET,
              atoms: step.atoms,
              houseAvailableAtoms: balances.get('HOUSE') ?? 0n,
              strategyAvailableAtoms: balances.get(step.strategy) ?? 0n,
              strategyIsActive: true,
            });
            // Only an authorized move is applied, which is exactly what the service does.
            if (!authorization.ok) continue;
            balances.set(from, (balances.get(from) ?? 0n) - step.atoms);
            balances.set(to, (balances.get(to) ?? 0n) + step.atoms);
          }

          const claims = owners.map((owner) => ({
            owner,
            availableAtoms: balances.get(owner) ?? 0n,
            reservedAtoms: 0n,
            quarantinedAtoms: 0n,
          }));
          const result = verifyConservation([{ asset: ASSET, controlAtoms: opening, claims }]);
          expect(result.conserved).toBe(true);
          expect(result.negativeClaims).toEqual([]);
        },
      ),
    );
  });

  it('never authorizes a move that would overdraw the debited side', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        (available, atoms) => {
          const authorization = authorizeAllocation({
            actor: OWNER,
            from: 'HOUSE',
            to: 'strategy-a',
            asset: ASSET,
            atoms,
            houseAvailableAtoms: available,
            strategyIsActive: true,
          });
          expect(authorization.ok).toBe(atoms <= available);
        },
      ),
    );
  });

  it('never authorizes an agent, whatever the amounts', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 6n }), (atoms) => {
        const authorization = authorizeAllocation({
          actor: { kind: 'agent-credential', role: 'agent', subjectId: 'cred-1' },
          from: 'HOUSE',
          to: 'strategy-a',
          asset: ASSET,
          atoms,
          houseAvailableAtoms: 10n ** 12n,
          strategyIsActive: true,
        });
        expect(authorization).toEqual({ ok: false, reason: 'ACTOR_MAY_NOT_ALLOCATE' });
      }),
    );
  });
});
