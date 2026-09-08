import { formatAssetKey, type AssetKey, type Environment } from '@capitaldesk/contracts';
import { isSupportedAsset, type SupportedAssets } from './assets.js';

/**
 * What must hold before a single opening balance is written (TDD section 6; prompt 06 task 2).
 *
 * Each condition is a way the first posting could attribute somebody else's money, or this
 * account's money to the wrong epoch. They are evaluated together and every unmet one is
 * named: an operator resolving a blocked bootstrap needs the whole list, not whichever check
 * happened to run first.
 *
 * This module decides nothing about *how* the facts were obtained. It is handed what a caller
 * established and answers whether that is enough — so the same predicate answers for the
 * service, for a test, and for an evidence export, and none of the three can disagree.
 */

/** Every condition, in the order the console and the evidence export list them. */
export const BASELINE_CONDITIONS = [
  'coverageComplete',
  'detectionScopeFull',
  'accountIdentityMatches',
  'environmentMatches',
  'epochIsCurrentAndOpen',
  'governanceLeaseHeld',
  'noUnknownOpenOrders',
  'everyObservedAssetSupported',
  'notAlreadyBootstrapped',
] as const;

export type BaselineCondition = (typeof BASELINE_CONDITIONS)[number];

export interface BaselinePreconditions {
  /** The assessed coverage of the observation cut this baseline would be built from. */
  readonly coverageState: 'COMPLETE' | 'INCOMPLETE' | 'GAP_OPEN' | 'UNSUPPORTED';
  readonly detectionScope: 'FULL_WITHIN_PROVEN_UNIVERSE' | 'NET_BALANCE_CHANGES_ONLY';
  /** The account the cut was actually read from, as the venue authenticated it. */
  readonly cutStableAccountId: string;
  /** The account this pool governs. */
  readonly poolStableAccountId: string;
  readonly cutEnvironment: Environment;
  readonly poolEnvironment: Environment;
  readonly cutEpoch: number;
  readonly openEpoch: number;
  readonly epochClosed: boolean;
  readonly holdsGovernanceLease: boolean;
  /** Resting orders the journal cannot name. Adopting their inventory would invent an owner. */
  readonly unknownOpenOrders: number;
  /** Every asset the account actually holds a balance in. */
  readonly observedAssets: readonly AssetKey[];
  readonly alreadyBootstrapped: boolean;
}

export interface BaselineAssessment {
  readonly ready: boolean;
  /** Unmet conditions, in `BASELINE_CONDITIONS` order. */
  readonly unmet: readonly BaselineCondition[];
  /** Observed assets this pool does not support, named so an operator can act. */
  readonly unsupportedAssets: readonly string[];
}

export function assessBaselineReadiness(
  preconditions: BaselinePreconditions,
  supported: SupportedAssets,
): BaselineAssessment {
  const unsupportedAssets = preconditions.observedAssets
    .filter((asset) => !isSupportedAsset(supported, asset))
    .map(formatAssetKey);

  const held: Readonly<Record<BaselineCondition, boolean>> = {
    coverageComplete: preconditions.coverageState === 'COMPLETE',
    detectionScopeFull: preconditions.detectionScope === 'FULL_WITHIN_PROVEN_UNIVERSE',
    // T-056: a different key or alias for another account cannot open this pool's baseline.
    accountIdentityMatches: preconditions.cutStableAccountId === preconditions.poolStableAccountId,
    environmentMatches: preconditions.cutEnvironment === preconditions.poolEnvironment,
    // T-032: a reset opens a new epoch, and old test funds are not current holdings.
    epochIsCurrentAndOpen:
      preconditions.cutEpoch === preconditions.openEpoch && !preconditions.epochClosed,
    governanceLeaseHeld: preconditions.holdsGovernanceLease,
    // A pre-existing order cannot be adopted: the inventory it would move has no owner this
    // pool can name, and guessing one is how a strategy acquires somebody else's position.
    noUnknownOpenOrders: preconditions.unknownOpenOrders === 0,
    everyObservedAssetSupported: unsupportedAssets.length === 0,
    notAlreadyBootstrapped: !preconditions.alreadyBootstrapped,
  };

  const unmet = BASELINE_CONDITIONS.filter((condition) => !held[condition]);
  return { ready: unmet.length === 0, unmet, unsupportedAssets };
}
