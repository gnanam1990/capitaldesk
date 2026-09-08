# Prompt 05 — Verified Binance market/account/order readers

**Dependencies:** Prompt 00, Prompt 02, Prompt 04  
**Requirements:** FR-001, FR-002, FR-011, FR-018  
**Owns:** packages/binance read-only interfaces, worker ingest adapters

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 05 only.

Objective: Provide source-grounded account and market facts without any write capability.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement narrow typed readers for the selected account/symbol, exchange filters, public market context, actual account balances, order-by-exact-ID and complete trade/commission history.
2. Normalize raw observations with source timestamp, request interval, stable authenticated account identity, response digest and completeness cursor. Record actual scale, fee-asset semantics and cumulative debit/rounding bounds across partial fills. Unknown or unproven rounding semantics must not become an invented fee ceiling.
3. Respect API rate weights, Retry-After, bounded request ranges and explicit schema errors. Do not silently return empty lists on source failure.
4. Capture account before/after snapshots around known-order catch-up. Expose cut confidence; repeated equal balances alone cannot prove missing history complete.
5. Detect wrong account, unexpected environment, reset epoch, unknown orders, metadata/filter changes and delayed records.
6. Read-only reader process has no trading key. SDK/CLI adapters use verified current calls from Prompt 00, not guessed flags or MCP method names.

Required verification:
T-019, T-021–T-022, T-029, T-031–T-034, T-038, T-041–T-043. Real public read and authorized read-only account evidence where configured.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Every reader result states provenance and coverage; write methods cannot be reached through a generic passthrough.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/05.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
