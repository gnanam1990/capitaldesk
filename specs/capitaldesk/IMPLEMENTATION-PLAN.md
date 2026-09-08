# CapitalDesk — Implementation and Release Plan

Version 1.0 — 8 September 2026. Scope: build the complete first release in [PRD.md](PRD.md), under the contracts in [TDD.md](TDD.md). No implementation progress is implied by this plan.

## 1. Outcome and scope control

Deliver one working owner journey: verified Spot testnet account → reconciled strategy claims → competing target proposals → explicit conflict or compatible aggregate plan → exact owner approval → isolated single dispatch → actual fills/fees → ledger reconciliation → inspectable recovery and evidence.

The first release governs one selected Spot symbol in one beneficial owner's account, through sequential plans with multiple proposal agents. It is a complete bounded product, not a promise to support every exchange, asset or trading style. Multi-symbol optimization, derivatives, internal crossing, multi-owner funds and unattended managed-host execution are not hidden tasks.

The console, API, ledger, worker, executor, proposal integration, installation, documentation and recovery all belong to release scope. A polished frontend over fixtures does not satisfy completion.

## 2. Decide before starting

Prompt 00 records:

- The actual implementation path, repository state, existing architecture, licences and whether this is greenfield.
- Verified venue account identity/environment, selected symbol, exact fee/filter semantics and evidence correlation.
- The permitted execution route and actual isolation boundary. Broker-key Spot Testnet and managed Agentic MCP are separate modes.
- A versioned capability matrix with VERIFIED, BLOCKED and UNVERIFIED entries, primary sources, dates and redacted observations.
- The chosen dependency versions and an ADR for any justified deviation from this pack.
- Current event eligibility independently from technical feasibility; public documentation is not authenticated capability proof.

Do not modify Corporate Action Guard or another existing project just because previous conversation mentioned it. Reuse is a deliberate repository decision, not an implicit dependency.

Prompt 00 uses read-only inspection. An absent trading credential must not prevent pure domain/test work. It does prevent claiming real execution. No fake account, fabricated tool schema or mock success clears that gate.

## 3. Milestones and exit evidence

| Milestone | Modules | Required exit evidence |
|---|---|---|
| M0 — Integration and skeleton | 00–03 | Actual checkout inventory, capability gate, locked workspace, strict contracts, negative authorization tests; unavailable routes visibly disabled. |
| M1 — Account and economic authority | 04–08 | Real PostgreSQL migrations, durable journal, verified read normalization, baseline identity, per-asset claims, monotonic targets and versioned owner mandates. |
| M2 — Approved execution boundary | 09–13 | Deterministic same-side plan, opposite conflict, serializable reservations, exact approval digest, isolated executor and crash-tested single-dispatch marker. |
| M3 — Financial reconciliation | 14–16 | Fill/fee conservation, partial IOC settlement, UNKNOWN recovery, exact account cut, drift quarantine, epoch reset and unresolved-liability preservation. |
| M4 — Complete product surfaces | 17–24 | Real API, durable jobs/events, generated SDK/CLI, scoped proposal tools and operational UI across the full owner journey. |
| M5 — Adversarial and operational proof | 25–27 | Reproducible fault lab, security negatives, monitoring, CI, production fault exclusion, migration and actual backup/restore rehearsal. |
| M6 — Honest release | 28–29 | Clean-room actual testnet proof, source-bound export, documentation/video, final-head independent review, limitations and pilot go/no-go. |

Sequential correctness dependencies are intentional. A working UI can be developed against schema-validated development fixtures, but M4 cannot pass until the actual API/worker journey works. Fixtures never become production fallbacks.

## 4. Execution order and module deliverables

Use [the prompt index](prompts/README.md) for exact dependencies. The following files are separate copy-paste implementation sessions.

| Prompt | Main deliverable | Ownership boundary |
|---|---|---|
| [00 — Repository and Binance capability gate](prompts/00-integration-gate.md) | Prove which real account and execution route can support CapitalDesk before enabling financial code. | docs/integration-gate.md, docs/capabilities/, non-economic probe scripts |
| [01 — Monorepo foundation and environment contracts](prompts/01-workspace-foundation.md) | Create a reproducible application foundation with explicit environment isolation. | workspace manifests, apps skeletons, packages/contracts, build/config tooling |
| [02 — Money types, canonical contracts and reducers](prompts/02-domain-contracts.md) | Freeze exact financial units and state meanings before persistence and UI. | packages/contracts, packages/domain pure types/reducers |
| [03 — Owner sessions and proposal-agent authority](prompts/03-identity-and-access.md) | Separate owner approval, operator recovery, viewer access and untrusted proposals. | apps/api auth, packages/domain permission model, identity migrations |
| [04 — Transactional journal, outbox and permanent replay records](prompts/04-postgres-journal.md) | Make economic state durable and atomically replayable. | packages/db core schema/repositories/migrations |
| [05 — Verified Binance market/account/order readers](prompts/05-binance-read-adapter.md) | Provide source-grounded account and market facts without any write capability. | packages/binance read-only interfaces, worker ingest adapters |
| [06 — Account baseline and strategy claim ledger](prompts/06-baseline-and-ledger.md) | Give every governed asset unit exactly one explicit owner claim. | packages/ledger postings/projections, baseline and allocation service |
| [07 — Strategy lifecycle and versioned absolute targets](prompts/07-strategy-intents.md) | Make repeated agent targets safe, scoped and inspectable. | intent/strategy services and proposal routes |
| [08 — Deterministic capital mandates and admission rules](prompts/08-mandates-and-risk.md) | Enforce owner authority separately from observed venue wealth. | packages/domain policy engine and owner policy services |
| [09 — Same-side aggregation and explicit conflict resolution](prompts/09-deterministic-planner.md) | Turn valid targets into a transparent exact order plan. | packages/planner preview/compatibility algorithm |
| [10 — Plan sealing and transactional capital reservation](prompts/10-atomic-reservations.md) | Reserve every required asset exactly once before approval. | seal/reservation services and integrity constraints |
| [11 — Exact plan approval, expiry and revocation](prompts/11-owner-approvals.md) | Bind owner consent to the exact executable economic payload. | approval API/service, immutable approval evidence |
| [12 — Isolated credential holder and narrow execution adapter](prompts/12-isolated-executor.md) | Make the coordinator's enforcement claim true at the credential boundary. | apps/executor isolation, packages/binance write adapter |
| [13 — Dispatch marker, unique child identity and crash semantics](prompts/13-durable-dispatch.md) | Submit each governed child at most once automatically through its durable journal. | executor dispatch lifecycle and transactional claim logic |
| [14 — Authoritative fills, FIFO attribution and exact fee accounting](prompts/14-fills-fees-allocation.md) | Turn actual execution into exact strategy ownership without synthetic fills. | packages/ledger fill reducer and allocation projection |
| [15 — Order terminality, evidence completeness and reservation release](prompts/15-order-reconciliation.md) | Resolve unknown and partial execution using exact venue evidence. | worker order reconciler and financial completion service |
| [16 — Pool drift, quarantine, halt and evidenced recovery](prompts/16-drift-and-recovery.md) | Contain out-of-band account changes while retaining a truthful ledger. | pool reconciler, incidents and owner recovery actions |
| [17 — Complete HTTP API and executable OpenAPI](prompts/17-http-api-openapi.md) | Expose the complete product through one validated authorized contract. | apps/api routes, runtime schemas and generated OpenAPI |
| [18 — Durable workers, SSE updates and signed webhooks](prompts/18-workers-events-webhooks.md) | Keep users and integrations informed through restarts without duplicating economic work. | worker runtime, durable notifications and SSE/webhook delivery |
| [19 — Integrator SDK, operator CLI and evidence verifier](prompts/19-sdk-and-cli.md) | Give operators and developers safe typed access to the same workflows. | packages/sdk, operator CLI, integration examples |
| [20 — CapitalDesk MCP tools and real proposal-agent integrations](prompts/20-agentos-and-proposal-agents.md) | Demonstrate meaningful Agent OS usage while keeping decisions and credentials properly bounded. | packages/agent-tools, two reference proposal agents and integration docs |
| [21 — Modern application shell and accessible design system](prompts/21-ui-foundation.md) | Create the operational console specified in UI-UX.md. | apps/web tokens, shell, auth boundary and shared components |
| [22 — Account setup, capital ownership and strategy views](prompts/22-ui-capital-and-agents.md) | Let an owner see whose units are available, held or unresolved. | web account/pool, agent and capital routes |
| [23 — Intent queue, conflict resolution and exact approval screens](prompts/23-ui-plans-and-approval.md) | Make coordination and partial-fill allocation understandable before the user commits. | web intents, plan builder and approval routes |
| [24 — Orders, incidents, ledger and independently verifiable exports](prompts/24-ui-recovery-and-evidence.md) | Make uncertainty, held capital and recovery clear without technical narration. | web execution/recovery/ledger/export routes |
| [25 — Failure laboratory and invariant evidence runner](prompts/25-fault-lab-and-conformance.md) | Prove the product's central financial claims through actual failure boundaries. | packages/fault-lab, scenario CLI/UI, proof artifacts |
| [26 — Operational telemetry and adversarial security hardening](prompts/26-observability-and-security.md) | Detect silent failures and prove that integration authority remains contained. | observability, threat model, security suites and incident runbooks |
| [27 — Reproducible CI, deployment, migration and disaster recovery](prompts/27-ci-deployment-and-restore.md) | Prepare a real operable service and its repeatable recovery path. | CI, containers, release manifests, migration and restore scripts |
| [28 — End-to-end product proof, documentation and pilot package](prompts/28-release-proof-and-pilot.md) | Hand over an independently usable product with evidenced claims. | release proof, quickstart, demo/video plan and pilot/submission drafts |
| [29 — Final specification-to-code adversarial acceptance review](prompts/29-independent-final-review.md) | Challenge the complete release as a reviewer who does not trust prior success reports. | local audit report; source read-only; required fixes return to the owning module |

Shared money contracts, state machines and database migrations have one agreed version. Parallel branches must not invent incompatible versions of them. UI pages 22–24 are the clearest parallel opportunity after module 21 and all domain/API dependencies are accepted.

## 5. Mandatory requirement coverage

| Requirements | Main implementation | Independent proof |
|---|---|---|
| FR-001–003: account, baseline, authority | 00, 03, 05, 06, 12, 20 | Account/mode/epoch rejection, baseline quarantine, broker bypass tests. |
| FR-004–007: claims, budgets, targets, commitments | 02, 04, 06–08 | Golden ledger, contention, revision replay, unresolved-commitment blocking. |
| FR-008–012: conflicts, risk, reservation, planning, FIFO | 08–10, 14 | Zero dispatch on conflict, strict limits/filters, immutable allocation, per-strategy debit bounds. |
| FR-013–015: approval, dispatch, ambiguity | 11–13, 15 | Payload mutation, post-marker crash, accepted-response-loss and no-blind-retry tests. |
| FR-016–019: fills, final accounting, drift, recovery | 14–16 | Quote/base/third-asset fees, terminal partials, pagination, external drift, restore. |
| FR-020–022: UI, integration, provenance | 17–24 | Browser journey, negative scope tests, exact-unit exports and independent recomputation. |
| FR-023–024: failure proof and operable installation | 25–29 | Fault injection, targeted mutation tests, clean install, migration, real testnet evidence, final review. |

Every FR must appear in the implementation's `docs/requirements-traceability.md` with code paths, test names, proof class and status. Broad range coverage in this plan is not a substitute for that implemented trace.

## 6. Test-driven workflow for every module

1. Inspect dependency handoffs and record the frozen contract being implemented.
2. Write an independent failing behavior test. For an existing codebase, characterize relevant behavior before changing it.
3. Implement only the owned coherent slice, with explicit failure states.
4. Run unit/property tests; use actual PostgreSQL/processes for persistence and race claims.
5. Exercise negative permissions and no-side-effect assertions for every relevant write.
6. Run changed-dependent suites and preserve minimized regression seeds.
7. Update traceability, OpenAPI/ADRs if required, and the module handoff.

Local deterministic tests, real database integration, UI fixtures and actual venue proof are different evidence classes. Never report an external test passed because an adapter mock returned success. The complete list is in [TEST-PLAN.md](TEST-PLAN.md).

## 7. Integration gates that cannot be waived

| Gate | Failure disposition |
|---|---|
| Stable account identity and selected environment cannot be verified | Read-only; no baseline ownership or dispatch. |
| Native hosted confirmation/action binding cannot be established | Managed execution unavailable; no local-confirmation substitute. |
| Placement identity or complete fill correlation unavailable | No governed write capability; test pure behavior independently. |
| Fee/rounding policy cannot fit explicitly approved claim limits | Plan blocked; no borrowing from HOUSE or other strategies. |
| External history lacks a reliable account reconciliation cut | Accounting INCOMPLETE and dependent dispatch blocked. |
| Agent sandbox can access signing secrets or unrestricted write tools | Enforcement claim fails; repair boundary before release. |
| Unknown dispatch remains unresolved | Preserve reservation and liability; no rebaseline escape or new retry order. |
| Independent testnet proof unavailable | Report proof blocked; do not relabel simulation as the working product. |

Some upstream limitations may be fatal to the selected mode. Record a mode change in an ADR and update affected specs/tests; do not silently swap to a different account or funded production route.

## 8. Timing and current competition

This is milestone-based work, not a same-day completion promise. Estimate calendar time from the actual checkout after M0/M1; include integration uncertainty, reconciliation edge cases, security review and artifact preparation rather than estimating only happy-path screens.

The currently published Binance Mini Hackathon deadline is **8 September 2026, 23:59 UTC (9 September, 05:29 IST)**; see the [verified source register](SOURCES.md). The source is a point-in-time observation and should be refreshed before a submission.

Do not cut accounting or authorization gates to fit the event. If a compliant working slice already exists, reserve a separate final artifact window for a readable architecture diagram, reproducible README, limitation statement, video, repo links and form checks. If it does not exist, report that candidly. The full first-release acceptance remains unchanged.

Public sharing, registration, survey submission, rule acceptance and prize claims require explicit authorization. Technical implementation prompts do not authorize those actions.

## 9. Submission and release artifacts

Create these in the implementation checkout, tied to the tested build:

- `README.md`: problem, boundaries, prerequisites, clean setup, configuration, testnet-only start, owner journey and stop/recovery.
- `docs/architecture.md`: trust boundaries, data flow, execution/accounting state separation and deployment topology; render the actual diagram for review.
- `docs/integration-capabilities.md`: primary sources, exact versions, supported modes, redacted proof and unresolved capabilities.
- `docs/requirements-traceability.md`: all FRs, invariants, implementation paths, tests and proof status.
- `docs/runbooks/`: UNKNOWN, missing fee/fill pages, drift, auth expiry, reset, migration and restore.
- `docs/security-boundary.md`: threat model, isolation evidence, owner/admin trust limits, findings and remediation.
- `artifacts/proofs/<build-id>/`: request counts, exact order/fill IDs, complete economic export, independent calculations, screenshots, tests and manifest.
- `docs/release-readiness.md`: implemented/partial/missing/blocked, final commit, environment, compatibility and no claimed production audit.
- A concise demo video showing conflict, approved real order, response loss/restart recovery and evidence; deterministic partial-fill coverage identified separately.

An architecture drawing is part of implementation delivery, not evidence of a deployed topology. No personal credentials or sensitive headers belong in public artifacts.

## 10. Commercial validation is a separate gate

Before expanding, speak with three qualified overlapping-strategy operators, inspect/reproduce at least one real coordination incident and seek one paid pilot with written acceptance. Compare sub-accounts, one-strategy-per-asset isolation and manual sequencing explicitly.

Measure conflict prevention, time to resolve uncertainty, manual reconciliation time, unattributed quantities and unnecessary blocks. Do not claim demand from repository stars, impressions, prize availability or one issue report.

If operators do not value shared-account coordination, retain useful components or stop expansion. Technical correctness and a polished console do not prove a business.

## 11. Definition of done

The owner can install the product, connect the explicitly authorized testnet account, complete the full supported workflow through real UI/API/worker/executor paths, restart at critical boundaries, inspect exact fills and fees, recover uncertainty without duplicate dispatch, and export independently checkable evidence.

All applicable tests pass at the final reviewed head, critical findings are resolved, unsupported modes are clearly disabled, and no known accounting/authority defect is hidden behind a green summary. Production activation, commercial demand and competition eligibility are reported separately.

The final implementation handoff must say what actually ran, what did not, and what needs user or upstream action next.
