# Prompt 26 — Operational telemetry and adversarial security hardening

**Dependencies:** Prompt 18, Prompt 20, Prompt 24, Prompt 25  
**Requirements:** FR-003, FR-018–FR-024  
**Owns:** observability, threat model, security suites and incident runbooks

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 26 only.

Objective: Detect silent failures and prove that integration authority remains contained.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Instrument unknown age, last complete account cut, unmatched fills, fee discrepancies, active reservations, dispatch markers, queue lag and source health; define bounded metric cardinality.
2. Create alerts/runbooks with read-only diagnosis first. Distinguish internal bug, source degradation, account drift and user policy denial.
3. Threat-model malicious agents, compromised adapters, forged approvals, credential leaks, SSRF, SQL/HTML/CSV injection, dependency changes and restored stale dispatch queues.
4. Run actual credential/egress isolation tests using the deployment topology, not just mocked permission return values.
5. Add CSP, secure cookies, CSRF, machine-key scope, export authorization, rate limits, body/decimal overflow bounds and webhook destination protection.
6. Use independent adversarial review evidence to fix demonstrated issues. Do not claim an external audit or official certification.

Required verification:
T-006–T-010, T-036–T-044, T-048–T-052; redaction canaries, broker bypass attempts, exploit repros, alert correctness and production fault refusal.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
No unresolved high-impact authority, duplicate-dispatch, asset-integrity or sensitive-data leak in the intended release scope.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/26.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

