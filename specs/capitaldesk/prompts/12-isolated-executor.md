# Prompt 12 — Isolated credential holder and narrow execution adapter

**Dependencies:** Prompt 00, Prompt 03, Prompt 05, Prompt 11  
**Requirements:** FR-001, FR-003, FR-013, FR-021  
**Owns:** apps/executor isolation, packages/binance write adapter

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 12 only.

Objective: Make the coordinator's enforcement claim true at the credential boundary.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Implement internal executor authentication and a method that accepts only a sealed child reference/digest; retrieve typed immutable payload from the authoritative database.
2. Mount only the selected environment/account credential in the executor identity. Proposal agents, web, API and general worker cannot read or invoke its generic authority.
3. Use verified SDK/CLI calls without shell interpolation or automatic write retries. Ban arbitrary method, URL, account, command and profile selection by callers.
4. Enforce host/IP/egress and process/mount boundaries; add actual deployment topology proof rather than assuming separate processes under one OS user are isolated.
5. Implement approved-host MCP mode only when exact current integration gate passes; otherwise keep it explicitly observation/proposal only.
6. Record secret-free capability fingerprints and account identity; never log signed URLs, OAuth tokens or raw CLI profile contents.

Required verification:
T-010, T-036–T-040, T-044; adversarial agent attempts direct HTTP/CLI/IPC, forged digest/account and credential reads.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
An untrusted proposal agent cannot obtain a usable trading credential or cause an unapproved financial call.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/12.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

