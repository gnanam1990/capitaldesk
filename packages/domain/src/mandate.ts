import {
  assertOnlyKnownKeys,
  formatAssetKey,
  isStrictUtcInstant,
  parseAssetKey,
  parseAtoms,
  prospectivePoolConcentration,
  ratioLimit,
  sameAsset,
  symbolCode,
  violate,
  type AssetKey,
  type ProspectiveExposure,
  type RatioLimit,
  type ReasonCode,
  type ValuedClaim,
} from '@capitaldesk/contracts';

const POLICY_KEYS = [
  'policyVersion',
  'selectedSymbol',
  'baseAsset',
  'quoteAsset',
  'maxPoolPlanQuoteDebitAtoms',
  'maxDailyGrossBuyQuoteAtoms',
  'poolConcentrationNumerator',
  'poolConcentrationDenominator',
  'freshnessMaxAgeMs',
  'planLifetimeMs',
  'buyInhibitUntil',
  'riskIncreaseHalted',
  'feePolicyVersion',
  'strategyLimits',
] as const;
const FRESHNESS_KEYS = [
  'PRICE_SNAPSHOT',
  'ACCOUNT_SNAPSHOT',
  'SYMBOL_METADATA',
  'VENUE_CLOCK',
] as const;
const STRATEGY_LIMIT_KEYS = [
  'strategyId',
  'maxTargetBaseAtoms',
  'maxPlanQuoteDebitAtoms',
  'maxDailyGrossBuyQuoteAtoms',
] as const;

export const FRESHNESS_CLASSES = [
  'PRICE_SNAPSHOT',
  'ACCOUNT_SNAPSHOT',
  'SYMBOL_METADATA',
  'VENUE_CLOCK',
] as const;
export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];
export type FreshnessDurations = Readonly<Record<FreshnessClass, bigint>>;

export interface StrategyMandateLimit {
  readonly strategyId: string;
  readonly maxTargetBaseAtoms: bigint;
  readonly maxPlanQuoteDebitAtoms: bigint;
  readonly maxDailyGrossBuyQuoteAtoms: bigint;
}

export interface MandatePolicy {
  readonly policyVersion: bigint;
  readonly selectedSymbol: string;
  readonly baseAsset: AssetKey;
  readonly quoteAsset: AssetKey;
  readonly maxPoolPlanQuoteDebitAtoms: bigint;
  readonly maxDailyGrossBuyQuoteAtoms: bigint;
  readonly poolConcentrationLimit: RatioLimit;
  readonly freshnessMaxAgeMs: FreshnessDurations;
  readonly planLifetimeMs: bigint;
  readonly buyInhibitUntil: string | null;
  readonly riskIncreaseHalted: boolean;
  readonly feePolicyVersion: string;
  readonly strategyLimits: readonly StrategyMandateLimit[];
}

export interface MandatePolicyWire {
  readonly policyVersion: string;
  readonly selectedSymbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly maxPoolPlanQuoteDebitAtoms: string;
  readonly maxDailyGrossBuyQuoteAtoms: string;
  readonly poolConcentrationNumerator: string;
  readonly poolConcentrationDenominator: string;
  readonly freshnessMaxAgeMs: Readonly<Record<FreshnessClass, string>>;
  readonly planLifetimeMs: string;
  readonly buyInhibitUntil: string | null;
  readonly riskIncreaseHalted: boolean;
  readonly feePolicyVersion: string;
  readonly strategyLimits: readonly {
    readonly strategyId: string;
    readonly maxTargetBaseAtoms: string;
    readonly maxPlanQuoteDebitAtoms: string;
    readonly maxDailyGrossBuyQuoteAtoms: string;
  }[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POSITIVE_PATTERN = /^[1-9][0-9]*$/;

function positive(name: string, value: string): bigint {
  if (!POSITIVE_PATTERN.test(value) || value.length > 78) {
    violate('POLICY_CONFIGURATION_MISSING', `${name} must be a canonical positive integer`, {
      [name]: value,
    });
  }
  return BigInt(value);
}

/** Validate and freeze an owner-authored policy. There are no freshness defaults. */
export function mandatePolicy(wire: MandatePolicyWire): MandatePolicy {
  assertOnlyKnownKeys(wire, POLICY_KEYS, '$');
  assertOnlyKnownKeys(wire.freshnessMaxAgeMs, FRESHNESS_KEYS, '$.freshnessMaxAgeMs');
  const selectedSymbol = symbolCode(wire.selectedSymbol);
  const baseAsset = parseAssetKey(wire.baseAsset);
  const quoteAsset = parseAssetKey(wire.quoteAsset);
  if (sameAsset(baseAsset, quoteAsset)) {
    violate('POLICY_CONFIGURATION_MISSING', 'base and quote assets must be distinct');
  }
  if (!ID_PATTERN.test(wire.feePolicyVersion)) {
    violate('POLICY_CONFIGURATION_MISSING', 'fee policy version is malformed');
  }
  if (wire.buyInhibitUntil !== null && !isStrictUtcInstant(wire.buyInhibitUntil)) {
    violate('POLICY_CONFIGURATION_MISSING', 'buy inhibit expiry must be a strict UTC instant');
  }
  const freshness = {} as Record<FreshnessClass, bigint>;
  for (const freshnessClass of FRESHNESS_CLASSES) {
    const value: unknown = wire.freshnessMaxAgeMs?.[freshnessClass];
    if (typeof value !== 'string') {
      violate('POLICY_CONFIGURATION_MISSING', `missing freshness maximum for ${freshnessClass}`);
    }
    freshness[freshnessClass] = positive(`${freshnessClass}MaxAgeMs`, value);
  }
  const seen = new Set<string>();
  const strategyLimits = wire.strategyLimits.map((limit, index) => {
    assertOnlyKnownKeys(limit, STRATEGY_LIMIT_KEYS, `$.strategyLimits[${index.toString()}]`);
    if (!ID_PATTERN.test(limit.strategyId) || seen.has(limit.strategyId)) {
      violate('POLICY_CONFIGURATION_MISSING', 'strategy limits require unique valid strategy ids', {
        strategyId: limit.strategyId,
      });
    }
    seen.add(limit.strategyId);
    return Object.freeze({
      strategyId: limit.strategyId,
      maxTargetBaseAtoms: parseAtoms(limit.maxTargetBaseAtoms),
      maxPlanQuoteDebitAtoms: parseAtoms(limit.maxPlanQuoteDebitAtoms),
      maxDailyGrossBuyQuoteAtoms: parseAtoms(limit.maxDailyGrossBuyQuoteAtoms),
    });
  });
  if (strategyLimits.length === 0) {
    violate('POLICY_CONFIGURATION_MISSING', 'a policy must authorize at least one strategy');
  }
  return Object.freeze({
    policyVersion: positive('policyVersion', wire.policyVersion),
    selectedSymbol,
    baseAsset,
    quoteAsset,
    maxPoolPlanQuoteDebitAtoms: parseAtoms(wire.maxPoolPlanQuoteDebitAtoms),
    maxDailyGrossBuyQuoteAtoms: parseAtoms(wire.maxDailyGrossBuyQuoteAtoms),
    poolConcentrationLimit: ratioLimit(
      parseAtoms(wire.poolConcentrationNumerator),
      positive('poolConcentrationDenominator', wire.poolConcentrationDenominator),
    ),
    freshnessMaxAgeMs: Object.freeze(freshness),
    planLifetimeMs: positive('planLifetimeMs', wire.planLifetimeMs),
    buyInhibitUntil: wire.buyInhibitUntil,
    riskIncreaseHalted: wire.riskIncreaseHalted,
    feePolicyVersion: wire.feePolicyVersion,
    strategyLimits: Object.freeze(strategyLimits),
  });
}

export type MandateAdmission =
  | { readonly allowed: true; readonly explanation: 'candidate is inside every owner mandate' }
  | { readonly allowed: false; readonly reason: ReasonCode; readonly explanation: string };

export interface AdmissionCandidate {
  readonly policyVersion: bigint;
  readonly strategyId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly fundingAsset: AssetKey;
  readonly requiredFundingAtoms: bigint;
  readonly strategyAvailableFundingAtoms: bigint;
  /** Corroborating capacity only. Deliberately never used to replace strategy authority. */
  readonly venueAvailableFundingAtoms: bigint;
  readonly maxQuoteDebitAtoms: bigint;
  readonly committedBuyQuoteAtoms: bigint;
  readonly outstandingBuyQuoteAtoms: bigint;
  readonly currentUtcBucket: string;
  readonly dispatchUtcBucket: string;
  readonly expiresInMs: bigint;
  readonly buyInhibitActive: boolean;
  readonly feePolicyVersion: string;
  readonly freshnessAgeMs: FreshnessDurations;
  readonly valuedClaims: readonly ValuedClaim[];
  readonly prospectiveExposure: ProspectiveExposure;
}

function denied(reason: ReasonCode, explanation: string): MandateAdmission {
  return { allowed: false, reason, explanation };
}

function freshnessFailure(
  policy: MandatePolicy,
  actual: FreshnessDurations,
): MandateAdmission | null {
  for (const freshnessClass of FRESHNESS_CLASSES) {
    const age = actual[freshnessClass];
    const maximum = policy.freshnessMaxAgeMs[freshnessClass];
    if (age < 0n) return denied('EVIDENCE_CONTRADICTORY', `${freshnessClass} age is negative`);
    if (age <= maximum) continue;
    if (freshnessClass === 'PRICE_SNAPSHOT') {
      return denied(
        'POLICY_CONCENTRATION_UNCOMPUTABLE',
        `PRICE_SNAPSHOT age ${age.toString()}ms exceeds ${maximum.toString()}ms`,
      );
    }
    if (freshnessClass === 'VENUE_CLOCK') {
      return denied(
        'CLOCK_SKEW_UNBOUNDED',
        `VENUE_CLOCK age ${age.toString()}ms exceeds ${maximum.toString()}ms`,
      );
    }
    return denied(
      'EVIDENCE_STALE',
      `${freshnessClass} age ${age.toString()}ms exceeds ${maximum.toString()}ms`,
    );
  }
  return null;
}

/** Pure, ordered admission decision. Agent rationale and venue surplus are not inputs to authority. */
export function evaluateMandate(
  policy: MandatePolicy,
  candidate: AdmissionCandidate,
): MandateAdmission {
  if (
    candidate.requiredFundingAtoms < 0n ||
    candidate.strategyAvailableFundingAtoms < 0n ||
    candidate.venueAvailableFundingAtoms < 0n ||
    candidate.maxQuoteDebitAtoms < 0n ||
    candidate.committedBuyQuoteAtoms < 0n ||
    candidate.outstandingBuyQuoteAtoms < 0n
  ) {
    return denied(
      'EVIDENCE_CONTRADICTORY',
      'candidate monetary evidence contains a negative value',
    );
  }
  const stale = freshnessFailure(policy, candidate.freshnessAgeMs);
  if (stale !== null) return stale;
  if (candidate.policyVersion !== policy.policyVersion) {
    return denied(
      'POLICY_MANDATE_VERSION_STALE',
      'candidate does not bind the active mandate version',
    );
  }
  if (candidate.symbol !== policy.selectedSymbol) {
    return denied('IDENTITY_SCOPE_MISMATCH', 'candidate symbol is outside the mandate allowlist');
  }
  if (candidate.feePolicyVersion !== policy.feePolicyVersion) {
    return denied('POLICY_MANDATE_VERSION_STALE', 'candidate fee policy differs from the mandate');
  }
  if (candidate.expiresInMs <= 0n || candidate.expiresInMs > policy.planLifetimeMs) {
    return denied('APPROVAL_EXPIRED', 'candidate expiry is outside the mandate plan lifetime');
  }
  const limit = policy.strategyLimits.find((entry) => entry.strategyId === candidate.strategyId);
  if (limit === undefined) {
    return denied('AUTHZ_SCOPE_DENIED', 'strategy has no limit in this mandate version');
  }
  if (
    candidate.maxQuoteDebitAtoms > limit.maxPlanQuoteDebitAtoms ||
    candidate.maxQuoteDebitAtoms > policy.maxPoolPlanQuoteDebitAtoms
  ) {
    return denied('POLICY_BUDGET_EXCEEDED', 'candidate exceeds a per-plan quote debit limit');
  }
  if (candidate.requiredFundingAtoms > candidate.strategyAvailableFundingAtoms) {
    return denied(
      'PLAN_INSUFFICIENT_CLAIM',
      `strategy owns ${candidate.strategyAvailableFundingAtoms.toString()} ${formatAssetKey(candidate.fundingAsset)} atoms but requires ${candidate.requiredFundingAtoms.toString()}`,
    );
  }
  if (candidate.side === 'SELL' && !sameAsset(candidate.fundingAsset, policy.baseAsset)) {
    return denied('MONEY_ASSET_MISMATCH', 'SELL funding must be the strategy base claim');
  }
  if (candidate.side === 'BUY' && !sameAsset(candidate.fundingAsset, policy.quoteAsset)) {
    return denied('MONEY_ASSET_MISMATCH', 'BUY funding must be the strategy quote claim');
  }
  if (candidate.side === 'BUY') {
    if (policy.riskIncreaseHalted) {
      return denied('POLICY_RISK_INCREASE_HALTED', 'owner mandate inhibits new risk increases');
    }
    if (candidate.buyInhibitActive) {
      return denied('POLICY_RISK_INCREASE_HALTED', 'owner buy inhibit is active for this target');
    }
    if (candidate.currentUtcBucket !== candidate.dispatchUtcBucket) {
      return denied('APPROVAL_EXPIRED', 'pre-dispatch BUY crossed its UTC budget bucket');
    }
    const used =
      candidate.committedBuyQuoteAtoms +
      candidate.outstandingBuyQuoteAtoms +
      candidate.maxQuoteDebitAtoms;
    if (used > limit.maxDailyGrossBuyQuoteAtoms || used > policy.maxDailyGrossBuyQuoteAtoms) {
      return denied('POLICY_BUDGET_EXCEEDED', 'daily gross BUY budget is exhausted');
    }
    const concentration = prospectivePoolConcentration(
      candidate.valuedClaims,
      candidate.prospectiveExposure,
      policy.poolConcentrationLimit,
    );
    if (concentration.kind === 'UNCOMPUTABLE' || concentration.kind === 'EMPTY_POOL') {
      return denied(
        'POLICY_CONCENTRATION_UNCOMPUTABLE',
        'prospective concentration is not provable',
      );
    }
    if (concentration.kind === 'EXCEEDED') {
      return denied(
        'POLICY_CONCENTRATION_EXCEEDED',
        'prospective pool concentration exceeds the owner limit',
      );
    }
  }
  return { allowed: true, explanation: 'candidate is inside every owner mandate' };
}
