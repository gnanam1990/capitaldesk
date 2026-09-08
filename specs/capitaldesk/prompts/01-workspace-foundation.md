# Prompt 01 — Monorepo foundation and environment contracts

**Dependencies:** Prompt 00  
**Requirements:** FR-021, FR-024  
**Owns:** workspace manifests, apps skeletons, packages/contracts, build/config tooling

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 01 only.

Objective: Create a reproducible application foundation with explicit environment isolation.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Follow the proposed TDD stack only after auditing reusable code. Pin supported mutually compatible Node/pnpm/TypeScript/Fastify/Next/PostgreSQL tooling; lock dependencies and record versions.
2. Create application/package boundaries from TDD. Add lint, typecheck, architectural dependency checks and clean builds. No demo success pages or financial implementation yet.
3. Define validated local/testnet/production-read-only configuration, exact account alias and baseline epoch. Secrets are references mounted only into executor; public config cannot include them.
4. Add process/readiness health and structured redacted correlation logging. Production write capability starts disabled; testnet routing never silently falls back to a live host.
5. Set PostgreSQL dev lifecycle and migration tooling. Normal commands must not destroy an existing database. Create environment examples containing placeholders only.
6. Record source of truth and specification path in repository instructions so future implementation sessions read this CapitalDesk pack rather than old OrderRescue guidance.

Required verification:
Clean install/typecheck/build; wrong/missing environment refused; web/API cannot import executor credential modules; redaction tests.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
A fresh checkout starts truthful health endpoints with DB and execution availability reported separately.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/01.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

