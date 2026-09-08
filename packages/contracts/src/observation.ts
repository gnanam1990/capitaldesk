import type { ObservationCoverageState } from './states.js';

/**
 * The account observation boundary (ADR-0002).
 *
 * ## What went wrong in the first version, and why it matters
 *
 * The first predicate was five booleans, one of which was "the stream was connected". A
 * connected socket is not proof of lossless account history, and the combination passed a
 * window that contained an undetected external round trip: disconnect, two offsetting
 * completed trades on a symbol outside the observed set, no resting order left behind, equal
 * balances at both brackets. Every boolean was true and coverage reported COMPLETE.
 *
 * The error was treating *continuity of a transport* as *completeness of history*. This
 * version proves the universe of things that could have moved a governed asset, and refuses
 * when that universe cannot be enumerated.
 *
 * ## What Binance Spot actually offers, and what it does not
 *
 * - `GET /api/v3/openOrders` with no symbol **is** account-wide. An unknown *resting* order is
 *   therefore always discoverable. A closed one is not.
 * - `GET /api/v3/myTrades` **requires a symbol**. There is no account-wide completed-trade
 *   enumeration, so the set of symbols that traded cannot be discovered after the fact.
 * - The user data stream reports balance and execution events across all symbols **while
 *   connected**, but carries no account-wide monotonic event sequence. There is no cursor to
 *   prove that no event was dropped, so we never assume one.
 * - `myTrades` ids are per-symbol and are not a dense account-local sequence. Completeness of
 *   a backfill is established by contiguous cursor pagination reaching an already-booked
 *   trade, never by assuming consecutive ids.
 *
 * ## The consequence, stated plainly
 *
 * There is no unconditional detection guarantee, and this module does not claim one. A
 * movement that changes a governed asset's net balance across the window is caught by the
 * bracketing reconciliation. A set of movements that offsets to zero is caught only if we
 * actually observed the events, or if they occurred on a symbol whose trades we can enumerate.
 * Outside that, coverage is `UNSUPPORTED` and the pool does not execute.
 */

/**
 * How much of the account this window's evidence can speak for.
 *
 * Deliberately not a boolean: the honest answer has two levels and the console, the exports
 * and the operator documentation all need to say which one applies.
 */
export type DetectionScope =
  /**
   * Full detection within a proven universe: every symbol and movement type that could have
   * moved a governed asset in this window is enumerable and was enumerated.
   */
  | 'FULL_WITHIN_PROVEN_UNIVERSE'
  /**
   * Net-balance detection only. Movements that change a governed asset's net balance across
   * the window are detected; a set that offsets to zero on a symbol outside the observed set
   * is not. This is not sufficient for governed dispatch.
   */
  | 'NET_BALANCE_CHANGES_ONLY';

/**
 * A certificate that closes a specific stream gap by other means.
 *
 * An interrupted transport is not by itself permanent financial uncertainty. If the symbol
 * and movement universe over the gap can be enumerated exhaustively, and complete paginated
 * history for that universe is still retained, the gap is recoverable and coverage may reach
 * COMPLETE. What the product may not do is *assume* any of that.
 *
 * **No producer of this certificate exists yet.** Constructing one requires concrete venue
 * evidence — an exhaustive symbol enumeration, per-symbol cursor coverage of the gap window,
 * a retention window that still contains it, and enumeration of non-trade movements — and
 * that is module 05's work against a real account. Until it lands, callers pass `null` and an
 * interrupted window is `UNSUPPORTED`. The type exists so the supported recovery path is
 * specified rather than quietly dropped, not so a flag can be set to true.
 */
export interface GapRecoveryCertificate {
  /** The interruption this certificate claims to cover, ISO-8601 UTC. */
  readonly gapStart: string;
  readonly gapEnd: string;
  /**
   * Every symbol that could have traded during the gap. Exhaustive by construction, not by
   * assumption: `universeExhaustivenessEvidence` says how that was established.
   */
  readonly exhaustiveSymbolUniverse: readonly string[];
  /** Reference or digest of the evidence that the enumeration above is exhaustive. */
  readonly universeExhaustivenessEvidence: string;
  /** For every symbol in the universe, pagination covered the gap contiguously. */
  readonly perSymbolPaginationComplete: boolean;
  /** The venue's history retention still contains the whole gap window. */
  readonly retentionCoversGap: boolean;
  /** Deposits, withdrawals and transfers over the gap were enumerated, or proven impossible. */
  readonly nonTradeMovementsEnumerated: boolean;
}

/**
 * Whether a certificate actually proves the universe over its gap.
 *
 * Every field must hold. An empty symbol universe is rejected: "no symbol could have traded"
 * is a claim that needs its own evidence, and an empty list is more often an unpopulated
 * field than a proof.
 */
export function certificateProvesUniverse(certificate: GapRecoveryCertificate): boolean {
  return (
    certificate.exhaustiveSymbolUniverse.length > 0 &&
    certificate.universeExhaustivenessEvidence.length > 0 &&
    certificate.perSymbolPaginationComplete &&
    certificate.retentionCoversGap &&
    certificate.nonTradeMovementsEnumerated &&
    Date.parse(certificate.gapStart) < Date.parse(certificate.gapEnd)
  );
}

export interface CoverageConditions {
  /**
   * U — universe proof. Every symbol and movement type that could have moved a governed asset
   * during the window is enumerable and was enumerated.
   *
   * This is **never** inferred from an uninterrupted socket. A connected stream tells us we
   * were listening; it does not tell us what the set of things to listen for was, and it
   * carries no sequence number that would prove nothing was dropped. U must be established by
   * its own evidence, and where a gap exists, by a {@link GapRecoveryCertificate}.
   */
  readonly movementUniverseProven: boolean;

  /**
   * C1 — a single uninterrupted stream session spanned the window: one listen key, no
   * reconnect, no server close, no missed keepalive.
   *
   * Session-scoped, not sequence-proven: no account-wide event cursor exists, so this bounds
   * *when* we were listening and never asserts that no event was dropped while we were.
   */
  readonly streamSessionUninterrupted: boolean;

  /** C2 — account-wide open-order scan at t1 revealed no order unknown to the journal. */
  readonly accountWideOpenOrderScanClean: boolean;

  /**
   * C3 — for every symbol in the declared observed set, trades were backfilled by contiguous
   * cursor pagination until reaching an already-booked trade. Never by assuming that trade
   * ids are consecutive.
   */
  readonly observedSymbolBackfillContiguous: boolean;

  /**
   * C4 — bracketing balance snapshots differ by exactly the booked economic effects between
   * them. Necessary, never sufficient: offsetting movements leave this true.
   */
  readonly bracketingSnapshotsAgree: boolean;

  /** C5 — every source observation used is inside its declared freshness class. */
  readonly sourcesFresh: boolean;

  /**
   * Whether every movement type that could have occurred is observable at all on this account
   * and environment. Deposits, withdrawals and internal transfers are not observable in the
   * v1 testnet surface.
   */
  readonly allMovementTypesObservable: boolean;
}

export interface CoverageAssessment {
  readonly state: ObservationCoverageState;
  /** Unmet conditions in a stable order, for the console and evidence exports. */
  readonly unmet: readonly string[];
  /** What this window's evidence can honestly speak for. */
  readonly detectionScope: DetectionScope;
}

const CONDITION_LABELS: ReadonlyArray<readonly [keyof CoverageConditions, string]> = [
  [
    'movementUniverseProven',
    'the set of symbols and movement types that could have moved a governed asset is not enumerable for this window',
  ],
  [
    'streamSessionUninterrupted',
    'the account-wide event stream session was interrupted during the window',
  ],
  [
    'accountWideOpenOrderScanClean',
    'account-wide open-order scan found an order unknown to the journal',
  ],
  [
    'observedSymbolBackfillContiguous',
    'observed-symbol trade backfill did not page contiguously to an already-booked trade',
  ],
  ['bracketingSnapshotsAgree', 'bracketing balance snapshots disagree with booked effects'],
  ['sourcesFresh', 'a source observation is outside its freshness class'],
  ['allMovementTypesObservable', 'a possible movement type is not observable on this account'],
];

export function assessCoverage(
  conditions: CoverageConditions,
  /**
   * A certificate closing an interrupted window. Today no producer exists, so callers pass
   * `null` and an interrupted session is UNSUPPORTED.
   */
  gapCertificate: GapRecoveryCertificate | null = null,
): CoverageAssessment {
  const certified = gapCertificate !== null && certificateProvesUniverse(gapCertificate);

  // A stream gap is recoverable when a certificate proves the universe over it. A transport
  // interruption is not by itself permanent financial uncertainty; what makes a window
  // unrecoverable is the absence of the proof, not the absence of the socket.
  const sessionSatisfied = conditions.streamSessionUninterrupted || certified;
  const universeSatisfied = conditions.movementUniverseProven || certified;

  const unmet = CONDITION_LABELS.filter(([key]) => {
    if (key === 'streamSessionUninterrupted') return !sessionSatisfied;
    if (key === 'movementUniverseProven') return !universeSatisfied;
    return !conditions[key];
  }).map(([, label]) => label);

  if (unmet.length === 0) {
    return { state: 'COMPLETE', unmet: [], detectionScope: 'FULL_WITHIN_PROVEN_UNIVERSE' };
  }

  // Without a proof, the evidence needed to close this cannot be fetched from the venue at
  // all: it is UNSUPPORTED rather than a backlog item, and the pool does not execute until an
  // owner adjudicates.
  const unsupported =
    !universeSatisfied || !conditions.allMovementTypesObservable || !sessionSatisfied;

  if (unsupported) {
    return { state: 'UNSUPPORTED', unmet, detectionScope: 'NET_BALANCE_CHANGES_ONLY' };
  }

  if (!conditions.observedSymbolBackfillContiguous) {
    return { state: 'GAP_OPEN', unmet, detectionScope: 'NET_BALANCE_CHANGES_ONLY' };
  }

  return { state: 'INCOMPLETE', unmet, detectionScope: 'NET_BALANCE_CHANGES_ONLY' };
}

/**
 * Governed dispatch requires COMPLETE coverage. There is no "probably fine" path, and no
 * elapsed time that substitutes for the predicate (INV-10).
 */
export function coveragePermitsDispatch(state: ObservationCoverageState): boolean {
  return state === 'COMPLETE';
}

/**
 * The detection statement for this assessment, for the console, exports and operator
 * documentation.
 *
 * Written as a limitation rather than a guarantee on purpose. The product must not tell an
 * operator that all external activity is detected, because for a net-zero round trip on an
 * unenumerable symbol during an unobserved interval, it is not.
 */
export function describeDetection(assessment: CoverageAssessment): string {
  if (assessment.detectionScope === 'FULL_WITHIN_PROVEN_UNIVERSE') {
    return (
      'Every symbol and movement type that could have moved a governed asset in this window ' +
      'was enumerable and was enumerated. External activity in this window is detected and ' +
      'attributable.'
    );
  }
  return (
    'Coverage for this window is incomplete. Movements that change a governed asset net ' +
    'balance across the window are detected by the bracketing reconciliation. Movements that ' +
    'offset to zero on a symbol outside the observed set are not detectable, because this ' +
    'venue provides no account-wide enumeration of completed trades. Governed dispatch is ' +
    'blocked until an owner adjudicates.'
  );
}
