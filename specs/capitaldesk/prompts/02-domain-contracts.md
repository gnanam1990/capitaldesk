# Prompt 02 — Money types, canonical contracts and reducers

**Dependencies:** Prompt 01  
**Requirements:** FR-004, FR-006, FR-007, FR-013  
**Owns:** packages/contracts, packages/domain pure types/reducers

> **Amended by ADR-0001, ADR-0003, ADR-0004, ADR-0006 and ADR-0010.** The state map in task 2
> gains `SEND_ATTEMPTED`, `NOT_SENT_PROVEN` and `IRRECOVERABLE_UNCERTAINTY` on the dispatch
> attempt, and `EXPIRED_IN_MATCH`, `PENDING_CANCEL` and `UNSUPPORTED_OBSERVATION` on venue
> observations. The plan digest in task 3 additionally binds the timing envelope
> (`submissionDeadlineAt`, `signedRequestValidityMs`, `clockSkewBudgetMs`),
> `cohortClosedAtSequence`, `feePolicyVersion` and `authorizationDurability`. Task 3's
> "reject unknown decision-changing fields" must be enforced at runtime over nested objects,
> not only stated: an unknown key that leaves the digest unchanged defeats INV-08.

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 02 only.

Objective: Freeze exact financial units and state meanings before persistence and UI.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement atom-string wire types with explicit asset and scale, bigint arithmetic, overflow limits and canonical serialization. Price, raw quantity, fee and marked portfolio value are distinct types.
2. Define identities including workspace/pool/account/environment/epoch and order/fill symbol scope. Map all separate intent, plan, dispatch, venue, accounting and pool states from TDD.
3. Define absolute target revisions, policy schema, exact child LIMIT IOC schema, FIFO allocation schema and immutable plan hashing fields. Reject unknown decision-changing fields.
4. Implement pure state transitions that return events, with no database/network dependencies. Terminal order observations do not imply complete accounting.
5. Define stable reason codes for conflict, insufficient claim, expired approval, unsupported capability, fee uncertainty, source staleness and external drift.
6. Write independent golden values and model transition tables before reducer implementation. Separate gross child completion from net target satisfaction; model full BUY with base fee leaving a residual and SELL admission satisfying gross quantity plus worst base fee <= owned minus target. Define immutable per-asset debit/commission caps and the allocation-algorithm version in the plan digest.

Required verification:
T-001–T-010, T-019, T-031; property round-trips, deterministic hashes, every bound-field mutation, cross-unit arithmetic rejection.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
No decision/money path uses JavaScript number or a boolean to collapse distinct uncertainty states.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/02.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
