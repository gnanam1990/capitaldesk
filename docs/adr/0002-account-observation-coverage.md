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

It also contains a trap the review named precisely: one *tradable* symbol must not silently
become one *observed* symbol. An external order on another symbol can consume the shared
quote or fee asset.

Critically, Binance's Spot REST API has no account-wide completed-trade endpoint —
`myTrades` requires a symbol. So an account-wide *attribution* guarantee is not available to
us at all, and claiming one would be dishonest.

## Decision

### 1. The coverage predicate

Coverage over a window `[t0, t1]` is `COMPLETE` only when all five conditions hold:

1. **Stream continuity.** The user-data stream was connected across the whole window with no
   missed heartbeat, or every gap was backfilled by REST.
2. **Account-wide open-order scan.** `GET /api/v3/openOrders` with no symbol, taken at `t1`,
   contains no order unknown to our journal. This endpoint *is* account-wide, so an unknown
   resting order is always detectable.
3. **Trade backfill.** For every symbol in the declared observed set, trades were backfilled
   by `fromId` cursor with no gap down to the last booked trade id.
4. **Bracketing snapshots agree.** Balance snapshots at `t0` and `t1` differ by exactly the
   sum of booked economic effects between them. This is necessary and *not* sufficient:
   conditions 1-3 supply the coverage, condition 4 only cross-checks it. Equal balances alone
   never establish anything.
5. **Freshness.** Every source observation used is inside its declared freshness class.

Any failure yields `GAP_OPEN`, `BACKFILLING`, `INCOMPLETE` or `UNSUPPORTED`, and governed
dispatch is blocked. There is no delay that substitutes for the predicate.

### 2. The guarantee is narrowed, honestly

We do **not** claim account-wide external-trade attribution, because the upstream API does
not offer it. What v1 actually provides:

- **Detection** of any unexplained balance movement, account-wide, via condition 4.
- **Attribution** of activity only within the declared observed symbol set.
- On detection without attribution: pool-wide quarantine and an evidence-linked incident.

The owner-facing operating constraint is therefore explicit: complete attribution holds only
while no external trading occurs on the governed account. A violation is always *detected*
and quarantines the pool; it is not always *explained*. This is a real product limitation and
belongs in the PRD, the console and the export, not buried in an adapter.

### 3. Unobservable movement types

Deposits, withdrawals and internal transfers are not observable in the v1 testnet surface.
Where such a movement is possible and unobservable, coverage is `UNSUPPORTED` and any
unexplained increase quarantines rather than being adopted as HOUSE inventory.

### 4. Cursors, retention and disconnection

Trade cursors (`fromId` per symbol) and the last-applied stream event id are persisted with
the pool. On disconnect coverage becomes `GAP_OPEN` and dispatch is blocked immediately, not
at the next checkpoint. If the gap predates supported history retention or cannot be paged,
coverage becomes `UNSUPPORTED_COVERAGE_GAP` and the pool quarantines. No global upstream
sequence guarantee is claimed anywhere.

## Consequences

- The declared observed symbol set must include every symbol that can move a governed asset,
  and is owner-visible configuration rather than an implementation detail.
- Marketing and the console must state the operating constraint. "CapitalDesk detects any
  external movement and attributes activity on your observed symbols" is true; "CapitalDesk
  reconciles all external activity" is not.

## Tests

Offline external trade on a different quote-sharing symbol (detected, quarantined,
unattributed); offsetting movements with equal final balances (condition 4 alone must not
pass); missing stream segment with and without a successful backfill; an external lock;
history older than retention; a positive recovery after each recoverable interruption.
Extends T-034, T-041, T-042.
