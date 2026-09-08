# Prompt 00 — Repository and Binance capability gate

**Dependencies:** none; first module  
**Requirements:** FR-001, FR-003, FR-014, FR-023  
**Owns:** docs/integration-gate.md, docs/capabilities/, non-economic probe scripts

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 00 only.

Objective: Prove which real account and execution route can support CapitalDesk before enabling financial code.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Inspect the chosen checkout, AGENTS.md, git status, manifests, existing adapters and licence. Record exact baseline SHA and preserve unrelated changes. If no checkout exists, document a proposed new monorepo; do not modify Corporate Action Guard.
2. Read SOURCES.md and current official Binance documentation. Record stable authenticated account/environment identity (not credential alias), selected Spot symbol, LIMIT IOC support, exact place/query/fill interfaces, pagination, cumulative debit/fee/venue-rounding bounds across partial fills, client-ID constraints, rate limits, user confirmation and reset behavior. Unsupported debit bounds block execution of that fee policy.
3. Use already configured authorized read-only access to inspect authenticated schemas when available. Separate broker-key testnet from approved-host Agentic mode; do not infer shared account access. Unavailable credentials produce BLOCKED, not a fabricated capability.
4. Verify actual CLI/SDK flags and hidden retries. Capture redacted schemas and response samples; never record keys/tokens/cookies. Explain the precise response-loss boundary and durable identifier available across it.
5. Create two independent verdicts: technical execution mode PASS/PARTIAL/BLOCKED and competition eligibility VERIFIED/UNVERIFIED. Date the event facts. Do not log in, grant scopes, place orders or submit a form as a side effect of this module.
6. Define safe fallbacks: continue pure domain work with typed interfaces; keep economic E2E blocked if execution cannot be proven. Read-only plans cannot be labelled an executed product.

Required verification:
Capability probe refuses unknown account, wrong environment, absent IOC, missing exact order query, unsupported fee source and a retrying write SDK. No trade is needed for this probe.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Implementation assumptions are pinned in evidence, and unavailable capabilities are explicit. No write adapter is enabled without its own passing gate.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/00.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
