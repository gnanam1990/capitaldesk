# ADR-0002 — An executable account observation boundary, and a narrower guarantee

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F2 (High)
- Amends: TDD section 9; PRD sections 5 and 7 (FR-018); TEST-PLAN section 8; prompts 05, 15, 16

## Context

The reviewed contract requires "complete known trades, bracketing snapshots and proof of no
intervening economic observations" before financial finality, and correctly rejects repeated
equal balances as proof. It never says how that proof is constructed: no cursor, no
reconnect backfill universe, no retention limit, no acceptance predicate.

It also contains a trap the review named precisely: one _tradable_ symbol must not silently
become one _observed_ symbol. An external order on another symbol can consume the shared
quote or fee asset.

Critically, Binance's Spot REST API has no account-wide completed-trade endpoint —
`myTrades` requires a symbol. So an account-wide _attribution_ guarantee is not available to
us at all, and claiming one would be dishonest.

## Decision

### 1. Prove the universe, not the transport

Coverage over a window `[t0, t1]` is `COMPLETE` only when all of the following hold:

- **U — movement universe proven.** Every symbol and movement type that could have moved a
  governed asset during the window is enumerable and was enumerated.
- **C1 — uninterrupted stream session.** One listen-key session spanned the window with no
  reconnect, server close or missed keepalive. This is _session-scoped, not sequence-proven_:
  there is no account-wide event cursor, so it bounds when we were listening and never
  asserts that nothing was dropped while we were.
- **C2 — account-wide open-order scan** at `t1` shows no order unknown to the journal.
- **C3 — observed-symbol backfill** paged contiguously to an already-booked trade. Trade ids
  are per-symbol and are not a dense account-local sequence, so completeness is established
  by cursor pagination and never by assuming consecutive ids.
- **C4 — bracketing snapshots agree** with the booked effects. Necessary, never sufficient.
- **C5 — freshness.** Every source used is inside its declared freshness class.

An earlier version of this decision used five booleans, one of which was "the stream was
connected". A connected socket is not proof of lossless account history, and maintainer
review demonstrated the consequence: a disconnected window with two offsetting completed
trades on a symbol outside the observed set, no resting order left behind and equal balances
at both brackets satisfied every boolean and reported `COMPLETE`. The error was treating
continuity of a transport as completeness of history.

### 2. When the universe cannot be proven, the answer is UNSUPPORTED

Binance Spot has no account-wide completed-trade enumeration — `myTrades` requires a symbol —
so the set of symbols that traded during an unobserved interval cannot be discovered
afterwards. An interrupted session therefore cannot be repaired by fetching more data, and it
is `UNSUPPORTED` rather than `INCOMPLETE`: not a backlog item, but a state requiring owner
adjudication. `GET /api/v3/openOrders` with no symbol _is_ account-wide, so an unknown
**resting** order remains always discoverable; a closed one does not.

### 3. Detection is stated as a limitation, not a guarantee

There is no unconditional detection promise anywhere in the product. What holds:

- A movement that changes a governed asset's **net** balance across the window is detected by
  the bracketing reconciliation.
- A set of movements that **offsets to zero** is detected only if the events were observed, or
  if they occurred on a symbol whose trades can be enumerated.
- Outside that, coverage is `UNSUPPORTED` and the pool does not execute.

`describeDetection` returns exactly this, and the console, the exports and the operator
documentation use it rather than composing their own wording.

### 4. Unobservable movement types

Deposits, withdrawals and internal transfers are not observable in the v1 testnet surface.
Where such a movement is possible and unobservable, coverage is `UNSUPPORTED` and any
unexplained increase quarantines rather than being adopted as HOUSE inventory.

### 5. Cursors and retention

Per-symbol trade cursors and the last-applied stream event id are persisted with the pool. On
disconnect, dispatch is blocked immediately rather than at the next checkpoint. If a gap
predates supported history retention or cannot be paged, coverage is `UNSUPPORTED`. No global
upstream sequence guarantee is claimed, and none is assumed.

## Consequences

- The declared observed symbol set must include every symbol that can move a governed asset,
  and is owner-visible configuration rather than an implementation detail.
- Any interruption of the event stream ends the window's usefulness for governed dispatch.
  Operationally this makes stream continuity a first-class concern rather than a background
  detail.
- Nothing in the product may say that all external activity is detected. The accurate
  statement is that a net balance change across a window is detected by the bracketing
  reconciliation, and that offsetting activity outside a proven universe is not — which is
  why such a window blocks execution rather than passing quietly.

## Tests

The adverse counterexample above, asserted against the real predicate: an interrupted window
with offsetting trades outside the observed set must not report `COMPLETE`, must report
`UNSUPPORTED`, must block dispatch and must narrow its stated detection scope. Each remaining
condition failed in turn with the specific unmet condition named. Bracketing agreement alone
must not pass. A positive supported case where every condition holds. Extends T-034, T-041,
T-042; new scenarios T-061, T-062.
