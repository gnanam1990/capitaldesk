import { violate } from './errors.js';

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
  /** Commission is charged in BNB at a discounted rate, with a documented fallback. */
  'BNB_DISCOUNT',
  /** Commission is charged in a third asset chosen by the venue. */
  'THIRD_ASSET',
] as const;
export type FeeCommissionRoute = (typeof FEE_COMMISSION_ROUTES)[number];

export interface FeePolicy {
  readonly version: string;
  readonly route: FeeCommissionRoute;
  /**
   * Whether a conservative cumulative debit/commission bound has been established for all
   * permitted partial fills. `false` means dispatch is refused under this policy.
   */
  readonly cumulativeBoundProven: boolean;
  /** Account settings this policy requires; unverified settings make the policy unusable. */
  readonly requiredAccountSettings: readonly string[];
  /** Why this policy is or is not enabled, in owner-readable terms. */
  readonly rationale: string;
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
  cumulativeBoundProven: true,
  requiredAccountSettings: ['bnbBurnSpot=false', 'commissionRates.verified=true'],
  rationale:
    'Commission is taken in the received asset at the verified per-symbol rate. The per-fill ' +
    'ceiling is ceil(rate * fillQuantity) in that asset, and the cumulative bound is the sum ' +
    'of per-fill ceilings over the maximum permitted number of partial fills, which is ' +
    'bounded because IOC executions cannot exceed the requested quantity. BNB payment must ' +
    'be verified disabled: its documented insufficiency fallback changes the debited asset.',
});

/**
 * Deterministic fixture policy used by the golden partial-fill example in TDD section 6 and
 * TEST-PLAN section 4. It charges quote commission on a BUY, which the standard Binance
 * schedule does not; it exists to keep the reviewed golden numbers reproducible and is
 * never selectable for a real dispatch.
 */
export const QUOTE_FEE_FIXTURE_V1: FeePolicy = Object.freeze({
  version: 'QUOTE_FEE_FIXTURE_V1',
  route: 'RECEIVED_ASSET',
  cumulativeBoundProven: true,
  requiredAccountSettings: ['environment=local'],
  rationale:
    'Deterministic test fixture reproducing the reviewed golden example (0.1% quote fee on a ' +
    'BUY). Fixture policy only; refused outside the local environment.',
});

/** BNB discount routing is defined but disabled: no cumulative bound is proven for it. */
export const BNB_DISCOUNT_UNPROVEN: FeePolicy = Object.freeze({
  version: 'BNB_DISCOUNT_UNPROVEN',
  route: 'BNB_DISCOUNT',
  cumulativeBoundProven: false,
  requiredAccountSettings: ['bnbBurnSpot=true', 'bnbSufficiencyBound.verified=true'],
  rationale:
    'Binance documents BNB commission falling back to the received asset when the BNB balance ' +
    'is insufficient. Until that fallback is bounded for every permitted partial fill, no ' +
    'reservation ceiling is provable and dispatch under this policy is refused.',
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
 * Gate used before sealing and again before marking. A policy without a proven cumulative
 * bound never reaches dispatch (IMPLEMENTATION-PLAN section 7).
 */
export function assertFeePolicyDispatchable(
  policy: FeePolicy,
  environment: 'local' | 'testnet' | 'production',
): void {
  if (!policy.cumulativeBoundProven) {
    violate('FEE_BOUND_UNPROVEN', 'fee policy has no proven cumulative debit bound', {
      version: policy.version,
    });
  }
  if (policy.version === 'QUOTE_FEE_FIXTURE_V1' && environment !== 'local') {
    violate(
      'FEE_ASSET_UNSUPPORTED',
      'fixture fee policy is refused outside the local environment',
      {
        version: policy.version,
        environment,
      },
    );
  }
}
