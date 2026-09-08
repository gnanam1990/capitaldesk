# Prompt 10 — Plan sealing and transactional capital reservation

**Dependencies:** Prompt 04, Prompt 06, Prompt 09  
**Requirements:** FR-005, FR-010–FR-013  
**Owns:** seal/reservation services and integrity constraints

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 10 only.

Objective: Reserve every required asset exactly once before approval.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Create immutable plan versions and child allocation schedules in the same SERIALIZABLE transaction as claim reservation and outbox records.
2. Lock the pool/account and claims in stable order. Revalidate original preview revisions and venue free capacity; a stale preview cannot silently win.
3. Reserve quantity, verified cumulative quote-debit/fee/rounding caps and supported fee source under TDD equations. Freeze per-strategy asset/commission bounds in the approval payload. No admission based on pending sale proceeds or duplicate counting of venue locked units; include T-055–T-058.
4. Pre-dispatch reservation expiry/decline/invalidation must atomically make the plan undispatchable and release its claims. After dispatch marker, TTL never releases them.
5. Enforce one sealed/in-flight plan per pool and no reuse of sealed intent across plans.
6. Return exact held/free values and stable contention reasons to the UI; no optimistic green success before commit.

Required verification:
T-012–T-013, T-018–T-021, T-023–T-025; two independent database connections race a 600+600 reservation against 1000 available.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Aggregate committed reservations cannot exceed either internal ownership or verified executable capacity under contention.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/10.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
