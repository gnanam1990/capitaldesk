# Prompt 29 — Final specification-to-code adversarial acceptance review

**Dependencies:** Prompt 28  
**Requirements:** FR-001–FR-024  
**Owns:** local audit report; application source is read-only in this module

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 29 only.

This final review is read-only for application source. Write the local audit/handoff report and run safe diagnostic tests. Route any required fix back to its owning implementation module, then repeat this review at the new head.

Objective: Challenge the complete release as a reviewer who does not trust prior success reports.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Trace every PRD requirement to source, test and real-boundary proof. Inspect current exact git head and compare it to captured manifests.
2. Reproduce high-impact cases: same-wallet oversubscription, stale approval, post-marker restart, order-ID reuse, fee-asset mismatch, late partial fill, external drift and stale backup replay.
3. Inspect complete economic call graph and SDK/queue retry configuration. Search for bypass routes, generic execution, swallowed errors, placeholder success and fixture imports reachable in production.
4. Independently verify per-asset BUY/SELL postings, immutable base FIFO, controlled batch cost/fee rounding, individual debit caps, reserve release and stable account/epoch identities from exported evidence. Reproduce T-055–T-058 rather than accepting design prose as proof.
5. Review UI as a fresh owner at required sizes with keyboard and degraded dependencies; verify actual target completion/residual reporting.
6. Record proven findings locally with file/line/reproduction/impact, distinguishing blockers from enhancements. Identify the module responsible for each required fix. After that implementation module fixes it, rerun affected tests and refresh changed proof before reviewing again; do not sign off stale artifacts.

Required verification:
All mandatory TEST-PLAN cases at the final head, with targeted reruns justified by changes; no new unsupported safety claims.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Release readiness is a concrete evidence-backed decision. No approval, publish, merge, submission or mainnet trade is performed by this review prompt.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/29.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
