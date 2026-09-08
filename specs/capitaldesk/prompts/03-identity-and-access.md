# Prompt 03 — Owner sessions and proposal-agent authority

**Dependencies:** Prompt 02  
**Requirements:** FR-001, FR-003, FR-021  
**Owns:** apps/api auth, packages/domain permission model, identity migrations

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 03 only.

Objective: Separate owner approval, operator recovery, viewer access and untrusted proposals.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement workspace membership and owner/operator/viewer roles plus strategy-scoped agent credentials. Store only hashed proposal credentials and show secrets once through secure onboarding.
2. Bind every object lookup to workspace, pool and strategy; use composite references. Reject cross-pool/account reads and writes even when UUIDs are valid.
3. Provide secure owner login through an established library/provider, explicit session expiry, CSRF protection for cookie mutations and revocation. Do not invent custom authentication cryptography.
4. Agent credentials can only submit/read authorized proposals and market/strategy state. They cannot seal, approve, reserve arbitrary assets, reallocate, admin or invoke broker routes.
5. Add key rotation/audit events and no-secret exports. Avoid localStorage for owner credentials. Distinguish revocation before dispatch from already in-flight orders.
6. Create authorization tests from the permission matrix, including token type confusion and forged owner IDs in agent input.

Required verification:
T-006, T-036–T-040, T-044; every privileged endpoint negative permission test and cross-tenant object access.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
No agent-controlled field selects its own owner, permission level or execution account.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/03.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

