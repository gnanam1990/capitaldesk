# Prompt 14 — Authoritative fills, FIFO attribution and exact fee accounting

**Dependencies:** Prompt 05, Prompt 06, Prompt 10, Prompt 13  
**Requirements:** FR-004, FR-012, FR-016, FR-017, FR-022  
**Owns:** packages/ledger fill reducer and allocation projection

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 14 only.

Objective: Turn actual execution into exact strategy ownership without synthetic fills.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Ingest deduplicated scoped fills from all supported sources. Preserve conflicts with the same identity instead of overwriting.
2. Order complete fill evidence by verified exchange ordering key and apply the preapproved FIFO schedule. Keep incomplete/out-of-order projections provisional and unspendable.
3. Freeze gross base FIFO and build the complete fill-by-strategy exact-rational cost/fee matrix. Implement TDD lower-bounded integer circulation: each cell floor/ceil, source row conservation, cumulative strategy bounds, fee subcaps and shared BUY quote-cost/commission cap. Use stable graph ordering and a pinned algorithm version. No per-fill largest-remainder finalization or cumulative-average price replacement. Incomplete projections remain provisional and unspendable.
4. Support quote/base and explicitly reserved third-asset fee policies; unsupported/over-budget fees preserve facts and quarantine before further activity.
5. Implement the 500/500 opening, .03 requested/.02 filled golden example independently, including all intermediate postings and residual reservations.
6. Implement both BUY and SELL posting equations, not a BUY-only fee helper. Record gross child completion separately from net target satisfaction. Preserve fee-created BUY residuals and fee-aware SELL residuals without automatic replanning.
7. Apply journal, allocation and claim projection atomically; source facts remain recoverable if transaction aborts.

Required verification:
T-012, T-014–T-023, T-030–T-034, T-055, T-057–T-058; multiple fill prices, split crossing FIFO, base/BNB fee and shuffled delivery. Add the 3,3,8,3,3 two-fill counterexample, combined quote-cost/commission cap, infeasible matrix and exact per-column floor/ceil assertions. Compare generated small matrices against independent exhaustive enumeration, not the production solver. Record constrained policy failures honestly; never fund them from another claim.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
For each source fill, allocated base/quote/fee sums equal it exactly; strategy asset/commission caps hold; both side posting equations are correct; final cells replay deterministically; no incomplete credit becomes spendable.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/14.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
