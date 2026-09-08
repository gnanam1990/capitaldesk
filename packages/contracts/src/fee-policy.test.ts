import { describe, expect, it } from 'vitest';
import {
  BNB_DISCOUNT_UNPROVEN,
  QUOTE_FEE_FIXTURE_V1,
  STANDARD_NO_BNB_V1,
  assertFeePolicyDispatchable,
  feePolicy,
  type FeeBoundEvidence,
} from './fee-policy.js';

function evidence(overrides: Partial<FeeBoundEvidence> = {}): FeeBoundEvidence {
  return {
    policyVersion: 'QUOTE_FEE_FIXTURE_V1',
    derivedAt: '2026-09-08T00:00:00.000Z',
    maxFillCount: 8,
    minFillBaseAtoms: 1_000n,
    derivationDigest: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

describe('fee policy capability', () => {
  it('resolves known policies and refuses unknown ones', () => {
    expect(feePolicy('STANDARD_NO_BNB_V1').route).toBe('RECEIVED_ASSET');
    expect(() => feePolicy('MADE_UP')).toThrow(/FEE_ASSET_UNSUPPORTED/);
  });

  // --- regression: maintainer review, a hardcoded proven flag --------------------------
  // STANDARD_NO_BNB_V1 declared cumulativeBoundProven: true on the grounds that the bound is
  // the sum of per-fill ceilings. That describes the realized fee once the fills are known;
  // it is not an a-priori bound, because nothing bounded the number of fills.
  describe('the standard policy is not yet proven (regression: draft review)', () => {
    it('carries UNVERIFIED rather than a proven flag', () => {
      expect(STANDARD_NO_BNB_V1.boundStatus).toBe('UNVERIFIED');
    });

    it('refuses dispatch on testnet even with evidence supplied', () => {
      expect(() =>
        assertFeePolicyDispatchable(
          STANDARD_NO_BNB_V1,
          'testnet',
          evidence({ policyVersion: 'STANDARD_NO_BNB_V1' }),
        ),
      ).toThrow(/no derived pre-trade cumulative debit bound/);
    });

    it('explains in its rationale that the fill count is what is missing', () => {
      expect(STANDARD_NO_BNB_V1.rationale).toMatch(/bound on the number of fills/);
    });
  });

  describe('a status alone can never authorize dispatch', () => {
    it('refuses a PROVEN policy when no derivation is supplied', () => {
      expect(() => assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', null)).toThrow(
        /no fee bound derivation was supplied/,
      );
    });

    it('refuses a derivation produced for a different policy', () => {
      expect(() =>
        assertFeePolicyDispatchable(
          QUOTE_FEE_FIXTURE_V1,
          'local',
          evidence({ policyVersion: 'STANDARD_NO_BNB_V1' }),
        ),
      ).toThrow(/derived for a different policy/);
    });

    it('refuses a derivation with no finite fill count', () => {
      for (const maxFillCount of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
        expect(() =>
          assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', evidence({ maxFillCount })),
        ).toThrow(/finite maximum fill count/);
      }
    });

    it('refuses a derivation with no positive minimum fill size', () => {
      expect(() =>
        assertFeePolicyDispatchable(
          QUOTE_FEE_FIXTURE_V1,
          'local',
          evidence({ minFillBaseAtoms: 0n }),
        ),
      ).toThrow(/positive minimum fill size/);
    });

    it('accepts the fixture policy locally with a complete derivation', () => {
      expect(() =>
        assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', evidence()),
      ).not.toThrow();
    });
  });

  describe('BNB routing stays refused', () => {
    it('is UNVERIFIED: an absent derivation, not a proof that no bound exists', () => {
      expect(BNB_DISCOUNT_UNPROVEN.boundStatus).toBe('UNVERIFIED');
    });

    it('says why in terms of the fallback, without claiming impossibility', () => {
      expect(BNB_DISCOUNT_UNPROVEN.rationale).toMatch(/absent derivation/);
      expect(BNB_DISCOUNT_UNPROVEN.rationale).toMatch(/a bound may well exist/);
    });

    it('refuses dispatch regardless of supplied evidence', () => {
      expect(() =>
        assertFeePolicyDispatchable(
          BNB_DISCOUNT_UNPROVEN,
          'testnet',
          evidence({ policyVersion: 'BNB_DISCOUNT_UNPROVEN' }),
        ),
      ).toThrow(/FEE_BOUND_UNPROVEN/);
    });
  });

  describe('the fixture policy cannot escape the local environment', () => {
    for (const environment of ['testnet', 'production'] as const) {
      it(`is refused in ${environment}`, () => {
        expect(() =>
          assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, environment, evidence()),
        ).toThrow(/refused outside the local environment/);
      });
    }
  });

  it('ships no policy that can authorize a real dispatch today', () => {
    // The honest state of the milestone: no fee path is executable outside fixtures.
    for (const policy of [STANDARD_NO_BNB_V1, BNB_DISCOUNT_UNPROVEN]) {
      expect(() =>
        assertFeePolicyDispatchable(policy, 'testnet', evidence({ policyVersion: policy.version })),
      ).toThrow();
    }
  });
});
