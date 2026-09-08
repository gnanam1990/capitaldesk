# Prompt 07 — Strategy lifecycle and versioned absolute targets

**Dependencies:** Prompt 03, Prompt 06  
**Requirements:** FR-003, FR-006, FR-007, FR-021  
**Owns:** intent/strategy services and proposal routes

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 07 only.

Objective: Make repeated agent targets safe, scoped and inspectable.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement strategy create/archive, proposal token bindings, target acceptance and stable revision ordering per strategy/symbol.
2. Validate asset units, selected symbol, limit bounds, target max/debit, expiry and policy version. A target is absolute owned net base, not an additional BUY.
3. Use durable request idempotency and revision-content conflict checks. Late/lower revisions cannot replace the current target.
4. Permit supersession only before sealing. Revisions tied to a sealed/dispatched plan require explicit invalidation or completed reconciliation first.
5. Persist accepted sequence for FIFO ordering; UI order and network arrival after acceptance cannot change it.
6. Compute target progress from eligible claims and commitments; preserve unmet target after partial IOC without automatic repeat orders.

Required verification:
T-001–T-005, T-009, T-010, T-020; replay same target 100 times, simultaneous revisions, supersession during planner read.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Repeated target evaluation never creates duplicate inventory demand or a second commitment.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/07.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

