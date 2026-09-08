# Prompt 20 — CapitalDesk MCP tools and real proposal-agent integrations

**Dependencies:** Prompt 00, Prompt 12, Prompt 19  
**Requirements:** FR-003, FR-006, FR-008, FR-021, FR-023  
**Owns:** packages/agent-tools, two reference proposal agents and integration docs

Read [SESSION-HEADER.md](SESSION-HEADER.md) and the relevant [technical design](../TDD.md), [requirements](../PRD.md) and [test plan](../TEST-PLAN.md) before executing this prompt.

## Copy-paste prompt

```text
Apply the CapitalDesk shared session instructions. Work on module 20 only.

Objective: Demonstrate meaningful Agent OS usage while keeping decisions and credentials properly bounded.

Before editing, inspect the actual repository and completed dependency handoffs. State owned paths and missing contracts. Do not infer a dependency is complete because a specification exists.

Implementation tasks:
1. Expose CapitalDesk read/propose tools from TDD with strict scoped schemas. Mark these as our tools, not invented Binance methods.
2. Connect two reference agents to actual permitted market observations and their separate proposal identities. They may produce distinct targets and explanatory rationale; deterministic software handles money and mandates.
3. Make strategy behavior explicit and reproducible for the coordination demonstration; do not claim market alpha or let AI choose secret permissions.
4. Verify supported host/tool integration against Prompt 00. In broker-key testnet mode, disclose that the financial account is separate from Agentic OAuth.
5. Use injection tests against market metadata/news/tool text. Untrusted input cannot call approve, reallocate, sign or select a different endpoint/profile.
6. Show compatible proposal and opposite-intent paths through the actual API. No sample response may appear as a real Agent OS tool invocation.

Required verification:
T-001–T-005, T-009–T-010, T-036–T-040, T-045; prompt injection, forged strategy identity, replay revision and unsupported host path.
Write the independent failing cases before the consequential implementation. Record actual commands/results; distinguish deterministic tests, real PostgreSQL tests and actual venue evidence.

Acceptance gate:
Two genuinely separate proposal identities use the working coordinator, and neither can reach the execution credential.

Stop condition:
If required source capability, dependency contract, authority or invariant cannot be proven, stop only the affected path and report a concrete blocker. Continue independent in-scope work without replacing the blocked critical path with mocked success.

Handoff:
Update docs/handoffs/20.md using SESSION-HEADER's handoff format. Include exact changed files, tests, real-boundary evidence, limitations and next unblocked modules. Do not mark the full project complete from this module's local tests.
```

