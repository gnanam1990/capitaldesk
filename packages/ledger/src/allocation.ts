import type { AssetKey, CredentialClass } from '@capitaldesk/contracts';

/**
 * Owner internal allocation (TDD section 6; prompt 06 task 3).
 *
 * An allocation moves an AVAILABLE claim between HOUSE and one strategy. It does not move
 * funds at the venue, and every rule here exists so that it cannot be mistaken for one, or
 * used to give a strategy something HOUSE does not have.
 *
 * The rules are ordered, and the first failing one is the answer. An operator retrying a
 * request sees progress rather than a different complaint each time.
 */

export type AllocationActorRole = 'owner' | 'operator' | 'agent' | 'viewer';

export interface AllocationActor {
  readonly role: AllocationActorRole;
  /**
   * The credential the role arrived on.
   *
   * Checked as well as the role, because a role is a claim and the credential class is what
   * carries it. An agent credential presenting `owner` is exactly the escalation ADR-0007
   * separates the classes to prevent.
   */
  readonly credentialClass: CredentialClass;
}

/** `HOUSE`, or a strategy id. `ASSET_CONTROL` is not an owner and is refused. */
export type AllocationParty = string;

export interface AllocationRequest {
  readonly actor: AllocationActor;
  readonly from: AllocationParty;
  readonly to: AllocationParty;
  readonly asset: AssetKey;
  readonly atoms: bigint;
  /** HOUSE's AVAILABLE claim in this asset, for an outbound allocation. */
  readonly houseAvailableAtoms: bigint;
  /** The strategy's AVAILABLE claim, required for a return leg. */
  readonly strategyAvailableAtoms?: bigint;
  readonly strategyIsActive: boolean;
}

export type AllocationAuthorization =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'ACTOR_MAY_NOT_ALLOCATE'
        | 'NOT_A_HOUSE_LEG'
        | 'NONPOSITIVE_AMOUNT'
        | 'STRATEGY_NOT_ACTIVE'
        | 'AVAILABILITY_UNKNOWN';
    }
  | {
      readonly ok: false;
      readonly reason: 'EXCEEDS_AVAILABLE';
      readonly availableAtoms: bigint;
    };

const HOUSE = 'HOUSE';
const ASSET_CONTROL = 'ASSET_CONTROL';

export function authorizeAllocation(request: AllocationRequest): AllocationAuthorization {
  // Only the owner. An agent proposes; giving it budget authority would let a proposal fund
  // itself, and an operator's authority stops short of moving the owner's capital.
  if (request.actor.role !== 'owner' || request.actor.credentialClass !== 'OWNER_SESSION') {
    return { ok: false, reason: 'ACTOR_MAY_NOT_ALLOCATE' };
  }

  // Exactly one leg is HOUSE, and neither is ASSET_CONTROL. A strategy-to-strategy move would
  // look like a sale that never happened (T-020), and crediting control without a matching
  // claim is how units stop having an owner.
  const parties = [request.from, request.to];
  const houseLegs = parties.filter((party) => party === HOUSE).length;
  if (houseLegs !== 1 || parties.includes(ASSET_CONTROL)) {
    return { ok: false, reason: 'NOT_A_HOUSE_LEG' };
  }

  if (request.atoms <= 0n) return { ok: false, reason: 'NONPOSITIVE_AMOUNT' };
  if (!request.strategyIsActive) return { ok: false, reason: 'STRATEGY_NOT_ACTIVE' };

  // The side being debited is the one whose availability bounds the move. Measuring a return
  // leg against HOUSE would let a strategy give back more than it holds.
  const outbound = request.from === HOUSE;
  const available = outbound ? request.houseAvailableAtoms : request.strategyAvailableAtoms;
  if (available === undefined) {
    // Absent is not zero, and certainly not unlimited: the caller has not established it.
    return { ok: false, reason: 'AVAILABILITY_UNKNOWN' };
  }
  if (request.atoms > available) {
    return { ok: false, reason: 'EXCEEDS_AVAILABLE', availableAtoms: available };
  }
  return { ok: true };
}
