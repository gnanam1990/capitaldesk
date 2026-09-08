import {
  assetKey,
  amount,
  formatPrice,
  parseAtoms,
  priceFromDecimal,
  sameAsset,
  symbolCode,
  violate,
  type AssetAmount,
  type AssetKey,
} from '@capitaldesk/contracts';

/** Wire form accepted from an untrusted proposal agent. Every economic scalar is text. */
export interface StrategyTargetProposal {
  readonly intentId: string;
  readonly symbol: string;
  readonly targetBaseQtyAtoms: string;
  readonly maxBuyPrice: string | null;
  readonly minSellPrice: string | null;
  readonly maxQuoteDebitAtoms: string;
  readonly expiresAt: string;
  readonly strategyRevision: string;
  readonly policyVersion: string;
}

export interface StrategyTargetMarket {
  readonly symbol: string;
  readonly baseAsset: AssetKey;
  readonly quoteAsset: AssetKey;
  readonly maxTargetBaseAtoms: bigint;
  readonly activePolicyVersion: bigint;
}

export interface ValidatedStrategyTarget {
  readonly intentId: string;
  readonly symbol: string;
  readonly targetBase: AssetAmount;
  readonly maxBuyPrice: string | null;
  readonly minSellPrice: string | null;
  readonly maxQuoteDebit: AssetAmount;
  readonly expiresAt: Date;
  readonly strategyRevision: bigint;
  readonly policyVersion: bigint;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

function positiveInteger(name: string, value: string): bigint {
  if (!POSITIVE_INTEGER_PATTERN.test(value) || value.length > 78) {
    violate('IDENTITY_MALFORMED', `${name} must be a canonical positive integer string`, {
      [name]: value,
    });
  }
  return BigInt(value);
}

/**
 * Validate a target against the pool configuration that owns it.
 *
 * The function is pure and exact. It canonicalises prices through the fixed-point contract,
 * rejects stale policy revisions, and never infers a symbol or asset from an agent payload.
 */
export function validateStrategyTarget(
  proposal: StrategyTargetProposal,
  market: StrategyTargetMarket,
  now: Date,
): ValidatedStrategyTarget {
  if (!ID_PATTERN.test(proposal.intentId)) {
    violate('IDENTITY_MALFORMED', 'intentId must be 1-64 chars of [A-Za-z0-9._-]', {
      intentId: proposal.intentId,
    });
  }
  const symbol = symbolCode(proposal.symbol);
  if (symbol !== market.symbol) {
    violate('IDENTITY_SCOPE_MISMATCH', 'intent symbol is not the pool selected symbol', {
      symbol,
      selectedSymbol: market.symbol,
    });
  }

  const targetBase = amount(market.baseAsset, parseAtoms(proposal.targetBaseQtyAtoms));
  if (targetBase.atoms > market.maxTargetBaseAtoms) {
    violate('POLICY_BUDGET_EXCEEDED', 'target exceeds the pool maximum base quantity', {
      targetBaseQtyAtoms: targetBase.atoms.toString(),
      maxTargetBaseAtoms: market.maxTargetBaseAtoms.toString(),
    });
  }
  const maxQuoteDebit = amount(market.quoteAsset, parseAtoms(proposal.maxQuoteDebitAtoms));
  const maxBuyPrice =
    proposal.maxBuyPrice === null
      ? null
      : formatPrice(priceFromDecimal(market.baseAsset, market.quoteAsset, proposal.maxBuyPrice));
  const minSellPrice =
    proposal.minSellPrice === null
      ? null
      : formatPrice(priceFromDecimal(market.baseAsset, market.quoteAsset, proposal.minSellPrice));
  if (maxBuyPrice === null && minSellPrice === null) {
    violate('PLAN_LIMIT_INCOMPATIBLE', 'a target must state a BUY ceiling or SELL floor');
  }
  if (maxBuyPrice === '0' || minSellPrice === '0') {
    violate('PLAN_LIMIT_INCOMPATIBLE', 'price bounds must be greater than zero');
  }

  const expiresAt = new Date(proposal.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    violate('INTENT_EXPIRED', 'intent expiry must be a valid future instant', {
      expiresAt: proposal.expiresAt,
    });
  }
  const strategyRevision = positiveInteger('strategyRevision', proposal.strategyRevision);
  const policyVersion = positiveInteger('policyVersion', proposal.policyVersion);
  if (policyVersion !== market.activePolicyVersion) {
    violate('POLICY_MANDATE_VERSION_STALE', 'intent does not bind the active policy version', {
      supplied: policyVersion.toString(),
      active: market.activePolicyVersion.toString(),
    });
  }

  return Object.freeze({
    intentId: proposal.intentId,
    symbol,
    targetBase,
    maxBuyPrice,
    minSellPrice,
    maxQuoteDebit,
    expiresAt,
    strategyRevision,
    policyVersion,
  });
}

export type TargetDirection = 'BUY' | 'SELL' | 'SATISFIED';

export interface TargetProgress {
  readonly target: AssetAmount;
  /** Confirmed eligible ownership only. */
  readonly owned: AssetAmount;
  /** Expected ownership after already committed, unresolved child allocations settle. */
  readonly projectedOwned: AssetAmount;
  readonly direction: TargetDirection;
  readonly remainingAtoms: bigint;
  /** A planner may create work only when no existing commitment already pursues this target. */
  readonly replannable: boolean;
}

/**
 * Evaluate an absolute target. This returns remaining demand; it never creates or repeats it.
 * Incoming/outgoing commitments are explicit so replaying the same target cannot count them
 * twice, and a partial IOC leaves the exact residual visible after its commitment closes.
 */
export function targetProgress(input: {
  readonly target: AssetAmount;
  readonly owned: AssetAmount;
  readonly incomingCommittedAtoms: bigint;
  readonly outgoingCommittedAtoms: bigint;
}): TargetProgress {
  if (!sameAsset(input.target.asset, input.owned.asset)) {
    violate('MONEY_ASSET_MISMATCH', 'target and owned quantity must name the same asset');
  }
  if (input.incomingCommittedAtoms < 0n || input.outgoingCommittedAtoms < 0n) {
    violate('MONEY_NEGATIVE_RESULT', 'commitment quantities must be nonnegative');
  }
  const projected = input.owned.atoms + input.incomingCommittedAtoms - input.outgoingCommittedAtoms;
  if (projected < 0n) {
    violate('PLAN_INSUFFICIENT_CLAIM', 'outgoing commitments exceed owned base quantity');
  }
  const projectedOwned = amount(input.owned.asset, projected);
  const hasCommitment = input.incomingCommittedAtoms !== 0n || input.outgoingCommittedAtoms !== 0n;
  if (projected === input.target.atoms) {
    return Object.freeze({
      target: input.target,
      owned: input.owned,
      projectedOwned,
      direction: 'SATISFIED',
      remainingAtoms: 0n,
      replannable: false,
    });
  }
  return Object.freeze({
    target: input.target,
    owned: input.owned,
    projectedOwned,
    direction: projected < input.target.atoms ? 'BUY' : 'SELL',
    remainingAtoms:
      projected < input.target.atoms
        ? input.target.atoms - projected
        : projected - input.target.atoms,
    replannable: !hasCommitment,
  });
}

/** Convenience for repositories restoring asset keys from configured columns. */
export function configuredAsset(code: string, scaleVersion: string): AssetKey {
  return assetKey(code, scaleVersion);
}
