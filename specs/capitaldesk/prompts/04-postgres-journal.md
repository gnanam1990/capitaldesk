# Prompt 04 — Transactional journal, outbox and permanent replay records

**Dependencies:** Prompt 02, Prompt 03  
**Requirements:** FR-010, FR-014, FR-022, FR-024  
**Owns:** packages/db core schema/repositories/migrations

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 04 only.

Objective: Make economic state durable and atomically replayable.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement TDD tables and scoped composite keys. Enforce one active governed pool per account/environment, one current baseline epoch and one in-flight plan per pool.
2. Build SERIALIZABLE transaction helpers with stable lock order. Retry serialization failures only before external effects; no repository method performs network calls.
3. Add append-only raw observations/ledger records, versioned rebuildable projections, transactional outbox and worker lease records.
4. Implement scoped idempotency response storage and permanent economic tombstones. Same body replays; changed body conflicts; expired response retention never permits a new economic action.
5. Protect numeric integrity, source uniqueness and append-only tables through database permissions/constraints. Economic records survive strategy archival.
6. Create migration/rollback rehearsal data containing reservations, UNKNOWN attempts and partial fills; no migration may clear them.

Required verification:
Implement and race-test the unique active governance lease for venue + environment + authenticated stable account identity across all pools/workspaces. Key rotation must not bootstrap duplicate assets; an unresolved old epoch cannot free its lease. Cover T-056 with independent database connections.
T-011–T-013, T-024, T-030–T-035, T-051; real PostgreSQL concurrent transactions, crash before/after commit, projection rebuild.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Database checks demonstrate no partial journal/outbox commit and no duplicate economic identity across concurrent requests.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/04.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
