# Prompt 11 — Exact plan approval, expiry and revocation

**Dependencies:** Prompt 03, Prompt 08, Prompt 10  
**Requirements:** FR-009, FR-013, FR-014  
**Owns:** approval API/service, immutable approval evidence

> **Amended by ADR-0003, ADR-0006 and ADR-0008.** The approval binds an absolute
> `submissionDeadlineAt` alongside its expiry. Implement the lifecycle actions with their
> actor allowlists and their marked/unmarked plan effects. A late opposing intent invalidates
> an unmarked plan and never a marked one.

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 11 only.

Objective: Bind owner consent to the exact executable economic payload.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Require owner authentication, CSRF/session validity and exact sealed plan hash. Persist actor, intent revisions, allocation order and algorithm version, per-strategy debit/commission caps, limits, fee policy, epoch and expiry. Every bound-field mutation must invalidate the approval.
2. Make duplicate approvals/rejections durably idempotent and reject approval for a changed plan.
3. Design last-moment eligibility checks separately from approval. A compatible newer source read can refresh evidence but cannot alter approved economic fields.
4. Track local approval and native Binance MCP confirmation independently. Missing native confirmation must block that execution mode.
5. Implement owner halt/revocation semantics for unmarked dispatch; in-flight orders remain explicitly unresolved until exchange evidence.
6. Provide API data for comprehensible approval screens, including partial-fill FIFO consequence and all fee assets.

Required verification:
T-006–T-008, T-025, T-039–T-040, T-047; owner session expiry, changed allocation, updated mandate and plan at exact expiration.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
No local click or stale approval authorizes a materially different venue action.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/11.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
