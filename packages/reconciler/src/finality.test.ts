import { describe, expect, it } from 'vitest';
import { assessFinancialFinality, coverageOf, unresolvedLookupDisposition } from './finality.js';

const complete = {
  movementUniverseProven: true,
  streamOrGapCertificate: true,
  openOrdersComplete: true,
  tradeBackfillComplete: true,
  balanceBracketMatches: true,
  freshnessComplete: true,
  upstreamSupportsRecovery: true,
} as const;

describe('financial finality', () => {
  it('requires terminality, all six cut conditions and matching cumulative totals', () => {
    expect(
      assessFinancialFinality({
        venueStatus: 'EXPIRED',
        coverageProof: complete,
        orderCumulativeBaseAtoms: 2n,
        orderCumulativeQuoteAtoms: 398n,
        fillBaseAtoms: 2n,
        fillQuoteAtoms: 398n,
        hasEvidenceConflict: false,
      }),
    ).toEqual({ ready: true, accounting: 'RECONCILED', coverage: 'COMPLETE' });
    expect(coverageOf({ ...complete, movementUniverseProven: false })).toBe('INCOMPLETE');
    expect(coverageOf({ ...complete, upstreamSupportsRecovery: false })).toBe('UNSUPPORTED');
  });

  it('keeps a terminal order provisional when the last fee/fill page is missing', () => {
    expect(
      assessFinancialFinality({
        venueStatus: 'FILLED',
        coverageProof: { ...complete, tradeBackfillComplete: false },
        orderCumulativeBaseAtoms: 2n,
        orderCumulativeQuoteAtoms: 398n,
        fillBaseAtoms: 2n,
        fillQuoteAtoms: 398n,
        hasEvidenceConflict: false,
      }),
    ).toMatchObject({ ready: false, reason: 'EVIDENCE_INCOMPLETE' });
  });

  it('never converts repeated NOT_FOUND into absence proof', () => {
    expect(
      unresolvedLookupDisposition({ notFoundCount: 1_000_000n, decisiveNonSendEvidence: false }),
    ).toBe('UNRESOLVED');
  });
});
