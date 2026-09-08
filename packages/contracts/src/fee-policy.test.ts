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

/** The account settings the fixture policy requires, as a caller would have verified them. */
const FIXTURE_SETTINGS = [...QUOTE_FEE_FIXTURE_V1.requiredAccountSettings];

describe('fee policy capability', () => {
  // --- regression: PR 1 review, the fixture route was mislabelled ----------------------
  // The golden example charges quote commission on a BUY, which RECEIVED_ASSET does not
  // describe. An allocator reading `route` would have debited the wrong asset.
  it('labels the fixture route as quote-always, matching what it actually charges', () => {
    expect(QUOTE_FEE_FIXTURE_V1.route).toBe('QUOTE_ALWAYS');
    expect(STANDARD_NO_BNB_V1.route).toBe('RECEIVED_ASSET');
  });

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
      expect(() =>
        assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', null, FIXTURE_SETTINGS),
      ).toThrow(/no fee bound derivation was supplied/);
    });

    it('refuses a derivation produced for a different policy', () => {
      expect(() =>
        assertFeePolicyDispatchable(
          QUOTE_FEE_FIXTURE_V1,
          'local',
          evidence({ policyVersion: 'STANDARD_NO_BNB_V1' }),
          FIXTURE_SETTINGS,
        ),
      ).toThrow(/derived for a different policy/);
    });

    it('refuses a derivation with no finite fill count', () => {
      for (const maxFillCount of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
        expect(() =>
          assertFeePolicyDispatchable(
            QUOTE_FEE_FIXTURE_V1,
            'local',
            evidence({ maxFillCount }),
            FIXTURE_SETTINGS,
          ),
        ).toThrow(/finite maximum fill count/);
      }
    });

    it('refuses a derivation with no positive minimum fill size', () => {
      expect(() =>
        assertFeePolicyDispatchable(
          QUOTE_FEE_FIXTURE_V1,
          'local',
          evidence({ minFillBaseAtoms: 0n }),
          FIXTURE_SETTINGS,
        ),
      ).toThrow(/positive minimum fill size/);
    });

    it('accepts the fixture policy locally with a complete derivation', () => {
      expect(() =>
        assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', evidence(), FIXTURE_SETTINGS),
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
          assertFeePolicyDispatchable(
            QUOTE_FEE_FIXTURE_V1,
            environment,
            evidence(),
            FIXTURE_SETTINGS,
          ),
        ).toThrow(/refused outside the local environment/);
      });
    }
  });

  // --- regression: PR 1 review, evidence fields and account settings unchecked ---------
  describe('the derivation record must be well formed', () => {
    it('refuses a derivedAt that is not a real UTC instant', () => {
      for (const derivedAt of ['not-a-date', '2026-02-30T00:00:00.000Z', '2026-09-08T00:00:00']) {
        expect(
          () =>
            assertFeePolicyDispatchable(
              QUOTE_FEE_FIXTURE_V1,
              'local',
              evidence({ derivedAt }),
              FIXTURE_SETTINGS,
            ),
          derivedAt,
        ).toThrow(/derivedAt must be a real ISO-8601 UTC instant/);
      }
    });

    it('refuses a derivation digest that is not a sha256 reference', () => {
      for (const derivationDigest of ['', 'not-a-digest', 'sha256:xyz', 'md5:' + 'a'.repeat(32)]) {
        expect(
          () =>
            assertFeePolicyDispatchable(
              QUOTE_FEE_FIXTURE_V1,
              'local',
              evidence({ derivationDigest }),
              FIXTURE_SETTINGS,
            ),
          derivationDigest,
        ).toThrow(/sha256 digest/);
      }
    });

    it('checks the digest structurally only, which the source states explicitly', () => {
      // A well-formed digest that names nothing real still passes. Verifying that the
      // derivation exists and says what it claims needs the producer, which is module 14.
      expect(() =>
        assertFeePolicyDispatchable(
          QUOTE_FEE_FIXTURE_V1,
          'local',
          evidence({ derivationDigest: `sha256:${'0'.repeat(64)}` }),
          FIXTURE_SETTINGS,
        ),
      ).not.toThrow();
    });
  });

  describe('required account settings are enforced, not merely declared', () => {
    it('refuses when a required setting was not verified', () => {
      expect(() =>
        assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', evidence(), []),
      ).toThrow(/required account settings were not verified/);
    });

    it('names the settings that are missing', () => {
      try {
        assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', evidence(), []);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as { detail: Record<string, string> }).detail['missing']).toContain(
          'environment=local',
        );
      }
    });

    it('accepts when every required setting was verified', () => {
      expect(() =>
        assertFeePolicyDispatchable(QUOTE_FEE_FIXTURE_V1, 'local', evidence(), FIXTURE_SETTINGS),
      ).not.toThrow();
    });
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
