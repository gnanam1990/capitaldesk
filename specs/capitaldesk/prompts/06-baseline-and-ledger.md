# Prompt 06 — Account baseline and strategy claim ledger

**Dependencies:** Prompt 04, Prompt 05  
**Requirements:** FR-002, FR-004, FR-005, FR-022  
**Owns:** packages/ledger postings/projections, baseline and allocation service

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 06 only.

Objective: Give every governed asset unit exactly one explicit owner claim.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement per-asset double-entry ASSET_CONTROL and CLAIM accounts. Available, reserved and quarantined claim partitions are not new assets; HOUSE is explicit unassigned ownership.
2. Bootstrap only with stable account/epoch identity, its exclusive registry lease and supported reconciled observations; unmatched pre-existing orders keep execution blocked. Different keys/aliases cannot create duplicate ownership. Test T-056.
3. Record opening balances against HOUSE claims. Owner internal allocations move AVAILABLE claims between HOUSE/strategy according to explicit authorization and cannot look like exchange transfers.
4. Support base/quote and explicitly configured fee assets; no cross-asset balancing equation or mark-to-market funding.
5. Build reconstruction from immutable postings and per-asset sum verification. Reject direct claim_balance writes outside transactional ledger operations.
6. Expose missing historical cost basis and incomplete evidence. Do not advertise tax/P&L completeness merely because current balances match.

Required verification:
T-011–T-014, T-020, T-023, T-032, T-042; opening 1000 USDT to 500/500 allocation and impossible double assignment.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Independent recalculation matches all ledger projections and original account facts without balancing plugs.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/06.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
