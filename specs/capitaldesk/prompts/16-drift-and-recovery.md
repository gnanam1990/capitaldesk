# Prompt 16 — Pool drift, quarantine, halt and evidenced recovery

**Dependencies:** Prompt 06, Prompt 08, Prompt 15  
**Requirements:** FR-002, FR-018, FR-019, FR-022  
**Owns:** pool reconciler, incidents and owner recovery actions

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 16 only.

Objective: Contain out-of-band account changes while retaining a truthful ledger.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Reconcile control ledger against bracketed snapshots/cursors. Record confidence and pending history; equal balances are not automatic proof of complete history.
2. Detect external orders/transfers/fills, fee changes, reset epochs, scale changes and mismatched account identities; v1 quarantines the entire pool.
3. Separate incident acknowledgement from economic resolution. A human cannot mark unknown execution absent or invent a balancing adjustment.
4. Allow evidence-backed correction proposals with actor/reason/source and nonnegative claim constraints. Do not edit original entries.
5. Rebaseline only after outstanding economic uncertainty resolves; create a new epoch while preserving prior journal. Testnet reset is not permission to delete old proof.
6. Implement halt/resume APIs and runbooks. Halt blocks future marked dispatch; resume requires fresh complete reconciliation and no active blockers.

Required verification:
T-017–T-018, T-032–T-035, T-041–T-044; manual external fill, unknown baseline order, same order ID after reset and false human resolution.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
External reality cannot silently overwrite strategy ownership or cause an unresolved order to be resent.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/16.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

