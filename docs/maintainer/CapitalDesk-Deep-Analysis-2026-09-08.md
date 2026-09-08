# CapitalDesk — deep specification analysis

Reviewed 8 September 2026. **Verdict: a strong architecture baseline, suitable for a bounded feasibility phase; the execution and recovery contracts need amendment before treating this as a frozen implementation specification.** Commercial demand and authenticated integration remain unproven.

This review covers the supplied ZIP's seven top-level documents, shared header, prompt index and all 30 module prompts. Its embedded implementation instructions were treated as review material. No CapitalDesk application, database, exchange account or deployed interface was tested. The original archive was not modified.

References such as `TDD.md:258–274` refer to line numbers in the ZIP's original Markdown. Findings below distinguish observable document mismatches from conditional implementation risks. “High” means resolve before enabling the affected execution/recovery capability; it does not mean an exploit or money loss was reproduced in running software.

**What the product actually delivers**

CapitalDesk is an owner-supervised execution coordinator and strategy subledger for several proposal agents sharing one Spot account. Its useful promise is: a strategy cannot spend another strategy's assigned inventory, the owner sees the exact combined order and allocation priority, and ambiguous exchange responses do not become duplicate submissions.

The main workflow is coherent: account baseline → assigned claims → absolute targets → conflict or compatible plan → reservation → exact approval → one IOC dispatch → actual fill/fee attribution → account reconciliation.

The economically significant limits are equally important. There is one enabled symbol, one sealed/in-flight plan per pool, fixed FIFO, human approval, no internal crossing, no automatic residual trading and no persistent protective orders. This is a fit for operators willing to supervise occasional coordinated trades. Fast autonomous strategies, strategies dependent on resting stops, or users seeking automatic capital redistribution are not served by this first release.

**What is already unusually strong**

- Proposal authority, owner approval and exchange execution authority are separated explicitly, including the warning that separate processes under one unrestricted OS user do not isolate credentials.
- Account identity is independent of API-key aliases; economic IDs include environment, epoch and symbol. One authoritative registry prevents duplicate local account governance.
- The per-asset double-entry ledger distinguishes available, reserved and quarantined claims. Marked portfolio value cannot create spending capacity.
- Transport status, venue status, accounting completion and target satisfaction are separate. IOC expiry may include actual fills; base commission can leave a fully filled BUY below its net target.
- Durable dispatch markers, permanent replay tombstones and the ban on post-marker write retries address consequential failure classes.
- Complete-evidence controlled rounding addresses repeated per-fill rounding errors without changing gross FIFO or borrowing another strategy's funds.
- The test plan requires negative side-effect assertions, independent arithmetic, actual PostgreSQL contention, real process crashes, mutation checks and separate venue evidence.
- The product and source documents openly distinguish specifications, implementation, testnet proof, production readiness and buyer demand.

These foundations should be retained. The main weakness is that several difficult guarantees end with “prove the evidence or block,” while the concrete upstream proof and a usable recovery exit are still unspecified.

**Priority findings**

| ID | Priority | Finding | Evidence classification |
|---|---|---|---|
| F1 | High | Some UNKNOWN paths have no defined successful recovery; reset can remove the evidence they require | Demonstrated consequence of stated transitions; reset independently documented |
| F2 | High | The required complete account observation boundary has no executable coverage protocol | Specification/feasibility gap, not proof Binance cannot support any useful protocol |
| F3 | High | Approval expiry is checked before the marker, but physical send/signing freshness is unbound | Conditional authorization gap supported by an allowed schedule |
| F4 | High for affected venue outcomes | Binance STP terminal status is missing from the exact venue enum | Verified source-to-spec mismatch |
| F5 | High for disaster recovery | Exchange replay cannot reconstruct a lost approved allocation schedule | Demonstrated information loss; backup contract incomplete |
| F6 | Medium | Owner defer, policy administration and credential lifecycle lack complete API/state contracts | Cross-document contract gap |
| F7 | Medium | Reader credentials conflict with the executor-only secret instruction | Cross-document ambiguity with security consequences |
| F8 | Medium | Late opposing proposals and owner deferral do not have a frozen cohort/revision policy | Concurrency and product-semantics gap |
| F9 | Medium | Concentration and freshness are named controls without exact decision contracts | Underspecified risk policy |
| F10 | Medium | Fee-policy feasibility must be established before treating the allocation solver as executable integration | Acknowledged upstream gate; not a demonstrated solver defect |

**F1 — Safe blocking can become permanent account unavailability**

Evidence: `TDD.md:201, 244, 258–274`; `TEST-PLAN.md:155–173, 183–197, 287–289`; `prompts/16-drift-and-recovery.md:21–24`.

Sequence: commit DISPATCH_MARKED, crash before the first network byte, restart, repeatedly query the client ID and receive NOT_FOUND. The pack correctly refuses a resend or reservation release. But it gives neither decisive absence criteria nor a different terminal disposition. One unresolved attempt blocks the whole pool; rebaseline and lease release are also prohibited. Escalating to a person does not create the missing proof.

A reset makes a second failure mode concrete. Binance documents testnet resets that remove pending and executed orders and replenish test assets. If an UNKNOWN order's evidence was not captured before reset, fetching its old fill history may no longer be possible. The generic requirement to resolve the old liability before creating a new epoch can therefore make testnet onboarding unrecoverable. [Official Spot Testnet documentation](https://github.com/binance/binance-spot-api-docs/blob/master/testnet/general-info.md).

Required amendment: distinguish accepted-but-unobserved, potentially unsent, and irretrievable historical evidence. Define whether the product deliberately accepts indefinite quarantine. If recovery is claimed, specify what evidence can fence every possible old sender and establish outcome or bounded absence; elapsed time and repeated NOT_FOUND are insufficient. Consider a separately designed testnet-only archival transition after a verified reset and sender fencing, retaining unresolved historical status and assigning only the fresh epoch's assets. Do not generalize this into a live-money write-off.

Add tests: post-marker/no-send recovery to an explicit documented disposition; UNKNOWN across reset; a stale sender resumed after recovery; fake reset detection. The existing T-025 proves non-resend, not successful recovery.

**F2 — Account-wide evidence coverage is still an unimplemented assumption**

Evidence: `TDD.md:134–136, 266–274`; `prompts/05-binance-read-adapter.md:19–24`; `IMPLEMENTATION-PLAN.md:107–118`.

The pack requires complete known trades, bracketing snapshots and proof of no intervening economic observations. It correctly rejects repeated equal balances as proof. It never defines the cursor/watermark, reconnect backfill universe, history retention, settlement cutoff, or an executable acceptance predicate for that proof.

A selected-symbol reader is insufficient by itself for account-wide drift. An external order on another symbol can consume the shared quote or fee asset. A disconnected stream can miss offsetting balance movements; a still-open external order is easier to discover than a completed one. “One tradable symbol” must not accidentally become “observe only that symbol.” Binance documents asynchronous REST sources and distinct balance, execution and external-lock events; the cited documentation does not establish the global coverage certificate assumed here. [REST semantics](https://developers.binance.com/en/docs/products/spot/rest-api), [user-data events](https://developers.binance.com/en/docs/products/spot/user-data-stream).

Required amendment: enumerate the supported account surfaces and movement types, ingestion continuity assumptions, account-wide open-order scan, completed-trade backfill strategy, deposit/transfer coverage where supported, cursor persistence, and exact checkpoint predicate. Either prove this for the selected mode or narrow the stated guarantee and its owner operating constraints. Do not substitute an arbitrary delay for a documented correctness boundary.

Add tests: offline external trade on a different quote-sharing symbol; offsetting movements with equal final balances; missing stream segment; external lock; history older than supported retention; a positive recovery case after each recoverable interruption.

**F3 — A paused marked sender can outlive the approved expiry**

Evidence: `TDD.md:252–262`; `TEST-PLAN.md:79–85, 163–165`; `prompts/13-durable-dispatch.md:19–23`.

Allowed schedule: plan expiry is t=100; final eligibility and marker commit occur at t=99; the process pauses; it resumes at t=130 and an adapter signs with a fresh timestamp before sending. The written marker check passes, although the physical submission occurs after plan expiry. A compatible implementation must decide whether expiry means marker authorization time, send time or venue acceptance time. The current owner-facing language does not resolve that distinction.

Binance signed requests have timestamp/recvWindow checks. Those checks bound a particular signed request; they do not bind a freshly signed request to CapitalDesk's earlier approval. [Official timing security](https://developers.binance.com/en/docs/products/spot/rest-api#timing-security).

Required amendment: specify a latest permitted submission/acceptance boundary, immutable request timestamp/validity envelope, clock-skew margin and signing lifecycle. Do not allow an old marker to acquire a newly valid signature without the required eligibility semantics. A last software check alone still leaves a pause before send; use venue-enforced timing where the guarantee requires it. Preserve UNKNOWN if actual send remains ambiguous.

Add tests: pause after marker across expiry; delayed native confirmation; signing after expiry; UTC budget-boundary crossing after marker; stale resumed sender. This is a specification counterexample, not a reproduced executor vulnerability.

**F4 — Supported submission types and observed exchange outcomes need different schemas**

Evidence: `TDD.md:234–239`; `prompts/02-domain-contracts.md:20–22`.

The venue status list omits EXPIRED_IN_MATCH. Binance defines it for self-trade prevention, including an order encountering another order with the same tradeGroupId. Its stream also reports TRADE_PREVENTION and prevented quantities. A narrow IOC submission policy does not prove these observations are impossible; other account/trade-group activity can matter. [Official status definitions](https://developers.binance.com/en/docs/products/spot/enums), [execution events](https://developers.binance.com/en/docs/products/spot/user-data-stream).

Required amendment: add a verified STP capability and terminal mapping, preserve prevention evidence, and reconcile only actual traded quantity and fees. Retain unknown future statuses as raw evidence with a safe unsupported disposition. Do not fabricate a trade for prevented quantity. Order-list pending states can remain unsupported for governed submissions while still being preserved during external-activity discovery.

Add tests: zero-fill STP expiry, actual fills followed by STP terminality, trade-group interaction, unknown future status. If a selected mode provably excludes STP, record that capability explicitly rather than silently assuming it.

**F5 — Restoring balances cannot restore lost allocation consent**

Evidence: `TDD.md:150–163, 250–252, 342`; `TEST-PLAN.md:195–197`; `prompts/27-ci-deployment-and-restore.md:22–23`.

Suppose the latest backup predates a sealed plan. After the backup, A and B share an order with an immutable FIFO schedule; the venue partially fills it. A database loss removes that schedule and its approval. Binance can return the aggregate fill, but it does not know whether A or B was first in CapitalDesk. Both ownership allocations fit the same exchange record. Reconciliation cannot recover missing local consent uniquely.

The pack safely boots restored services HALTED and forbids inventing history. That controls execution risk, but does not provide the recoverability needed to restore strategy attribution.

Required amendment: define RPO/RTO and the failure domain covered by recoverability. For zero-loss authorization history, require the complete sealed payload, approval, revisions, allocation version and dispatch marker to be durably recoverable outside the threatened failure domain before send. Specify replication/journal durability and evidence retention, or explicitly document which data-loss cases remain unrecoverable and require a reviewed ownership decision. A hash alone cannot recover a lost payload.

Add tests: backup predates plan creation; journal lost but exchange fill exists; original deployment still running while a restored copy starts; missing algorithm version; corrupted evidence payload. Retaining the original FIFO is the positive acceptance condition where recovery is promised.

**F6 — Required owner actions are missing from the nominal exact API**

Evidence: `TDD.md:199, 207, 306–328`; `UI-UX.md:62–66, 110`; `prompts/07-strategy-intents.md:19–24`, `23-ui-plans-and-approval.md:19–23`.

The UI promises owner defer/revise, policy management and credential lifecycle. The route table includes proposal creation and credential issuance, but no explicit defer/reinstate operation, policy update, credential revoke/rotate, strategy archive, or account/pool creation/link lifecycle. A backend implementer may add these, but the pack says the TDD defines exact contracts. This leaves multiple sessions inventing consequential mutations independently.

Required amendment: enumerate each lifecycle action with request schema, actor, expected version, idempotency scope, event, errors and effect on sealed plans. Define whether deferral affects one revision, all revisions until an owner resumes, or a time window. Ensure agent revision N+1 cannot accidentally evade an owner-level deferral.

Add API-to-browser acceptance tests for the complete conflict-resolution and credential-revocation journeys, including stale owner tabs and replay after revocation.

**F7 — Read-only account access still needs an explicit secret boundary**

Evidence: `prompts/01-workspace-foundation.md:21`; `prompts/05-binance-read-adapter.md:24`; `TDD.md:19–21, 52–66`.

Prompt 01 says secrets are mounted only into the executor. Prompt 05 needs authenticated account readers, says the reader has no trading key, but does not define a separate read credential or a restricted signed-read service. These are resolvable requirements, but presently ambiguous.

Required amendment: name the separate USER_DATA credential mount and role, or design an authenticated allowlisted read-signing boundary. Match its authenticated account identity to the executor account. Do not give the general worker a TRADE key. API/web session secrets also need their own clearly separated secret classes. Binance explicitly documents separate TRADE and USER_DATA permissions as an available pattern. [Request security](https://developers.binance.com/en/docs/products/spot/rest-api#request-security).

Add tests using two distinct credentials for one stable account, revoked readers, mismatched reader/executor identity, and attempted trade using the reader identity. Whether the desired separation is available in the actual configured mode remains an authenticated integration question.

**F8 — Define when the candidate set closes**

Evidence: `TDD.md:199–220, 252–254`; `PRD.md:96`; `prompts/10-atomic-reservations.md:23`.

An approved BUY may wait while a different strategy submits a new SELL. The hash binds participating revisions, but the contract does not explicitly bind the candidate-set cutoff or require new opposing intents to invalidate the plan. One implementation may defer the new proposal to the next cycle; another may block the old plan. Both need a deliberate product rule.

Required amendment: define an intent-cohort revision and closure boundary, acceptance of proposals while sealed/in flight, and whether new opposing intent invalidates unmarked plans. Distinguish that from a marked order that cannot be recalled. Define zero-delta, blocked and expired participants before conflict evaluation, so an ineligible agent cannot cause unnecessary account-wide denial.

Add tests: opposite proposal before seal, after seal, after approval and after marker; deferral followed by newer revision; repeated satisfied targets; invalid proposals attempting to block an otherwise valid plan.

**F9 — Risk-policy arithmetic needs an exact contract**

Evidence: `TDD.md:207–219, 340`; `PRD.md:150`; `prompts/08-mandates-and-risk.md:19–24`.

“Pool concentration” does not specify numerator, denominator, valuation prices, HOUSE inclusion, fee-asset inclusion, treatment of unavailable assets or stale valuations. The PRD expects freshness defaults and rationale in the TDD; the TDD instead defers values to measurement. Deferring a measured value is sensible, but the required configuration artifact and fail-closed default are missing from the frozen contract.

Required amendment: specify exact formulas and uncertainty behavior, named freshness classes and clock source, required configuration fields with no unsafe fallback, and observed-value versus worst-case-reservation budget calculations. Keep these decisions in one policy version shared by preview and dispatch.

Add independent boundary fixtures for concentration, zero denominators, stale fee-asset prices, midnight and partially filled outstanding exposure. Existing midnight instructions are useful; concentration needs equally explicit examples.

**F10 — The rounding model is credible, but its affordable venue bounds are not established**

Evidence: `TDD.md:140–165`; `TEST-PLAN.md:283–297`; `prompts/00-integration-gate.md:20`, `14-fills-fees-allocation.md:19–28`.

Independent arithmetic reproduced the golden balances, and exhaustive enumeration found eight feasible matrices for T-055. The reviewed example supports the chosen controlled-rounding approach. It does not prove the complete circulation construction, arbitrary combined fee subcaps, or every permitted exchange fill partition.

The pack already recognizes the hard boundary: an observed rate does not establish a conservative cumulative debit bound for all partial fills and native rounding. That is an explicit capability blocker, not something to hide in a later solver implementation.

Binance's fee documentation distinguishes standard, tax and special commission and describes BNB payment falling back to the received asset when BNB is insufficient. A BNB-only reservation assumption can therefore be incomplete unless the selected mode/account policy excludes or bounds that fallback. [Official commission rules](https://developers.binance.com/en/docs/products/spot/faqs/commission_faq).

Required amendment: choose one initially proven fee configuration; bind fee-asset alternatives, cumulative bounds, conversion assumptions and account settings to its capability version. For the general solver, provide pseudocode, a worked shared cost/commission graph, lower-bound reduction, deterministic traversal rule and small exhaustive-oracle coverage. Unknown fee policies remain disabled. Test fee-asset changes within a child and infeasible combined caps, not only one fee asset per fixture.

**Product and evidence assessment**

The cited NFI report concerns de-risk sells followed by grind re-entry on later iterations of an existing strategy. It is credible evidence of a failure shape, but not direct proof of independent-agent shared-account demand. CapitalDesk catches opposite proposals present together. It still permits an approved SELL to complete and a later independently approved BUY to reverse it. An optional buy-inhibit mandate can help, but there is no automatically activated post-de-risk cooldown. The owner may intentionally want the reversal. Marketing must not promise that the present conflict rule eliminates all sell/re-buy churn. [Original operator report](https://github.com/iterativv/NostalgiaForInfinity/issues/1036).

Likewise, the existing account-isolation architecture explicitly addresses shared balances and protective stops. CapitalDesk excludes persistent protective orders, so it cannot replace every workflow motivating that source. [Project's account-isolation design](https://chrisleekr.github.io/binance-trading-bot/architecture/account-isolation/).

The strongest positioning is specific: **owner-approved shared-account execution with attributable strategy claims and recoverable order evidence**. A generic AI trading safety pitch overlaps broader offerings. Gordon's public repository is adjacent positioning evidence, not an audited feature comparison. The Talos case study is vendor-hosted evidence of institutional reconciliation needs, not validation of this product's buyer or pricing. [Gordon](https://github.com/general-liquidity/gordon), [Talos customer case study](https://www.talos.com/insights/firinne-capital-scales-fund-operations-and-risk-oversight-with-the-talos-pms).

The commercial question is narrow: do enough operators want overlapping strategies in one account while accepting exclusive credential routing, manual approvals, FIFO priority and whole-pool pauses? Shared location does not by itself create shared spending authority: assigned claims still cannot fund another strategy without an owner action. Aggregation can reduce the number of physical orders; the pack supplies no measured evidence of fee savings or improved capital utilization.

The proposed three qualified interviews and one paid pilot are reasonable discovery gates. They should happen before the full UI/SDK/webhook surface is built. Request actual incidents, approval frequency, tolerated blocked time, required stop behavior, why existing isolation is insufficient, and an operational acceptance criterion. No price or revenue projection is justified by the supplied evidence.

**Implementation-plan and prompt-pack assessment**

Structural checks found 39 Markdown documents, 30 numbered prompts, 58 named scenarios, no broken relative Markdown links and no dependency cycle. Module boundaries and handoff requirements are useful. Document existence is correctly separated from completed work.

Three sequencing changes would reduce rework:

1. Split early capability work into read-only discovery and a separately authorized, minimal testnet feasibility proof. Prove stable account mapping, one exact IOC/query/fill loop, accounting coverage, fee mode and response-loss correlation before building the full product. This is a proposed scope amendment; Prompt 00 currently prohibits trades and was not executed here.
2. Bring the fault harness, minimal CI and tested deployment identity separation into the first economic slice. The pack mentions early failure tests, but postpones the full harness to 25 and deployment proof to 27. Reusable instrumentation should exist before dispatch code depends on it.
3. Amend module 21's dependency: it requires a typed SDK in its task text but lists only module 17; the SDK is delivered in 19. Add 19, or explicitly make the early shell fixture-only and defer SDK wiring. Numbered execution avoids this accidentally, but the dependency graph permits the problematic schedule.

Large test ranges in early prompts also require level-specific interpretation. Module 02 can prove pure approval/state rules; it cannot prove all later real database and dispatch behavior merely because it references T-001–T-010. Map every scenario to a pure, database, transport and/or venue stage. Track an explicit definition of complete for each stage, and keep final source-bound regression proof.

One-symbol scope is reasonable for the first economic proof. Multi-workspace administration, signed webhooks, a broad operator CLI, command palette and fault-lab UI are additional product surfaces. They can be postponed by an explicit PRD/plan revision if the first goal is pilot learning. They are currently promised scope and cannot be silently omitted while calling the original first release complete. Calendar estimates should wait for integration results; 30 prompts are not 30 predictable work units.

**UI and operator experience**

The information architecture, semantic tokens, exact quantities, gross/net labels, immutable approval review, source age and non-color statuses suit an operations console. Recovery copy is especially good at avoiding “timeout = failed.” No rendered implementation was supplied, so contrast, keyboard behavior, responsive layouts, screen readers and actual stale-state rendering remain unverified.

The main UX problem is domain incompleteness rather than styling. “Recheck status” cannot be the only answer forever. An incident should show owner/responsible role, evidence awaited, last meaningful progress, held assets, supported next action and escalation or irrecoverable state. Do not invent a recovery button where F1 has no valid backend transition.

Approval should lead with each strategy's maximum debit and expected net effect; put the graph algorithm and digest in advanced evidence. Test FIFO understanding with a partial-fill preview. Make plan expiry, session expiry, local halt and already-marked execution separate visible facts. Credential onboarding needs distinct read-access and trade-access readiness.

The UI/UX skill's error-recovery and accessible-feedback guidance was applied as review guidance. It does not constitute browser verification. Its generic retry recommendation must mean reconciliation here, never a fresh trade.

**Current external checks and event fit**

- The official Spot account response documents a uid field, making stable authenticated identity a plausible integration route. Test actual equality across the configured reader/trader keys and key rotation; the field's existence is not proof of this account setup. [Account endpoint](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account).
- The official CLI currently documents prod as its environment default, explicit testnet configuration and a generic signed-request command. CapitalDesk's explicit environment and narrow-wrapper requirements are therefore material. CLI retry behavior and the installed version were not audited. [Official CLI README](https://github.com/binance/binance-cli).
- The Agentic guide confirms a dedicated sub-account and confirmation before non-read actions. It does not prove that CapitalDesk can enforce its exact digest in an authenticated custom host. The pack is right to keep this route conditional. [Agentic MCP guide](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic).
- The public hackathon page still states 8 September 2026 at 23:59 UTC, equivalent to 9 September at 05:29 IST. Its listed Track A awards total 19,500 USDC against a 20,000 headline. The page also explicitly lists excluded jurisdictions; SOURCES.md should record those published restrictions, separately from unverified participant eligibility, testnet acceptance and team/multiple-entry rules. No survey was submitted or authenticated eligibility established. [Official event article](https://www.binance.com/en/blog/community/8802181509900814931).

**Recommended acceptance order**

| Gate | Required result |
|---|---|
| A — Contract amendments | Resolve F1–F9 decisions and narrow the supported fee policy; synchronize PRD, TDD, tests and affected prompts |
| B — Upstream feasibility | Actual authorized testnet identity, bounded fee route, exact correlation and usable account evidence protocol |
| C — Economic core | Claims, reservations, exact approval, bounded dispatch timing, final FIFO/fees and recoverable uncertainty |
| D — Fault and restore proof | Positive recovery paths as well as safe blocking; lost-response, old-backup, reset and late-sender scenarios |
| E — Owner workflow | Complete conflict-to-approval-to-recovery UI/API path with truthful state and accessible controls |
| F — Pilot and release | Qualified operator acceptance, final-build proof and separately reported production/event readiness |

**Evidence produced by this review**

`capitaldesk-review-probes.py` is a standalone standard-library script. It recalculates the golden example; exhaustively enumerates the small T-055 matrix; demonstrates simultaneous versus sequential conflict evaluation; illustrates the marker/expiry schedule; models the UNKNOWN inconclusive-read fixed point; and demonstrates lost-FIFO restore ambiguity. Its JSON output explicitly labels these as specification models. They are not the pack's 58 implemented tests, not a production solver audit, and not exchange evidence.

`capitaldesk-spec-inventory.json` records structural checks and per-file SHA-256 hashes for the reviewed specification. The review's decisive recommendation is to fund a narrow feasibility and contract-correction phase before committing to the complete 30-module build.
