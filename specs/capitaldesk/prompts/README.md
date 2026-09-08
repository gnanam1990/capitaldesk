# implementation prompt pack — CapitalDesk

30 bounded module prompts, plus a shared session header. These are instructions for future implementation, not evidence of completed modules.

## How to use

1. Choose the actual implementation checkout during Prompt 00. Inspect existing files, instructions, changes and licences before any reuse.
2. Place the full CapitalDesk specification folder at `specs/capitaldesk/`, preserving relative paths; alternatively pass its absolute location.
3. Start each session with [SESSION-HEADER.md](SESSION-HEADER.md), then the selected numbered module's copy-paste block.
4. Read the dependency handoffs in the implementation checkout. A document existing does not mean its module is implemented.
5. Work through the sequence below. A module is done only when its acceptance gate has recorded proof.
6. Save each implementation handoff at `docs/handoffs/NN.md`. Do not overwrite this specification folder with generated handoffs.
7. If a technical contract changes, update PRD/TDD/tests and impacted prompts together before continuing.

A useful initial instruction to implementation:

```text
Read specs/capitaldesk/README.md and prompts/SESSION-HEADER.md inside that specification folder.
Then read and execute specs/capitaldesk/prompts/00-integration-gate.md only.
Inspect this checkout before modifying it. Treat the specification as a proposed design, not implemented code.
Verify integration capabilities without placing any trade. Record the exact mode, evidence and blockers.
Do not continue to later modules until you have provided the module handoff.
```

In later sessions replace the final module path with the next eligible module. Load the shared header every time; do not paste all 30 prompts into a single uncontrolled build request.

## Dependency index

| Module | Required completed dependencies | Requirement coverage |
|---|---|---|
| [00 — Repository and Binance capability gate](00-integration-gate.md) | None; initial read-only gate | FR-001, FR-003, FR-014, FR-023 |
| [01 — Monorepo foundation and environment contracts](01-workspace-foundation.md) | 00 | FR-021, FR-024 |
| [02 — Money types, canonical contracts and reducers](02-domain-contracts.md) | 01 | FR-004, FR-006, FR-007, FR-013 |
| [03 — Owner sessions and proposal-agent authority](03-identity-and-access.md) | 02 | FR-001, FR-003, FR-021 |
| [04 — Transactional journal, outbox and permanent replay records](04-postgres-journal.md) | 02, 03 | FR-010, FR-014, FR-022, FR-024 |
| [05 — Verified Binance market/account/order readers](05-binance-read-adapter.md) | 00, 02, 04 | FR-001, FR-002, FR-011, FR-018 |
| [06 — Account baseline and strategy claim ledger](06-baseline-and-ledger.md) | 04, 05 | FR-002, FR-004, FR-005, FR-022 |
| [07 — Strategy lifecycle and versioned absolute targets](07-strategy-intents.md) | 03, 06 | FR-003, FR-006, FR-007, FR-021 |
| [08 — Deterministic capital mandates and admission rules](08-mandates-and-risk.md) | 06, 07 | FR-005, FR-009, FR-011, FR-013 |
| [09 — Same-side aggregation and explicit conflict resolution](09-deterministic-planner.md) | 05, 07, 08 | FR-007–FR-012 |
| [10 — Plan sealing and transactional capital reservation](10-atomic-reservations.md) | 04, 06, 09 | FR-005, FR-010–FR-013 |
| [11 — Exact plan approval, expiry and revocation](11-owner-approvals.md) | 03, 08, 10 | FR-009, FR-013, FR-014 |
| [12 — Isolated credential holder and narrow execution adapter](12-isolated-executor.md) | 00, 03, 05, 11 | FR-001, FR-003, FR-013, FR-021 |
| [13 — Dispatch marker, unique child identity and crash semantics](13-durable-dispatch.md) | 04, 10, 11, 12 | FR-007, FR-013–FR-015 |
| [14 — Authoritative fills, FIFO attribution and exact fee accounting](14-fills-fees-allocation.md) | 05, 06, 10, 13 | FR-004, FR-012, FR-016, FR-017, FR-022 |
| [15 — Order terminality, evidence completeness and reservation release](15-order-reconciliation.md) | 05, 13, 14 | FR-014–FR-019 |
| [16 — Pool drift, quarantine, halt and evidenced recovery](16-drift-and-recovery.md) | 06, 08, 15 | FR-002, FR-018, FR-019, FR-022 |
| [17 — Complete HTTP API and executable OpenAPI](17-http-api-openapi.md) | 07, 09, 10, 11, 15, 16 | FR-001–FR-022 |
| [18 — Durable workers, SSE updates and signed webhooks](18-workers-events-webhooks.md) | 04, 15, 16, 17 | FR-014, FR-018, FR-021, FR-022, FR-024 |
| [19 — Integrator SDK, operator CLI and evidence verifier](19-sdk-and-cli.md) | 17, 18 | FR-021, FR-022, FR-024 |
| [20 — CapitalDesk MCP tools and real proposal-agent integrations](20-agentos-and-proposal-agents.md) | 00, 12, 19 | FR-003, FR-006, FR-008, FR-021, FR-023 |
| [21 — Modern application shell and accessible design system](21-ui-foundation.md) | 17 | FR-020, FR-024 |
| [22 — Account setup, capital ownership and strategy views](22-ui-capital-and-agents.md) | 06, 07, 17, 21 | FR-001–FR-007, FR-020 |
| [23 — Intent queue, conflict resolution and exact approval screens](23-ui-plans-and-approval.md) | 09, 10, 11, 17, 21 | FR-006–FR-013, FR-020 |
| [24 — Orders, incidents, ledger and independently verifiable exports](24-ui-recovery-and-evidence.md) | 14, 15, 16, 18, 21 | FR-014–FR-022 |
| [25 — Failure laboratory and invariant evidence runner](25-fault-lab-and-conformance.md) | 13, 14, 15, 16, 20, 24 | FR-014–FR-019, FR-023 |
| [26 — Operational telemetry and adversarial security hardening](26-observability-and-security.md) | 18, 20, 24, 25 | FR-003, FR-018–FR-024 |
| [27 — Reproducible CI, deployment, migration and disaster recovery](27-ci-deployment-and-restore.md) | 25, 26 | FR-022–FR-024 |
| [28 — End-to-end product proof, documentation and pilot package](28-release-proof-and-pilot.md) | 27 | FR-001–FR-024 |
| [29 — Final specification-to-code adversarial acceptance review](29-independent-final-review.md) | 28 | FR-001–FR-024 |

## Gate and parallel work rules

Prompt 00 can finish with an explicit blocked-capability report. Pure contracts, test harnesses and supported read-only work may then proceed; executor dispatch and real-integration release proof remain blocked until their own capability gates pass. Do not confuse recording a blocker with clearing it.

The safe default is numbered order. After their dependencies are actually complete, 22, 23 and 24 can proceed in separate branches against the agreed API and shared UI shell. Resolve overlapping components and migrations explicitly. No worker should independently change money types, approval hashes or allocation rules.

Prompt 29 is a fresh evidence-first final review. It cannot waive a failure simply because Prompt 28 produced a release report. All tests and manifests must bind to the final reviewed commit.

The prompts do not authorize funding, production trades, publication, pushing, hackathon submission or accepting external terms. Actual testnet transactions require a configured and explicitly authorized testnet account. Missing credentials mean a recorded external-proof blocker, not a production fallback.

For release milestones and scope, see [IMPLEMENTATION-PLAN.md](../IMPLEMENTATION-PLAN.md).

