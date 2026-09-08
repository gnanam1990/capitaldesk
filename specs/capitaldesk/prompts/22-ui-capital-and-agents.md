# Prompt 22 — Account setup, capital ownership and strategy views

**Dependencies:** Prompt 06, Prompt 07, Prompt 17, Prompt 21  
**Requirements:** FR-001–FR-007, FR-020  
**Owns:** web account/pool, agent and capital routes

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 22 only.

Objective: Let an owner see whose units are available, held or unresolved.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Build account mode discovery and baseline setup with real identity, source coverage and unresolved-order handling. Funding remains an explicit external action, not a fake onboarding step.
2. Show HOUSE and strategy per-asset AVAILABLE/RESERVED/QUARANTINED claims, actual exchange total/free/locked and independent reconciliation state.
3. Implement internal allocation review flow and strategy/proposal credential management through authorized services. Clarify no exchange transfer occurs when assigning a budget.
4. Show selected symbol, target revisions, committed quantities and owner mandates on strategy detail.
5. Add source-lag and external-drift states with inspectable evidence. Mark-to-market summaries remain separate from spendable claim amounts.
6. Do not create broad P&L claims from a partial baseline or combine values from broker and Agentic accounts.

Required verification:
T-011–T-013, T-020, T-038, T-041–T-042, T-045–T-049; empty HOUSE, fee-only asset, long numbers and revoked proposal token.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
An owner can reconcile every displayed capital total to exact per-asset claims and source context.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/22.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

