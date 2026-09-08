import { describe, expect, it } from 'vitest';
import {
  assessBaselineReadiness,
  BASELINE_CONDITIONS,
  type BaselinePreconditions,
} from './baseline.js';
import { supportedAssets } from './assets.js';

/**
 * What must hold before a single opening balance is written (TDD section 6; prompt 06 task 2).
 *
 * Every condition here is a way the first posting could attribute somebody else's money, or
 * this account's money to the wrong epoch. They are evaluated together and every unmet one is
 * named, because an operator resolving a blocked bootstrap needs the whole list rather than
 * whichever check happened to run first.
 */
const SUPPORTED = supportedAssets({
  base: { code: 'BTC', scaleVersion: 'v1' },
  quote: { code: 'USDT', scaleVersion: 'v1' },
  feeAssets: [],
});

const READY: BaselinePreconditions = {
  coverageState: 'COMPLETE',
  detectionScope: 'FULL_WITHIN_PROVEN_UNIVERSE',
  cutStableAccountId: 'acct-1',
  poolStableAccountId: 'acct-1',
  cutEnvironment: 'testnet',
  poolEnvironment: 'testnet',
  cutEpoch: 3,
  openEpoch: 3,
  epochClosed: false,
  holdsGovernanceLease: true,
  unknownOpenOrders: 0,
  observedAssets: [
    { code: 'BTC', scaleVersion: 'v1' },
    { code: 'USDT', scaleVersion: 'v1' },
  ],
  alreadyBootstrapped: false,
};

describe('baseline readiness', () => {
  it('is ready when every condition holds', () => {
    const assessment = assessBaselineReadiness(READY, SUPPORTED);
    expect(assessment.ready).toBe(true);
    expect(assessment.unmet).toEqual([]);
  });

  it('names every condition it checks, in a stable order', () => {
    // The order is a wire fact: the console and the evidence export list them like this.
    expect(BASELINE_CONDITIONS).toEqual([
      'coverageComplete',
      'detectionScopeFull',
      'accountIdentityMatches',
      'environmentMatches',
      'epochIsCurrentAndOpen',
      'governanceLeaseHeld',
      'noUnknownOpenOrders',
      'everyObservedAssetSupported',
      'notAlreadyBootstrapped',
    ]);
  });

  describe('each condition refuses on its own', () => {
    it('refuses coverage that is not COMPLETE', () => {
      for (const coverageState of ['INCOMPLETE', 'GAP_OPEN', 'UNSUPPORTED'] as const) {
        const assessment = assessBaselineReadiness({ ...READY, coverageState }, SUPPORTED);
        expect(assessment.ready, coverageState).toBe(false);
        expect(assessment.unmet, coverageState).toContain('coverageComplete');
      }
    });

    it('refuses a cut whose detection scope is only net balance changes', () => {
      // COMPLETE with a narrowed scope cannot happen through the predicate, but a caller
      // assembling the two from separate reads could present it.
      const assessment = assessBaselineReadiness(
        { ...READY, detectionScope: 'NET_BALANCE_CHANGES_ONLY' },
        SUPPORTED,
      );
      expect(assessment.unmet).toContain('detectionScopeFull');
    });

    it('refuses a cut read from a different authenticated account', () => {
      // T-056: a different key or alias for another account cannot open this pool's baseline.
      const assessment = assessBaselineReadiness(
        { ...READY, cutStableAccountId: 'acct-2' },
        SUPPORTED,
      );
      expect(assessment.unmet).toContain('accountIdentityMatches');
    });

    it('refuses a cut read in a different environment', () => {
      const assessment = assessBaselineReadiness(
        { ...READY, cutEnvironment: 'production' },
        SUPPORTED,
      );
      expect(assessment.unmet).toContain('environmentMatches');
    });

    it('refuses a cut from another epoch, and a closed one', () => {
      // T-032: a reset opens a new epoch, and old test funds are not current holdings.
      expect(assessBaselineReadiness({ ...READY, cutEpoch: 2 }, SUPPORTED).unmet).toContain(
        'epochIsCurrentAndOpen',
      );
      expect(assessBaselineReadiness({ ...READY, epochClosed: true }, SUPPORTED).unmet).toContain(
        'epochIsCurrentAndOpen',
      );
    });

    it('refuses without the exclusive governance lease', () => {
      const assessment = assessBaselineReadiness(
        { ...READY, holdsGovernanceLease: false },
        SUPPORTED,
      );
      expect(assessment.unmet).toContain('governanceLeaseHeld');
    });

    it('refuses while an unknown order is open', () => {
      // Pre-existing orders cannot be adopted automatically: the inventory they would move
      // has no owner this pool can name.
      const assessment = assessBaselineReadiness({ ...READY, unknownOpenOrders: 1 }, SUPPORTED);
      expect(assessment.unmet).toContain('noUnknownOpenOrders');
    });

    it('refuses when the account holds an asset this pool does not support', () => {
      const assessment = assessBaselineReadiness(
        {
          ...READY,
          observedAssets: [...READY.observedAssets, { code: 'DOGE', scaleVersion: 'v1' }],
        },
        SUPPORTED,
      );
      expect(assessment.unmet).toContain('everyObservedAssetSupported');
      // And it names which, so the operator knows what to configure or move.
      expect(assessment.unsupportedAssets).toEqual(['DOGE@v1']);
    });

    it('refuses a second bootstrap of the same pool and epoch', () => {
      // T-056: only one claim bootstrap per account.
      const assessment = assessBaselineReadiness(
        { ...READY, alreadyBootstrapped: true },
        SUPPORTED,
      );
      expect(assessment.unmet).toContain('notAlreadyBootstrapped');
    });
  });

  it('reports every unmet condition at once, not just the first', () => {
    const assessment = assessBaselineReadiness(
      {
        ...READY,
        coverageState: 'UNSUPPORTED',
        holdsGovernanceLease: false,
        unknownOpenOrders: 2,
      },
      SUPPORTED,
    );
    expect(assessment.unmet).toEqual([
      'coverageComplete',
      'governanceLeaseHeld',
      'noUnknownOpenOrders',
    ]);
  });

  it('accepts an account holding fewer assets than the pool supports', () => {
    // Supporting an asset is permission to account for it, not a requirement to hold it.
    const assessment = assessBaselineReadiness(
      { ...READY, observedAssets: [{ code: 'USDT', scaleVersion: 'v1' }] },
      SUPPORTED,
    );
    expect(assessment.ready).toBe(true);
  });

  it('accepts an account holding nothing at all', () => {
    const assessment = assessBaselineReadiness({ ...READY, observedAssets: [] }, SUPPORTED);
    expect(assessment.ready).toBe(true);
  });
});
