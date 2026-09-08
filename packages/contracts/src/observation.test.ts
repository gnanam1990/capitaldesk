import { describe, expect, it } from 'vitest';
import {
  assessCoverage,
  certificateProvesUniverse,
  coveragePermitsDispatch,
  describeDetection,
  type CoverageConditions,
  type GapRecoveryCertificate,
} from './observation.js';

/**
 * Evidence scope for this file.
 *
 * These tests exercise the **gate's truth table**: given a set of claims about what was
 * observed, does the predicate reach the right state. They do not exercise a producer of
 * those claims. Nothing here establishes that a real Binance account can supply
 * `movementUniverseProven` or a valid gap certificate — that is module 05's work against a
 * real account, and it is unimplemented. A green run here is not venue coverage evidence.
 */

/** Every condition satisfied: the only shape that may report COMPLETE. */
function fullyProven(overrides: Partial<CoverageConditions> = {}): CoverageConditions {
  return {
    movementUniverseProven: true,
    streamSessionUninterrupted: true,
    accountWideOpenOrderScanClean: true,
    observedSymbolBackfillContiguous: true,
    bracketingSnapshotsAgree: true,
    sourcesFresh: true,
    allMovementTypesObservable: true,
    ...overrides,
  };
}

describe('account observation coverage', () => {
  describe('the supported positive case', () => {
    it('reports COMPLETE only when every condition holds', () => {
      const assessment = assessCoverage(fullyProven());
      expect(assessment.state).toBe('COMPLETE');
      expect(assessment.unmet).toEqual([]);
      expect(assessment.detectionScope).toBe('FULL_WITHIN_PROVEN_UNIVERSE');
      expect(coveragePermitsDispatch(assessment.state)).toBe(true);
    });

    it('describes detection as full within the proven universe', () => {
      expect(describeDetection(assessCoverage(fullyProven()))).toMatch(/detected and attributable/);
    });
  });

  // --- regression: maintainer review, an undetected external round trip ----------------
  // Disconnected window, two offsetting completed trades on a symbol outside the observed
  // set, no resting order left behind, equal balances at both brackets. The previous
  // predicate reported COMPLETE: every boolean was true, because a connected socket was
  // treated as proof of lossless history and the omitted symbol was never in scope.
  describe('offsetting external trades outside the observed set (regression)', () => {
    const adverse = fullyProven({
      // The operator believes the gap was closed, because the observed-symbol backfill
      // succeeded. It was not: the trades were on a symbol nobody was enumerating.
      movementUniverseProven: false,
      streamSessionUninterrupted: false,
    });

    it('does not report COMPLETE', () => {
      expect(assessCoverage(adverse).state).not.toBe('COMPLETE');
    });

    it('reports UNSUPPORTED rather than a gap that could be filled later', () => {
      // The evidence needed to close this cannot be fetched from the venue at all, so it is
      // not a backlog item. UNSUPPORTED forces owner adjudication.
      expect(assessCoverage(adverse).state).toBe('UNSUPPORTED');
    });

    it('blocks dispatch', () => {
      expect(coveragePermitsDispatch(assessCoverage(adverse).state)).toBe(false);
    });

    it('narrows the stated detection scope to net balance changes only', () => {
      expect(assessCoverage(adverse).detectionScope).toBe('NET_BALANCE_CHANGES_ONLY');
      expect(describeDetection(assessCoverage(adverse))).toMatch(
        /offset to zero .* are not detectable/s,
      );
    });

    it('names the unenumerable universe as the reason', () => {
      expect(assessCoverage(adverse).unmet.join(' ')).toMatch(/not enumerable/);
    });

    it('still refuses when only the universe proof is missing', () => {
      // Even with an uninterrupted session claimed, an unprovable universe is decisive.
      expect(assessCoverage(fullyProven({ movementUniverseProven: false })).state).toBe(
        'UNSUPPORTED',
      );
    });

    it('still refuses when only the session was interrupted', () => {
      expect(assessCoverage(fullyProven({ streamSessionUninterrupted: false })).state).toBe(
        'UNSUPPORTED',
      );
    });
  });

  describe('agreeing balances are never sufficient on their own', () => {
    it('does not reach COMPLETE on bracketing agreement alone', () => {
      const onlyBrackets: CoverageConditions = {
        movementUniverseProven: false,
        streamSessionUninterrupted: false,
        accountWideOpenOrderScanClean: false,
        observedSymbolBackfillContiguous: false,
        bracketingSnapshotsAgree: true,
        sourcesFresh: false,
        allMovementTypesObservable: false,
      };
      expect(assessCoverage(onlyBrackets).state).toBe('UNSUPPORTED');
    });
  });

  describe('each remaining condition, failed in turn', () => {
    it('an unknown resting order leaves coverage INCOMPLETE', () => {
      const assessment = assessCoverage(fullyProven({ accountWideOpenOrderScanClean: false }));
      expect(assessment.state).toBe('INCOMPLETE');
      expect(assessment.unmet.join(' ')).toMatch(/open-order scan/);
    });

    it('a non-contiguous observed-symbol backfill leaves a GAP_OPEN', () => {
      const assessment = assessCoverage(fullyProven({ observedSymbolBackfillContiguous: false }));
      expect(assessment.state).toBe('GAP_OPEN');
      expect(assessment.unmet.join(' ')).toMatch(/page contiguously/);
    });

    it('disagreeing brackets leave coverage INCOMPLETE', () => {
      expect(assessCoverage(fullyProven({ bracketingSnapshotsAgree: false })).state).toBe(
        'INCOMPLETE',
      );
    });

    it('a stale source leaves coverage INCOMPLETE', () => {
      expect(assessCoverage(fullyProven({ sourcesFresh: false })).state).toBe('INCOMPLETE');
    });

    it('an unobservable movement type is UNSUPPORTED, not INCOMPLETE', () => {
      expect(assessCoverage(fullyProven({ allMovementTypesObservable: false })).state).toBe(
        'UNSUPPORTED',
      );
    });

    it('blocks dispatch in every non-COMPLETE state', () => {
      for (const state of ['GAP_OPEN', 'BACKFILLING', 'INCOMPLETE', 'UNSUPPORTED'] as const) {
        expect(coveragePermitsDispatch(state), state).toBe(false);
      }
    });
  });

  /**
   * A transport interruption is not by itself permanent financial uncertainty. If the symbol
   * and movement universe over the gap can be enumerated exhaustively and its history is
   * still retained, the window is recoverable.
   *
   * No producer of such a certificate exists yet, so in the running product this path is
   * never taken. It is specified and tested so the supported recovery path is not quietly
   * dropped, and so that adding a producer later cannot silently change the gate's meaning.
   */
  describe('a certified gap is recoverable', () => {
    function certificate(overrides: Partial<GapRecoveryCertificate> = {}): GapRecoveryCertificate {
      return {
        gapStart: '2026-09-08T10:00:00.000Z',
        gapEnd: '2026-09-08T10:04:00.000Z',
        exhaustiveSymbolUniverse: ['BTCUSDT', 'BNBUSDT'],
        universeExhaustivenessEvidence: `sha256:${'b'.repeat(64)}`,
        perSymbolPaginationComplete: true,
        retentionCoversGap: true,
        nonTradeMovementsEnumerated: true,
        ...overrides,
      };
    }

    const interrupted = fullyProven({
      streamSessionUninterrupted: false,
      movementUniverseProven: false,
    });

    it('reaches COMPLETE when a valid certificate closes the gap', () => {
      const assessment = assessCoverage(interrupted, certificate());
      expect(assessment.state).toBe('COMPLETE');
      expect(assessment.detectionScope).toBe('FULL_WITHIN_PROVEN_UNIVERSE');
    });

    it('stays UNSUPPORTED with no certificate', () => {
      expect(assessCoverage(interrupted, null).state).toBe('UNSUPPORTED');
    });

    it('rejects a certificate whose pagination did not cover the gap', () => {
      expect(
        assessCoverage(interrupted, certificate({ perSymbolPaginationComplete: false })).state,
      ).toBe('UNSUPPORTED');
    });

    it('rejects a certificate whose gap predates retention', () => {
      expect(assessCoverage(interrupted, certificate({ retentionCoversGap: false })).state).toBe(
        'UNSUPPORTED',
      );
    });

    it('rejects a certificate that did not enumerate non-trade movements', () => {
      expect(
        assessCoverage(interrupted, certificate({ nonTradeMovementsEnumerated: false })).state,
      ).toBe('UNSUPPORTED');
    });

    it('rejects an empty symbol universe rather than reading it as "nothing traded"', () => {
      expect(certificateProvesUniverse(certificate({ exhaustiveSymbolUniverse: [] }))).toBe(false);
    });

    it('rejects a certificate with no exhaustiveness evidence', () => {
      expect(certificateProvesUniverse(certificate({ universeExhaustivenessEvidence: '' }))).toBe(
        false,
      );
    });

    it('rejects a certificate whose window is empty or inverted', () => {
      expect(
        certificateProvesUniverse(
          certificate({ gapStart: '2026-09-08T10:04:00.000Z', gapEnd: '2026-09-08T10:00:00.000Z' }),
        ),
      ).toBe(false);
    });

    it('does not let a certificate paper over an unrelated failing condition', () => {
      const alsoStale = fullyProven({
        streamSessionUninterrupted: false,
        movementUniverseProven: false,
        sourcesFresh: false,
      });
      expect(assessCoverage(alsoStale, certificate()).state).toBe('INCOMPLETE');
    });
  });

  describe('the universe is never inferred from the transport', () => {
    it('an uninterrupted session alone does not establish the universe', () => {
      // C1 true, U false: a connected socket says we were listening, not what we were
      // listening for, and it carries no sequence proving nothing was dropped.
      const assessment = assessCoverage(
        fullyProven({ streamSessionUninterrupted: true, movementUniverseProven: false }),
        null,
      );
      expect(assessment.state).toBe('UNSUPPORTED');
      expect(assessment.unmet.join(' ')).toMatch(/not enumerable/);
    });
  });

  describe('no unconditional detection promise is made', () => {
    it('never describes detection as guaranteed when coverage is not complete', () => {
      const partial = assessCoverage(fullyProven({ sourcesFresh: false }));
      const text = describeDetection(partial);
      expect(text).not.toMatch(/always/i);
      expect(text).toMatch(/incomplete/i);
    });
  });
});
