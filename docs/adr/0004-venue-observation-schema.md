# ADR-0004 — Supported actions and observed outcomes need different schemas

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F4 (High for affected venue outcomes)
- Amends: TDD section 8; TEST-PLAN section 7; prompts 02, 05, 15

## Context

The venue status enum omitted `EXPIRED_IN_MATCH`, which Binance defines for self-trade
prevention, including an order meeting another with the same `tradeGroupId`. The user data
stream also reports `TRADE_PREVENTION` execution reports carrying prevented quantities.

A narrow IOC submission policy does not prove these are impossible: other account or
trade-group activity can produce them. The underlying mistake is conflating two schemas —
what we are permitted to *submit* is not the same set as what we might *observe*.

## Decision

1. **Separate the schemas.** Outgoing actions stay narrow: `LIMIT` + `IOC` only. Incoming
   observations are wide, because the venue decides what we see.

2. **Add the missing terminal status.** `EXPIRED_IN_MATCH` is a terminal venue status.
   Reconciliation consumes only actually traded quantity; prevented quantity is never a fill,
   and no trade is fabricated for it.

3. **Preserve prevention evidence.** `TRADE_PREVENTION` execution reports are retained raw,
   including `preventedQuantity`, `preventedMatchId` and `tradeGroupId`. They are evidence,
   not accounting entries.

4. **Unknown future statuses are preserved, not guessed.** Any status outside the known set
   is stored raw and mapped to `UNSUPPORTED_OBSERVATION`, which quarantines the affected
   accounting. Silently mapping an unrecognised status onto the nearest familiar one is
   exactly how a product invents a fact.

5. **Capability recording.** If a selected mode provably excludes STP, that is recorded as an
   explicit verified capability with its evidence — never assumed by omission.

6. **Order-list pending states** stay unsupported for governed submissions while remaining
   preservable during external-activity discovery.

## Consequences

Reconcilers must treat an unknown status as a blocking condition rather than a default
branch. This will occasionally quarantine on a benign new venue status; that is the correct
direction to fail.

## Tests

Zero-fill STP expiry; actual fills followed by STP terminality; trade-group interaction; an
unknown future status reaching `UNSUPPORTED_OBSERVATION` and quarantining rather than
mapping. Extends T-033.
