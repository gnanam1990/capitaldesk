# Prompt 18 — Durable workers, SSE updates and signed webhooks

**Dependencies:** Prompt 04, Prompt 15, Prompt 16, Prompt 17  
**Requirements:** FR-014, FR-018, FR-021, FR-022, FR-024  
**Owns:** worker runtime, durable notifications and SSE/webhook delivery

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 18 only.

Objective: Keep users and integrations informed through restarts without duplicating economic work.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Build separate ingest/reconcile/export/webhook job types with leases, bounded backoff and dead-letter inspection. Dispatch markers remain non-retryable economic authority.
2. Publish post-commit domain events via durable SSE with cursor/Last-Event-ID, tenant scope and snapshot catch-up.
3. Implement signed webhook event envelopes with delivery ID, timestamp tolerance, exact body signature, secret rotation and replayable delivery journal.
4. Validate destinations against SSRF/DNS/internal-network rules; no untrusted arbitrary fetch from an agent payload.
5. Prioritize unresolved order reconciliation within rate budgets; backfill must not starve live recovery. Graceful shutdown preserves leases/checkpoints.
6. Expose job age, pending event count and source lag truthfully. Retry a webhook only, never its linked economic action.

Required verification:
T-022, T-025–T-027, T-034–T-035, T-043–T-044, T-049; duplicate/out-of-order notifications, replay, forged signature and disconnect/resume.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Notification delivery is at-least-once and deduplicable; it cannot cause a second financial effect.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/18.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

