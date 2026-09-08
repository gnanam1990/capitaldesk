# ADR-0005 — Restoring balances cannot restore lost allocation consent

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F5 (High for disaster recovery)
- Amends: TDD sections 10 and 13; TEST-PLAN section 7; prompt 27

## Context

Suppose the newest backup predates a sealed plan. After it, strategies A and B share an
order with an immutable FIFO schedule and the venue partially fills it. A database loss
removes that schedule and its approval. Binance can return the aggregate fill, but it does
not know whether A or B was first in CapitalDesk. Both attributions fit the same exchange
record equally well.

The reviewed contract safely boots restored services HALTED and forbids inventing history.
That controls execution risk. It does not recover strategy attribution, and a hash of a lost
payload cannot reconstruct it.

## Decision

### 1. Declared durability class

`CAPITALDESK_AUTHORIZATION_DURABILITY` is required configuration, bound into the plan digest:

- **`SYNCHRONOUS_REPLICA`** — the sealed plan payload, approval, allocation schedule and
  dispatch marker are committed to a replica in a distinct failure domain **before** the
  executor may mark. RPO for the authorization record set is zero within the declared failure
  domain.
- **`AT_RISK_SINGLE_NODE`** — permitted for local and testnet work. The owner accepts that a
  loss covering a sealed plan yields `RESTORE_ATTRIBUTION_UNRECOVERABLE`.

The class is in the digest because it changes what the owner is consenting to.

### 2. An authorization evidence bundle outside the database

Before marking, a content-addressed bundle containing the canonical sealed payload, the
approval record, the allocation schedule, the algorithm and fee policy versions and the
dispatch marker identity is appended to an evidence store outside the database's failure
domain. FIFO is recoverable from this bundle when the database is not.

### 3. When attribution is genuinely lost, say so

If neither the database nor an authentic bundle survives for a plan with fills, the
reconciler records `RESTORE_ATTRIBUTION_UNRECOVERABLE` and stops. It does not guess a FIFO
order, split pro rata, or assign to HOUSE. Resolution is an explicit, audited owner decision
recorded as such — an ownership judgement, not a computation.

### 4. Restore posture

A restored deployment starts HALTED and RECONCILING, never drains a restored outbox, and
reconciles dispatch history against the venue before resuming. A restored copy starting while
the original still runs must fail the governance lease check rather than both governing.

## Consequences

Synchronous replication costs latency on the sealing path. That is the price of promising
recoverable attribution; the alternative is to promise less, which is why the weaker class
exists and is named honestly rather than hidden as a default.

## Tests

Backup predates plan creation; journal lost while the exchange fill exists (reaching
`RESTORE_ATTRIBUTION_UNRECOVERABLE`, never a guessed split); recovery from the evidence
bundle retaining the original FIFO exactly; the original deployment still running while a
restored copy starts; a missing algorithm version; a corrupted bundle. Extends T-035, T-051.
