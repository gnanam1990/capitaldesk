# Prompt 27 — Reproducible CI, deployment, migration and disaster recovery

**Dependencies:** Prompt 25, Prompt 26  
**Requirements:** FR-022–FR-024  
**Owns:** CI, containers, release manifests, migration and restore scripts

> **Amended by [ADR-0005](../../../docs/adr/0005-authorization-durability.md).** Declare the
> authorization durability class and prove it. Restore rehearsals must include a backup
> predating a sealed plan, recovery from the authorization evidence bundle retaining the
> original FIFO, and the case where neither survives and attribution is unrecoverable.

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 27 only.

Objective: Prepare a real operable service and its repeatable recovery path.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Build CI stages for types/lint/architecture, pure/property, real Postgres concurrency, crash, API/SDK, UI/accessibility, credential boundaries and targeted mutation tests.
2. Create non-root service containers with separate mounts/users/permissions; executor-only credentials and allowlisted egress. Declare exact trust boundaries.
3. Separate local fixture, real testnet and production-read-only configs. Production write activation cannot follow from a default environment value.
4. Rehearse migrations and backup restoration with unresolved attempts. Restored services boot HALTED/RECONCILING and cannot dispatch old outbox work.
5. Create source/lockfile/OpenAPI/migration/image/evidence manifest binding with immutable versions and documented rollback constraints.
6. Prepare deployment/run/backup/rotate commands. Do not publish, deploy, spend, submit or modify an external account solely because this prompt creates scripts.

Required verification:
T-024–T-028, T-032–T-035, T-043–T-044, T-048–T-054; clean checkout, actual restore, rolling migration and different environment refusal.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
A clean installation and restore preserve financial uncertainty and produce a version-bound readiness report.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/27.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

