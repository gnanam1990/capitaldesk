# ADR-0003 — The signed-request timing envelope and the linearization boundary

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F3 (High)
- Amends: TDD section 9; PRD section 8; TEST-PLAN section 5; prompts 11, 12, 13

## Context

Approval expiry is checked before the dispatch marker, which does not bind the physical
send. The reviewer's schedule: plan expiry at t=100, final eligibility check and marker at
t=99, process pauses, resumes at t=130, an adapter signs with a fresh timestamp and sends.
Every written check passed and the order reached the venue thirty seconds after the owner's
authorization lapsed.

Binance's `recvWindow` does not close this on its own. It bounds whichever timestamp the
signer chose; a fresh signature simply carries a fresh timestamp and is accepted again.

## Decision

### 1. Three clock domains, named

- **ABSOLUTE** — true time, observable by nobody.
- **VENUE** — the venue's `serverTime`. The signed `timestamp` lives here.
- **LOCAL** — our clock. Approvals and our own decisions live here.

At preflight we measure `venueClockOffsetMs = serverTime - localTime`. `clockSkewBudgetMs`
is the asserted bound on that measurement's error. If the error cannot be bounded, dispatch
is refused with `CLOCK_SKEW_UNBOUNDED`.

### 2. The timestamp is frozen at marker time, and nothing can re-sign

The complete signed request — `timestamp`, `recvWindow` and HMAC — is produced inside the
same transaction that commits `DISPATCH_MARKED`, and persisted with the marker. The sending
path is a transmitter: it accepts already-signed bytes and holds no key material and no
signing function.

An old marker therefore cannot acquire a fresh signature, because after the marker commits
nothing in the process is able to sign at all. This is the structural half of the fix, and it
is what the review asked for: a concrete binding rather than a rule the code is trusted to
follow.

### 3. Two cutoffs, which are different numbers

Let `signedAtLocal = signedTimestampMs - venueClockOffsetMs`.

- **Worst-case venue acceptance cutoff (safety).**
  `signedAtLocal + validityMs + clockSkewBudgetMs`.
  The latest LOCAL instant at which the venue could still accept, under the least favourable
  true offset the budget permits. **This** is what must be bound to the approved submission
  deadline.
- **Guaranteed transmission cutoff (liveness).**
  `signedAtLocal + validityMs - clockSkewBudgetMs - transmissionLatencyBudgetMs`.
  The latest LOCAL instant at which the venue is certain to accept.

A first draft of this decision bound the _local_ cutoff to the deadline. That was wrong, and
maintainer review demonstrated it: with `signedTimestamp = deadline - 900ms`,
`recvWindow = 1000ms` and `skew = 100ms` the check passed while the venue, at zero true skew,
would still accept 100ms after the approval lapsed. Binding the worst case closes the
`2 x skewBudget` window that mistake left open.

### 4. The linearization boundary, stated exactly

> An order may take economic effect only if the venue accepts a request whose immutable
> signed timestamp was frozen at marker time and whose venue-side validity expires no later
> than the approved `submissionDeadlineAt`.

Safety comes from the envelope's construction, not from a check just before the socket write.
A transmitter that pauses between its final check and the physical send cannot cause a
post-deadline acceptance: the bytes it holds have already expired at the venue under every
offset within the budget.

### 5. What a rejection proves

Once the window passes, Binance rejects with `-1021`. That is decisive evidence about **that
attempt**: those bytes were not accepted. It is not evidence that no order exists — an
earlier attempt under the same marker may still be ambiguous — and it never resolves an
outstanding UNKNOWN or permits a resend.

## Consequences

- `recvWindow` must be short enough that the worst case fits inside the approval, so it
  becomes an economic parameter bound into the plan digest, not a transport tuning knob.
- `validityMs > 2 * clockSkewBudgetMs + transmissionLatencyBudgetMs`, or no instant is
  guaranteed transmissible; such an envelope is refused at construction.
- A late resumed sender produces a venue rejection instead of a late execution.

## Tests

Pause after marker across the deadline; signing attempted after expiry (structurally
impossible, asserted); the reviewer's counterexample envelope refused; the safety property
checked against an independently written model of the documented venue predicate at zero and
both extreme offsets, with a simulated pause between the final check and the send; a UTC
budget-boundary crossing after the marker. Extends T-007, T-008.
