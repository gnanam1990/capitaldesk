# Prompt 17 — Complete HTTP API and executable OpenAPI

**Dependencies:** Prompt 07, Prompt 09, Prompt 10, Prompt 11, Prompt 15, Prompt 16  
**Requirements:** FR-001–FR-022  
**Owns:** apps/api routes, runtime schemas and generated OpenAPI

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 17 only.

Objective: Expose the complete product through one validated authorized contract.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement all TDD routes using existing domain/services, not alternate route-local financial logic. Confirm exact endpoint naming through generated schemas.
2. Require idempotency keys and stable stored-response replay on writes; enforce scope, body limits, cursor pagination and object permissions.
3. Return atom strings with unit/scale, plan and accounting states, source age, evidence completeness, safe reason code and correlation ID.
4. Expose read-only economics recheck as an idempotent job; never public placeOrder/sign/arbitrary RPC. No agent-facing approval/claim-admin shortcuts.
5. Generate OpenAPI from executable runtime schemas and include realistic documented UNKNOWN, CONFLICT, PARTIAL, degraded and denied examples clearly marked examples.
6. Preserve immutable approval and plan digests across HTTP clients. Separate health live from operational readiness.

Required verification:
T-001–T-010, T-036–T-044, T-050; schema drift, concurrent request replay, forged IDs, pagination under new events and extra fields.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
API, schemas and generated contract agree; no alternate endpoint weakens domain invariants.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/17.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

