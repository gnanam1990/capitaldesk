# Prompt 09 — Same-side aggregation and explicit conflict resolution

**Dependencies:** Prompt 05, Prompt 07, Prompt 08  
**Requirements:** FR-007–FR-012  
**Owns:** packages/planner preview/compatibility algorithm

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 09 only.

Objective: Turn valid targets into a transparent exact order plan.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement the TDD planner in pure deterministic code using a frozen eligible ledger/policy/market input set.
2. Compute net strategy deltas. Opposite active directions produce a conflict and zero order; owner can explicitly defer or revise. No virtual fills/internal crossings.
3. Coalesce compatible same-symbol/same-side intents only. BUY uses strictest maximum price rounded down; SELL uses strictest minimum rounded up.
4. Round aggregate quantity down to lot step without broadening any strategy's authorization. First constrain each SELL gross quantity plus supported worst base commission <= owned minus target; BUY gross cannot exceed its net target delta. Recompute fixed admitted FIFO, residuals and cumulative debit/fee caps. Do not automatically chase fee-created residuals. Cover T-057–T-058.
5. Validate exchange filters and budgets before proposing a child. v1 one plan, one LIMIT IOC child, one in-flight pool; second symbol is refused.
6. Preview is read-only regarding capital. Output exact participants, digest inputs, constraints, unresolved reasons and why a target remains unmet.

Required verification:
T-001, T-004–T-005, T-009–T-010, T-019–T-020; randomized ordering, crossing price constraints, min-notional and quantities just below lot step.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Planner never manufactures economic transactions and produces the same canonical result from identical inputs.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/09.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
