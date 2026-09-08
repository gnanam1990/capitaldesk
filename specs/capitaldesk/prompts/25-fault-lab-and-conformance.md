# Prompt 25 — Failure laboratory and invariant evidence runner

**Dependencies:** Prompt 13, Prompt 14, Prompt 15, Prompt 16, Prompt 20, Prompt 24  
**Requirements:** FR-014–FR-019, FR-023  
**Owns:** packages/fault-lab, scenario CLI/UI, proof artifacts

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 25 only.

Objective: Prove the product's central financial claims through actual failure boundaries.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement isolated deterministic domain/Postgres scenarios plus a separate real testnet transport proxy. Clearly label deterministic fixture versus venue-observed evidence.
2. Scenario set: simultaneous oversubscription, opposite intents, partial FIFO with quote/base/third-asset fee, response loss, crash after marker, stale approval, duplicate fills, external drift and testnet reset.
3. Proxy forwards an actual testnet request and can drop its real response; it must not fabricate fills, rewrite account results or route to production.
4. Count downstream placement attempts and reconcile exact order/fills independently. Do not force partial testnet liquidity to match a scripted quantity; report actual fill behavior.
5. Build reproducible run manifests with commit, schema, mode/account/epoch, seed, fault boundary, actual IDs, logs and invariant outcomes.
6. Wire a compact UI scenario matrix/progress timeline into normal product services. Production build must exclude fault control endpoints.

Required verification:
T-013–T-035, T-045–T-058; targeted mutants for fee drop, reversed FIFO, per-fill rounding overdraw, duplicate account bootstrap, wrong SELL fee sign, premature release, approval mismatch and UNKNOWN resend must fail.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
The video can use the same working product path as a user, with truthful fixture versus real testnet evidence.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/25.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```
