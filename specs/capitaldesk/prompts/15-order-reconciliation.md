# Prompt 15 — Order terminality, evidence completeness and reservation release

**Dependencies:** Prompt 05, Prompt 13, Prompt 14  
**Requirements:** FR-014–FR-019  
**Owns:** worker order reconciler and financial completion service

> **Amended by ADR-0001, ADR-0002 and ADR-0004.** Releasing an unused reservation requires a
> terminal venue status **and** reconciled accounting **and** COMPLETE coverage; any one alone
> is insufficient. Implement `NOT_SENT_PROVEN` and `IRRECOVERABLE_UNCERTAINTY` as the
> resolutions of an unresolved dispatch. An unknown venue status quarantines rather than
> being mapped.

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 15 only.

Objective: Resolve unknown and partial execution using exact venue evidence.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Query exact scoped client/order identity; retrieve all relevant order trades and commission pages with documented coverage conditions.
2. Keep transport state, venue terminality and accounting status separate. EXPIRED/CANCELED can include fills; a missing page blocks financial completion.
3. Merge late WebSocket/REST responses idempotently and detect contradictory cumulative totals or fee data.
4. Treat one or repeated unproven NOT_FOUND as unresolved, not safe absence. v1 has no automatic absence-based resend.
5. Acquire an eligible account observation boundary before finality; atomically finalize allocations and release only truly unused reservation.
6. Persist remaining target/residual dust without creating a new order; later execution needs an explicit new valid plan and approval.
7. Make all recheck actions read-only economically; UI retries must never conceal another placement.

Required verification:
Require terminal plus complete source rows before final controlled cost/fee allocation. Verify that a fully filled and reconciled child may have an unmet net target (T-055, T-057–T-058); do not equate venue FILLED with target SATISFIED.
T-021–T-022, T-026–T-035, T-043, T-047; late fill after expiry, missing final page, exact fill totals mismatch and account lag.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
No terminal label alone can release liabilities, and complete recovery has independently inspectable order/fill evidence.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/15.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
