# Prompt 24 — Orders, incidents, ledger and independently verifiable exports

**Dependencies:** Prompt 14, Prompt 15, Prompt 16, Prompt 18, Prompt 21  
**Requirements:** FR-014–FR-022  
**Owns:** web execution/recovery/ledger/export routes

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 24 only.

Objective: Make uncertainty, held capital and recovery clear without technical narration.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Render transport, venue-order and accounting states separately with actual gross fills, net strategy ownership, fees and remaining target.
2. Show UNKNOWN incident timeline: last authoritative fact, source awaited, held reservation, last query and permissible next read action.
3. Provide read-only recheck, source detail, halt and evidence-based owner resolution flows; never label order placement as a generic Retry.
4. Build per-asset ledger journal and signed/digested manifest exports with provenance, coverage and verifier result. Digest integrity is not proof that Binance signed the content.
5. Preserve history on strategy archive, account reset or reconnect. Show old epoch evidence as old, not current funds.
6. Add accessible SSE reconnect/status behavior and prevent rapid updates from stealing focus or rearranging an approval view.

Required verification:
T-017–T-018, T-021–T-022, T-025–T-035, T-041–T-050; unresolved export, late fill, fee mismatch, offline and denied recovery.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
A fresh operator can identify exactly what is known, held, missing and safe to do next.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/24.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

