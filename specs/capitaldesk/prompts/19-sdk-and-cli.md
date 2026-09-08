# Prompt 19 — Integrator SDK, operator CLI and evidence verifier

**Dependencies:** Prompt 17, Prompt 18  
**Requirements:** FR-021, FR-022, FR-024  
**Owns:** packages/sdk, operator CLI, integration examples

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 19 only.

Objective: Give operators and developers safe typed access to the same workflows.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Generate base SDK from OpenAPI; add helpers for proposal revisions, preview, status watch, ledger reads and independent evidence verification.
2. Preserve outcome unions, atom strings and account/epoch scope. Do not retry economic writes automatically or convert UNKNOWN to failure.
3. Implement CLI subcommands for doctor, pools, allocations, intents, preview, approve, reconcile, incidents and export. Privileged calls require existing owner authority, explicit target and idempotency.
4. Never pass private keys in CLI arguments; use existing secure execution configuration only. Proposal-only commands cannot load the executor profile.
5. Support stable machine JSON, useful nonzero exit codes and human-readable scope/fee/FIFO review. Approval from CLI must show and bind exact plan digest.
6. Provide working integration examples and a verifier that recalculates allocation/fee sums from exported manifests.

Required verification:
T-002, T-006, T-010, T-028, T-036–T-040, T-044, T-050; generated client compatibility and malicious metadata output.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
All clients preserve the same authority and uncertainty semantics as the core API.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/19.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

