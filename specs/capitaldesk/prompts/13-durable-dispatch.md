# Prompt 13 — Dispatch marker, unique child identity and crash semantics

**Dependencies:** Prompt 04, Prompt 10, Prompt 11, Prompt 12  
**Requirements:** FR-007, FR-013–FR-015  
**Owns:** executor dispatch lifecycle and transactional claim logic

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 13 only.

Objective: Submit each governed child at most once automatically through its durable journal.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Atomically perform final eligibility check, commit the permanent dispatch marker/token/client ID, then invoke the adapter exactly once.
2. Ensure queue, SDK, HTTP and CLI layers never retry placement implicitly. Retry DB serialization only before marker/effect.
3. Handle acknowledgement, decisive rejection and ambiguous timeout separately. Persist raw safe observations with the dispatch identity.
4. After any crash following marker commit, enter UNKNOWN and enqueue reads only. A lease timeout cannot grant another send; fencing at our DB does not fence the exchange.
5. Consume late response without duplicate state effects. Owner halt after marker cannot undo the order and must preserve its reservations.
6. Support dry-run/local transport instrumentation for tests; production paths cannot swap to synthetic order results.

Required verification:
T-024–T-030, T-039–T-040; kill before marker, after marker/before bytes, after venue acceptance, before ACK commit and across lease turnover.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Each marker has at most one automatic send, and ambiguity never becomes automatic resend or freed capital.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/13.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

