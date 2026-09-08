# Prompt 23 — Intent queue, conflict resolution and exact approval screens

**Dependencies:** Prompt 09, Prompt 10, Prompt 11, Prompt 17, Prompt 21  
**Requirements:** FR-006–FR-013, FR-020  
**Owns:** web intents, plan builder and approval routes

> **Amended by ADR-0003, ADR-0006 and ADR-0008.** Show `submissionDeadlineAt` as a fact
> distinct from plan expiry and session expiry. Show a late opposing intent invalidating an
> unmarked plan, and — after the marker — an in-flight order and a queued opposing intent as
> two facts, without implying either cancels the other.

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 23 only.

Objective: Make coordination and partial-fill allocation understandable before the user commits.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Build live intent queue with revisions, source age, target/owned/delta, mandate disposition and deep links.
2. Display opposing proposals as an explicit conflict with authorized defer/revise options. Do not visually imply automatic netting or hidden internal transfer.
3. Render exact plan participants, immutable FIFO sequence, quote/base/fee reservations, limit/tick/lot rounding, residual dust and concentration impact.
4. Explain which participant receives first fills with a deterministic preview using sample fill amounts labelled hypothetical. Actual result remains unknown until execution.
5. Implement owner approval/decline with the exact digest, expiry and native-confirmation state; changed plans require fresh review. Prevent double-click/reconnect duplicates.
6. Provide complete stale-source, insufficient-claim, unsupported-symbol and fee-source error states with actionable explanations.

Required verification:
T-004–T-010, T-013, T-019, T-039, T-045–T-049; keyboard approval, stale tab, changed policy, approval expiry and conflicting concurrent owner action.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
What the owner approves is exactly the immutable payload the executor can send.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/23.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

