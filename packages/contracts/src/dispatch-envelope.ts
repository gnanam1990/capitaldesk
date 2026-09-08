import { violate } from './errors.js';
import { strictUtcMs } from './time.js';

/**
 * The signed-request timing envelope (ADR-0003).
 *
 * The reviewed gap: an approval expiry checked before the dispatch marker does not bind the
 * physical send. A worker could mark at t=99 against a t=100 expiry, pause, resume at
 * t=130, sign a *fresh* request and transmit it. The written check passed; the order reached
 * the venue thirty seconds after the owner's authorization lapsed.
 *
 * A recvWindow alone does not close this, because recvWindow bounds whichever timestamp the
 * signer chose — a fresh signature simply carries a fresh timestamp and is accepted again.
 * The envelope must therefore fix the timestamp, and the code must have no way to produce a
 * new one for the same marker.
 *
 * ## Clock domains
 *
 * Three domains are involved and conflating them is how the first draft of this file was
 * wrong. They are named explicitly:
 *
 *  - ABSOLUTE — true time. Not directly observable by anyone.
 *  - VENUE    — the venue's `serverTime`. The signed `timestamp` field lives here, because
 *               the venue compares it against its own clock.
 *  - LOCAL    — our clock. Approval instants and our own decisions live here.
 *
 * At preflight we measure `venueClockOffsetMs = venueServerTime - localTime`. That
 * measurement has error, and `clockSkewBudgetMs` is the asserted bound on it: if the true
 * offset can differ from the measured offset by more than the budget, the envelope is
 * refused rather than assumed (`CLOCK_SKEW_UNBOUNDED`).
 *
 * ## The venue's predicate
 *
 * Binance accepts a signed request while
 * `serverTime - recvWindow <= timestamp <= serverTime + 1000`. The half that matters here
 * is the first: acceptance remains possible until VENUE time reaches
 * `timestamp + recvWindow`. See the Timing security section of the official Spot REST
 * documentation.
 *
 * ## The two cutoffs, which are not the same number
 *
 *  - **Worst-case venue acceptance cutoff** (safety). The latest LOCAL instant at which the
 *    venue could still accept these bytes, assuming the true offset is as unfavourable as
 *    the budget allows: `signedAtLocal + validity + skewBudget`. This is what must be bound
 *    to the approved submission deadline. Binding the local cutoff instead — as the first
 *    draft did — leaves a window of `2 * skewBudget` in which a paused transmitter's bytes
 *    are still valid after the owner's authorization lapsed.
 *
 *  - **Guaranteed transmission cutoff** (liveness). The latest LOCAL instant at which the
 *    venue is certain to still accept: `signedAtLocal + validity - skewBudget - latency`.
 *    Transmitting after it is not unsafe — the envelope construction already guarantees the
 *    venue cannot accept past the deadline — it is merely pointless, so we stop.
 *
 * Safety therefore comes from the envelope's construction, not from a check performed just
 * before the socket write. A transmitter that pauses between its final check and the
 * physical send cannot cause a post-deadline acceptance, because the bytes it holds expire
 * at the venue before the deadline under every offset within the budget.
 *
 * ## Structural half of the contract
 *
 * The complete signed request — including its `timestamp` and `recvWindow` parameters and
 * its HMAC — is produced inside the same transaction that commits DISPATCH_MARKED, and
 * persisted with the marker. The sending path is a transmitter: it accepts already-signed
 * bytes and holds no key material and no signing function. An old marker cannot acquire a
 * fresh signature, because after the marker commits nothing in the process can sign at all.
 */
export interface SignedRequestEnvelope {
  /** The VENUE-domain millisecond timestamp inside the signed request. Frozen at marker time. */
  readonly signedTimestampMs: number;
  /** Measured `venueServerTime - localTime` at preflight. Converts between the two domains. */
  readonly venueClockOffsetMs: number;
  /** The recvWindow, in milliseconds, inside the same signed request. */
  readonly validityMs: number;
  /** Asserted bound on the error of `venueClockOffsetMs`. Applied in both directions. */
  readonly clockSkewBudgetMs: number;
  /** Budgeted time between our final local check and the bytes reaching the venue. */
  readonly transmissionLatencyBudgetMs: number;
  /** Digest of the exact bytes to transmit. Any change to the request changes this. */
  readonly signedPayloadDigest: string;
}

/** Binance rejects a recvWindow above 60000 ms. */
export const MAX_SIGNED_REQUEST_VALIDITY_MS = 60_000;

export function assertEnvelopeWellFormed(envelope: SignedRequestEnvelope): void {
  const integers: ReadonlyArray<readonly [string, number]> = [
    ['signedTimestampMs', envelope.signedTimestampMs],
    ['venueClockOffsetMs', envelope.venueClockOffsetMs],
    ['validityMs', envelope.validityMs],
    ['clockSkewBudgetMs', envelope.clockSkewBudgetMs],
    ['transmissionLatencyBudgetMs', envelope.transmissionLatencyBudgetMs],
  ];
  for (const [name, value] of integers) {
    if (!Number.isSafeInteger(value)) {
      violate('IDENTITY_MALFORMED', `${name} must be a safe integer number of milliseconds`, {
        [name]: String(value),
      });
    }
  }
  if (envelope.signedTimestampMs <= 0) {
    violate('IDENTITY_MALFORMED', 'signedTimestampMs must be a positive venue-domain instant', {
      signedTimestampMs: String(envelope.signedTimestampMs),
    });
  }
  if (envelope.validityMs <= 0 || envelope.validityMs > MAX_SIGNED_REQUEST_VALIDITY_MS) {
    violate(
      'IDENTITY_MALFORMED',
      `validityMs must be between 1 and ${MAX_SIGNED_REQUEST_VALIDITY_MS} ms`,
      { validityMs: String(envelope.validityMs) },
    );
  }
  if (envelope.clockSkewBudgetMs < 0 || envelope.transmissionLatencyBudgetMs < 0) {
    violate('CLOCK_SKEW_UNBOUNDED', 'skew and latency budgets must be nonnegative', {
      clockSkewBudgetMs: String(envelope.clockSkewBudgetMs),
      transmissionLatencyBudgetMs: String(envelope.transmissionLatencyBudgetMs),
    });
  }
  // The guaranteed transmission window must be non-empty, otherwise the envelope is
  // unusable: there would be no local instant at which the venue is certain to accept.
  if (
    envelope.validityMs <=
    2 * envelope.clockSkewBudgetMs + envelope.transmissionLatencyBudgetMs
  ) {
    violate(
      'CLOCK_SKEW_UNBOUNDED',
      'validityMs must exceed twice the clock-skew budget plus the transmission latency ' +
        'budget, otherwise no instant is guaranteed transmissible',
      {
        validityMs: String(envelope.validityMs),
        clockSkewBudgetMs: String(envelope.clockSkewBudgetMs),
        transmissionLatencyBudgetMs: String(envelope.transmissionLatencyBudgetMs),
      },
    );
  }
}

/** The LOCAL instant at which these bytes were signed. */
export function signedAtLocalMs(envelope: SignedRequestEnvelope): number {
  assertEnvelopeWellFormed(envelope);
  return envelope.signedTimestampMs - envelope.venueClockOffsetMs;
}

/**
 * Safety bound. The latest LOCAL instant at which the venue could still accept these bytes,
 * under the least favourable true clock offset the budget permits.
 */
export function worstCaseVenueAcceptanceCutoffLocalMs(envelope: SignedRequestEnvelope): number {
  return signedAtLocalMs(envelope) + envelope.validityMs + envelope.clockSkewBudgetMs;
}

/**
 * Liveness bound. The latest LOCAL instant at which the venue is certain to still accept,
 * after allowing for transmission latency.
 */
export function guaranteedTransmissionCutoffLocalMs(envelope: SignedRequestEnvelope): number {
  return (
    signedAtLocalMs(envelope) +
    envelope.validityMs -
    envelope.clockSkewBudgetMs -
    envelope.transmissionLatencyBudgetMs
  );
}

/**
 * Checked at marker time, before the bytes are frozen.
 *
 * The binding condition is on the WORST-CASE venue acceptance cutoff, not on our local
 * transmission cutoff: what the owner authorized is that no order may take effect after the
 * deadline, and only the worst case establishes that.
 */
export function assertEnvelopeWithinApproval(
  envelope: SignedRequestEnvelope,
  submissionDeadlineAtIso: string,
  approvalExpiresAtIso: string,
): void {
  // Strict: a timezone-less value would otherwise be resolved in the host's local zone, so
  // two executors on differently configured hosts would derive different deadlines from one
  // approval.
  const deadline = strictUtcMs('submissionDeadlineAt', submissionDeadlineAtIso);
  const expiry = strictUtcMs('approvalExpiresAt', approvalExpiresAtIso);
  if (deadline > expiry) {
    violate(
      'SUBMISSION_DEADLINE_PASSED',
      'the submission deadline may not outlive the owner approval it depends on',
      { submissionDeadlineAt: submissionDeadlineAtIso, approvalExpiresAt: approvalExpiresAtIso },
    );
  }

  const worstCase = worstCaseVenueAcceptanceCutoffLocalMs(envelope);
  if (worstCase > deadline) {
    violate(
      'SUBMISSION_DEADLINE_PASSED',
      'these signed bytes could still be accepted by the venue after the approved submission ' +
        'deadline under a permitted clock offset; shorten recvWindow, sign earlier, or ' +
        're-approve with a later deadline',
      {
        worstCaseVenueAcceptanceCutoff: new Date(worstCase).toISOString(),
        submissionDeadlineAt: submissionDeadlineAtIso,
        overshootMs: String(worstCase - deadline),
      },
    );
  }
}

/**
 * Checked immediately before transmission by the process holding the already-signed bytes.
 *
 * This is a liveness check, not the safety property: a transmitter that pauses after this
 * check and sends anyway cannot cause a post-deadline acceptance, because
 * {@link assertEnvelopeWithinApproval} already established that the bytes expire at the
 * venue before the deadline under every permitted offset.
 */
export function assertTransmissionPermitted(
  envelope: SignedRequestEnvelope,
  localNowMs: number,
): void {
  const cutoff = guaranteedTransmissionCutoffLocalMs(envelope);
  if (localNowMs > cutoff) {
    violate(
      'SUBMISSION_DEADLINE_PASSED',
      'the signed request is past its guaranteed transmission window and must not be sent; ' +
        'resolving this requires a new preview and a new owner approval, never a re-signature',
      {
        localNowMs: String(localNowMs),
        guaranteedTransmissionCutoff: new Date(cutoff).toISOString(),
        signedAtLocal: new Date(signedAtLocalMs(envelope)).toISOString(),
      },
    );
  }
}

/**
 * The venue's own acceptance predicate, stated once so tests and the executor agree on what
 * "the venue would accept" means.
 *
 * A `false` result for a transmission we actually made is a decisive rejection **of that
 * attempt**. It is not evidence that no order exists: an earlier attempt under the same
 * marker may already be ambiguous, and a rejected late transmission never resolves an
 * outstanding UNKNOWN or permits a resend (INV-09, INV-10).
 */
export function venueWouldAccept(
  envelope: SignedRequestEnvelope,
  venueServerTimeMs: number,
): boolean {
  return (
    envelope.signedTimestampMs >= venueServerTimeMs - envelope.validityMs &&
    envelope.signedTimestampMs <= venueServerTimeMs + 1000
  );
}
