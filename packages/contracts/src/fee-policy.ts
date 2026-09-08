import { violate } from './errors.js';
import { isStrictUtcInstant } from './time.js';

/**
 * Fee policies (ADR-0010).
 *
 * A fee policy is enabled only when a conservative cumulative debit bound can be proven for
 * every permitted partial fill under it. An observed rate is not a bound. Unproven policies
 * stay disabled and block dispatch rather than being approximated.
 */

export const FEE_COMMISSION_ROUTES = [
  /** Commission is charged in the asset received: base on BUY, quote on SELL. */
  'RECEIVED_ASSET',
  /**
   * Commission is charged in the quote asset on both sides. Not Binance's standard schedule;
   * it exists because the reviewed golden example uses it, and an allocator reading `route`
   * would otherwise debit base on a BUY where the fixture debits quote.
   */
  'QUOTE_ALWAYS',
  /** Commission is charged in BNB at a discounted rate, with a documented fallback. */
  'BNB_DISCOUNT',
  /** Commission is charged in a third asset chosen by the venue. */
  'THIRD_ASSET',
] as const;
export type FeeCommissionRoute = (typeof FEE_COMMISSION_ROUTES)[number];

/**
 * Whether a conservative pre-trade cumulative bound has been *derived*, not merely described.
 *
 * `PROVEN` requires a derivation that holds a priori: before any fill is observed, for every
 * partition the venue is permitted to produce. Summing per-fill ceilings describes a realized
 * fee after the fact; it is only a bound once the number of fills is itself bounded, which
 * needs an evidenced minimum fill size and a supported partition granularity.
 */
export type FeeBoundStatus =
  /** A pre-trade bound is derived and evidenced. Dispatch may proceed. */
  | 'PROVEN'
  /** No pre-trade bound is derived. Dispatch is refused. */
  | 'UNVERIFIED'
  /**
   * A bound was sought and shown not to exist under this policy — a demonstrated
   * impossibility, not merely an absent derivation. No policy currently carries this: we do
   * not have such a proof for any of them, and claiming one would be as inaccurate as
   * claiming a bound we do not have.
   */
  | 'REFUTED';

export interface FeePolicy {
  readonly version: string;
  readonly route: FeeCommissionRoute;
  /**
   * Status of the pre-trade cumulative bound. This is a declaration of what has been
   * established, never a permission by itself: {@link assertFeePolicyDispatchable} also
   * requires matching evidence supplied at runtime.
   */
  readonly boundStatus: FeeBoundStatus;
  /** Account settings this policy requires; unverified settings make the policy unusable. */
  readonly requiredAccountSettings: readonly string[];
  /** Why this policy is or is not enabled, in owner-readable terms. */
  readonly rationale: string;
}

/**
 * A derived pre-trade bound, produced by the fee/allocation module and carried with the plan.
 *
 * The runtime gate requires one of these. A policy constant alone can never authorize
 * dispatch, so a hardcoded status cannot become an executable path by itself.
 */
export interface FeeBoundEvidence {
  readonly policyVersion: string;
  /** ISO-8601 UTC instant at which the bound was derived. */
  readonly derivedAt: string;
  /** Maximum number of fills the venue may produce for one child under this policy. */
  readonly maxFillCount: number;
  /** Evidenced minimum fill size, in base atoms, that makes maxFillCount finite. */
  readonly minFillBaseAtoms: bigint;
  /** Digest of the derivation and the source observations it rests on. */
  readonly derivationDigest: string;
}

/**
 * The initially supported policy. Binance standard commission is charged in the received
 * asset, so a BUY's commission is base-denominated and a SELL's is quote-denominated. BNB
 * fee payment must be verified disabled, because the documented BNB-insufficiency fallback
 * changes the debited asset mid-order and no bound is proven for that.
 */
export const STANDARD_NO_BNB_V1: FeePolicy = Object.freeze({
  version: 'STANDARD_NO_BNB_V1',
  route: 'RECEIVED_ASSET',
  // UNVERIFIED, deliberately. An earlier draft declared this proven on the grounds that the
  // cumulative bound is the sum of per-fill ceilings. That describes the realized fee once
  // the fills are known; it is not an a-priori bound, because the number of fills is not
  // bounded without an evidenced minimum fill size and a supported partition granularity.
  // Deriving that is module 14's work, and until it lands with evidence, dispatch under this
  // policy is refused rather than attempted against an assumed schedule.
  boundStatus: 'UNVERIFIED',
  requiredAccountSettings: ['bnbBurnSpot=false', 'commissionRates.verified=true'],
  rationale:
    'Commission is taken in the received asset at the verified per-symbol rate, so the ' +
    'per-fill ceiling is ceil(rate * fillQuantity) in that asset. A conservative pre-trade ' +
    'cumulative bound additionally requires a bound on the number of fills the venue may ' +
    'produce, which needs an evidenced minimum fill size and supported partition ' +
    'granularity. That derivation is not complete, so this policy cannot yet authorize a ' +
    'dispatch. BNB payment must also be verified disabled: its documented insufficiency ' +
    'fallback changes the debited asset mid-order.',
});

/**
 * Deterministic fixture policy used by the golden partial-fill example in TDD section 6 and
 * TEST-PLAN section 4. It charges quote commission on a BUY, which the standard Binance
 * schedule does not; it exists to keep the reviewed golden numbers reproducible and is
 * never selectable for a real dispatch.
 */
export const QUOTE_FEE_FIXTURE_V1: FeePolicy = Object.freeze({
  version: 'QUOTE_FEE_FIXTURE_V1',
  // QUOTE_ALWAYS, not RECEIVED_ASSET: this fixture charges quote commission on a BUY, and
  // labelling it RECEIVED_ASSET would have told an allocator to debit base instead.
  route: 'QUOTE_ALWAYS',
  // Proven only because the fixture fixes the fill partition: the deterministic scenario
  // states exactly which fills occur, so the number of fills is known rather than bounded.
  // That is why this policy is refused outside the local environment.
  boundStatus: 'PROVEN',
  requiredAccountSettings: ['environment=local'],
  rationale:
    'Deterministic test fixture reproducing the reviewed golden example (0.1% quote fee on a ' +
    'BUY). Fixture policy only; refused outside the local environment.',
});

/**
 * BNB discount routing: defined so it can be named and refused, and disabled.
 *
 * UNVERIFIED, not REFUTED. We have no derivation of a bound for it, and its documented
 * insufficiency fallback makes one materially harder — the debited asset can change
 * mid-order. That is an absent proof, not a proof of absence, and the status says exactly
 * that. Either way it refuses dispatch.
 */
export const BNB_DISCOUNT_UNPROVEN: FeePolicy = Object.freeze({
  version: 'BNB_DISCOUNT_UNPROVEN',
  route: 'BNB_DISCOUNT',
  boundStatus: 'UNVERIFIED',
  requiredAccountSettings: ['bnbBurnSpot=true', 'bnbSufficiencyBound.verified=true'],
  rationale:
    'Binance documents BNB commission falling back to the received asset when the BNB ' +
    'balance is insufficient, so the debited asset can change mid-order. No pre-trade ' +
    'cumulative bound has been derived for that behaviour. This is an absent derivation ' +
    'rather than a demonstrated impossibility: a bound may well exist once the fallback ' +
    'condition is bounded. Until one is derived and evidenced, dispatch is refused.',
});

const REGISTRY: ReadonlyMap<string, FeePolicy> = new Map(
  [STANDARD_NO_BNB_V1, QUOTE_FEE_FIXTURE_V1, BNB_DISCOUNT_UNPROVEN].map((p) => [p.version, p]),
);

export function feePolicy(version: string): FeePolicy {
  const found = REGISTRY.get(version);
  if (!found) {
    violate('FEE_ASSET_UNSUPPORTED', 'unknown fee policy version', { version });
  }
  return found;
}

/**
 * Gate used before sealing and again before marking (IMPLEMENTATION-PLAN section 7).
 *
 * Requires both a `PROVEN` status **and** matching evidence supplied at call time. A policy
 * constant can therefore never authorize dispatch on its own: flipping a status to `PROVEN`
 * without producing a derivation still refuses.
 */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function assertFeePolicyDispatchable(
  policy: FeePolicy,
  environment: 'local' | 'testnet' | 'production',
  evidence: FeeBoundEvidence | null,
  /**
   * Account settings observed and verified against the live account, as `name=value` strings.
   * Every entry in the policy's `requiredAccountSettings` must appear here. Passing the
   * policy's own list back would prove nothing, so the caller must supply what it observed.
   */
  verifiedAccountSettings: readonly string[] = [],
): void {
  if (policy.boundStatus !== 'PROVEN') {
    violate('FEE_BOUND_UNPROVEN', 'fee policy has no derived pre-trade cumulative debit bound', {
      version: policy.version,
      boundStatus: policy.boundStatus,
    });
  }
  if (evidence === null) {
    violate('FEE_BOUND_UNPROVEN', 'no fee bound derivation was supplied for this dispatch', {
      version: policy.version,
    });
  }
  if (evidence.policyVersion !== policy.version) {
    violate('FEE_BOUND_UNPROVEN', 'the supplied fee bound was derived for a different policy', {
      policy: policy.version,
      evidence: evidence.policyVersion,
    });
  }
  if (!Number.isSafeInteger(evidence.maxFillCount) || evidence.maxFillCount < 1) {
    violate(
      'FEE_BOUND_UNPROVEN',
      'a cumulative bound requires a finite maximum fill count of at least one',
      { maxFillCount: String(evidence.maxFillCount) },
    );
  }
  if (evidence.minFillBaseAtoms <= 0n) {
    violate(
      'FEE_BOUND_UNPROVEN',
      'a finite fill count requires an evidenced positive minimum fill size',
      { minFillBaseAtoms: evidence.minFillBaseAtoms.toString() },
    );
  }
  // A derivation record that cannot say when it was derived, or point at the evidence it
  // rests on, is not a derivation. Both fields went unchecked, so a malformed record passed.
  if (!isStrictUtcInstant(evidence.derivedAt)) {
    violate('FEE_BOUND_UNPROVEN', 'derivedAt must be a real ISO-8601 UTC instant ending in Z', {
      derivedAt: evidence.derivedAt,
    });
  }
  // Structural only, and deliberately labelled as such. A well-formed digest proves the
  // record has the right shape; it does not prove the derivation it names exists or says
  // what it claims. Verifying a canonical derivation payload needs the producer, which is
  // module 14's work. Until then this gate validates structure, and the honest consequence
  // is that no policy outside the local fixture is PROVEN anyway.
  if (!DIGEST_PATTERN.test(evidence.derivationDigest)) {
    violate('FEE_BOUND_UNPROVEN', 'the derivation must reference its evidence by sha256 digest', {
      derivationDigest: evidence.derivationDigest,
    });
  }

  // Metadata is not enforcement. The policy lists the account settings it depends on; those
  // must be verified against the account, or a PROVEN policy authorizes without them.
  const verified = new Set(verifiedAccountSettings);
  const missing = policy.requiredAccountSettings.filter((setting) => !verified.has(setting));
  if (missing.length > 0) {
    violate('CAPABILITY_UNVERIFIED', 'required account settings were not verified', {
      version: policy.version,
      missing: missing.join(','),
    });
  }
  if (policy.version === 'QUOTE_FEE_FIXTURE_V1' && environment !== 'local') {
    violate(
      'FEE_ASSET_UNSUPPORTED',
      'fixture fee policy is refused outside the local environment',
      { version: policy.version, environment },
    );
  }
}
