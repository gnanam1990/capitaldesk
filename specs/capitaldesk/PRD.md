# CapitalDesk — Product Requirements Document

Version: 1.1, amended 8 September 2026  
Date: 8 September 2026  
Status: implementation specification; no deployment or customer validation implied  
Related: [technical design](TDD.md), [test plan](TEST-PLAN.md), [implementation plan](IMPLEMENTATION-PLAN.md), [UI specification](UI-UX.md), [sources](SOURCES.md), [module prompts](prompts/README.md), [amendments](AMENDMENTS.md)

> **Amended.** Sections 5, 6, 8 and 10 carry amendments resolving review findings F2, F3,
> F8 and F9. The original reviewed text is preserved in git history at commit `c68137e`.

## 1. Product decision

CapitalDesk coordinates several strategy agents using one owner's Binance Spot account. Agents propose desired holdings; CapitalDesk checks ownership claims, reserves capital, exposes conflicting proposals, obtains the owner's approval, and reconciles actual exchange execution into a shared ledger.

The initial problem is operational correctness: two agents can each make a reasonable proposal using the same available balance, while their combined actions oversubscribe capital or contradict each other. CapitalDesk makes that conflict visible and gives the account one consistent, explicitly approved execution plan.

The product does not promise better returns. Its measurable outcomes are fewer conflicting executions, no application-created duplicate order during an ambiguous response, accurate fill attribution, and a complete explanation of remaining uncertainty.

## 2. Problem and evidence

| Observation | Evidence | What it supports | What it does not establish |
|---|---|---|---|
| An operator reported a de-risk sale followed shortly by a re-buy. | [NostalgiaForInfinity issue #1036](https://github.com/iterativv/NostalgiaForInfinity/issues/1036) | Conflicting automation is a concrete failure shape worth reproducing. | Its market-wide frequency or a commitment to pay CapitalDesk. |
| An existing bot architecture restricts strategy ownership of a base asset because shared balances and stops interfere. | [Account-isolation design](https://chrisleekr.github.io/binance-trading-bot/architecture/account-isolation/) | Shared-account strategy isolation is a recognized engineering constraint. | That a coordinator is always preferable to separate sub-accounts. |
| Binance describes response conditions where execution status is unknown. | [Official Spot REST documentation](https://developers.binance.com/en/docs/products/spot/rest-api) | Submission, acknowledgement, and actual order execution must be separate states. | That any error means the order was rejected or safe to resubmit. |
| Agentic MCP writes require the supported native confirmation flow. | [Official Agentic MCP documentation](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic) | Managed execution must respect the host's permission and action model. | Custom-client access, unattended execution, or equivalence between Agentic and ordinary API-key accounts. |

Evidence is sufficient to specify and test the technical failure. Demand and willingness to pay for this exact product remain unproven. Refresh source contracts before implementing an integration; the full provenance and unresolved questions belong in `SOURCES.md`.

## 3. Intended customer and buying decision

Initial user: a technically capable operator running two or more strategies for the same beneficial owner, with overlapping asset interests and an operational reason to retain one account.

Initial buyer: that operator, or an agent platform embedding coordinated execution for its own accounts. Interview candidates should already run overlapping strategies and be able to show a conflict, capital allocation workaround, or difficult recovery incident.

The strongest alternative is separate exchange sub-accounts with isolated credentials and balances. CapitalDesk should lose that decision when isolation is simple and shared capital provides little value. It should win only when the user can demonstrate a need for shared inventory or coordinated capital and accepts the ownership and execution constraints.

Other alternatives include assigning each base asset to one strategy, manually sequencing trades, and building an internal coordinator. The interview must compare these alternatives directly.

Pricing is a hypothesis: an account subscription for operators and an integration licence for platforms. Do not use assets under management, promised returns, a fabricated market-size calculation, or the hackathon prize as evidence of willingness to pay.

## 4. Release contract

The complete first release supports one beneficial owner, one Binance Spot account, multiple untrusted proposal agents, and a shared base asset traded through one explicitly selected quote pair. The data model may identify multiple symbols, but the enabled release scope is one selected symbol and no cross-symbol capital optimization.

Every strategy holds virtual subledger claims inside the same exchange account. These claims are not separate Binance accounts or exchange positions. The owner assigns opening claims from a reconciled account baseline before proposals can execute.

The same authenticated venue account cannot be attached to two active pools or workspaces within the governing registry, including through different or rotated API keys. Separate deployments cannot independently claim exclusive governance of that account.

Strategies propose an absolute target base quantity (`targetBaseQtyAtoms` on the wire, with explicit asset scale), a monotonically increasing revision for each strategy and symbol, an expiry, and an acceptable limit-price constraint. Repeating a target does not request an additional trade. Current confirmed claims and existing commitments determine any remaining delta.

Targets are net holdings; exchange orders request gross quantities. A base-asset BUY fee may leave the target unmet even after a full order fill. A SELL must reserve and admit quantity conservatively so gross sale plus supported base commission cannot take net holdings below the target. The UI distinguishes child completion from net target satisfaction; neither residual authorizes another order automatically.

Compatible same-direction intents may be combined into one real `LIMIT IOC` order. A buy uses a price no higher than the strictest participant maximum; a sell uses a price no lower than the strictest participant minimum. The approved allocation schedule is immutable FIFO. Opposite directions enter `CONFLICT`; the owner must defer or revise proposals before execution.

This release contains no internal crossing, synthetic trades, automatic buy/sell netting, shorting, leverage, futures, client-fund pooling, transfers, withdrawals, or multi-owner custody. A sell cannot spend another strategy's inventory claim. A risk mandate may inhibit new buys; it does not implicitly authorize a sale of another strategy's holdings.

## 5. Authority and supported operation modes

| Mode | Actual capability | Required boundary |
|---|---|---|
| Broker-controlled Spot testnet | Real testnet account state and supported Spot orders through an isolated executor. Agents can use Agent OS proposal or research tools separately. | Proposal processes never receive the trade credential; exact account identity, filters, and order correlation are verified. |
| Broker-controlled Spot live | A later enabled deployment of the same restricted execution contract. | Explicit deployment configuration, current integration evidence, reconciled baseline, approved exposure limits, and all release gates. Never enable as an automatic prompt side effect. |
| Supported Agentic MCP host | Conditional managed execution using the documented host and native confirmation workflow. | Verify actual schemas, authentication, action binding, account identity, order lookup, and confirmation behavior first. Every write, including cancellation, obeys the native confirmation contract. |
| Read-only/proposal-only | Inspect, model conflicts, and produce plans without dispatch. | Clearly display that execution is unavailable; never synthesize successful orders. |

An ordinary Spot API key does not prove access to an Agentic managed account. The two account routes must remain distinct. Local plan approval is not a substitute for required native MCP confirmation.

Trading agents must not have another write path to the governed account. If agents retain direct credentials, CapitalDesk cannot promise exclusive enforcement. Out-of-band manual or external changes are still possible; detecting one quarantines affected execution until the account and claims are reconciled.

> **Amended by ADR-0002 — owner operating constraint.** Binance provides no account-wide
> completed-trade endpoint, so this release **detects** any unexplained balance movement
> account-wide but **attributes** activity only within the declared observed symbol set.
> Complete attribution therefore holds only while no external trading occurs on the governed
> account. A violation is always detected and quarantines the pool; it is not always
> explained. Deposits, withdrawals and internal transfers are unobservable in the v1 testnet
> surface. State this limitation to operators; do not describe the product as reconciling all
> external activity.

Technical success on Spot testnet plus Agent OS proposal tools does not establish hackathon eligibility. Eligibility is unverified until current official rules accept the demonstrated integration. The product remains useful independently of an event deadline.

## 6. End-to-end owner journey

1. Connect a supported account in read-only discovery mode. Confirm account identity, environment, allowed symbol, source health, and available execution capability.
2. Reconcile balances, existing orders, and required trade history into a new baseline epoch. Classify existing activity before enabling execution.
3. Create strategy identities and explicitly assign virtual asset claims and spend budgets. Keep unassigned assets visible.
4. Register agents with proposal-only tokens. Let agents submit absolute targets with revisions and price constraints.
5. Review compatible intents or a conflict. Resolve opposite directions by deferring or revising; there is no hidden cross or optimizer override. *(ADR-0008: the candidate set closes at seal. A later opposing intent invalidates a sealed but unmarked plan and releases its reservations; after the dispatch marker it queues instead, because the order cannot be recalled.)*
6. Review the exact plan: participating revisions, capital reservations, order parameters, fee allowance, FIFO allocation, expiry, and evidence freshness.
7. Approve the current plan digest. Complete native confirmation as well when the selected integration requires it.
8. Dispatch once after durable preparation and a last current-state validation. Observe real venue acknowledgement and fills.
9. Allocate authoritative fills and actual fees. Reconcile the account and release only the unused reservation supported by a known terminal outcome.
10. If execution is uncertain or account drift occurs, use the incident workbench to inspect evidence and recover before additional dependent execution.

## 7. Functional requirements

The technical design specifies data structures and state transitions. These requirements define user-visible behavior and acceptance boundaries.

| ID | Requirement | Acceptance condition |
|---|---|---|
| FR-001 | Identify account and capability mode explicitly. | Every plan, order, evidence record, and view resolves to one account, environment, and baseline epoch; an unavailable write capability cannot be represented as ready. |
| FR-002 | Establish a reconciled baseline. | Execution remains blocked until balances and known existing orders reconcile and the owner assigns or leaves unassigned opening claims. Testnet reset invalidates the old epoch. |
| FR-003 | Isolate agent authority. | Agent tokens can propose and inspect authorized results but cannot approve, reserve arbitrarily, alter claims, obtain venue credentials, or dispatch orders. |
| FR-004 | Maintain virtual strategy claims. | Each asset is accounted for in exact quantities; no strategy receives the same account asset twice or sells more than its available claim. |
| FR-005 | Enforce budgets separately from venue balance. | A large venue balance cannot bypass owner-authorized claim or budget limits. New reservation must pass both internal authority and reconciled venue-capacity checks. |
| FR-006 | Accept versioned absolute targets. | Same request and revision are replayed safely; conflicting payload for that identity is rejected; lower revisions cannot replace newer intent. |
| FR-007 | Account for existing commitments. | Repeated target evaluation while an order is unresolved does not create an additional commitment for the same target quantity. |
| FR-008 | Surface opposite-direction conflict. | Buy and sell proposals for the selected symbol produce `CONFLICT` and zero order dispatch until an owner-authorized defer or revision resolves it. |
| FR-009 | Apply explicit risk mandates. | A buy-inhibit mandate blocks new buys within its scope and expiry, with an explanation; it never generates a sale or silently changes approved allocation. |
| FR-010 | Reserve capital atomically. | Concurrent intents cannot reserve more than the applicable authorized and reconciled asset capacity. Reservation includes verified cumulative debit/fee/rounding bounds and explicit per-strategy asset caps. |
| FR-011 | Construct a real compatible plan. | Combined same-side plans meet current exchange quantity/notional filters and the strictest compatible limit. Invalid or dust-only deltas receive an explicit disposition. |
| FR-012 | Freeze allocation before approval. | Participant order and quantities use a documented stable FIFO key, with a deterministic tie-breaker. Allocation cannot change after approval or favor an agent after fills are known. FIFO is disclosed priority, not a pro-rata fairness guarantee. |
| FR-013 | Bind approval to exact execution. | Changes to account, epoch, participants, revisions, quantity, price, fee policy, allocation, or expiry invalidate approval. Owner permission cannot authorize a materially different plan. |
| FR-014 | Persist before dispatch. | A crash at any dispatch boundary leaves a recoverable attempt and correlation identity; restart cannot treat an uncertain attempt as a new request. |
| FR-015 | Preserve execution ambiguity. | Timeout or ambiguous failure shows `UNKNOWN`; dependent capital stays reserved until authoritative reconciliation resolves it. A fresh client order ID is not used as a blind retry. |
| FR-016 | Allocate only actual fills. | Deduplicated authoritative fills are applied once to remaining FIFO allocations. Each strategy receives actual filled quantity, price attribution, and exact fee-asset allocation under the documented rounding rule. |
| FR-017 | Complete partial and terminal reconciliation. | Partial IOC execution allocates only filled quantity; terminal unfilled quantity releases only its unused reservation. The current target may remain unmet without automatic reapproval. |
| FR-018 | Detect and quarantine drift. | Unmatched orders, fills, balance movement, account reset, and inconsistent source history stop affected writes and produce an evidence-linked incident. |
| FR-019 | Recover through evidence. | An incident can be resolved only by recorded source evidence and allowed transitions. A user clicking “resolved” cannot manufacture a fill, terminal status, or available balance. |
| FR-020 | Expose a modern operational console. | Owner can inspect intent, capital, plan, approval, execution, and recovery with keyboard access and responsive layouts; every state has a visible environment and freshness cue. |
| FR-021 | Provide auditable integration surfaces. | Authorized API, agent proposal interface, CLI, and exports use the same domain rules; unauthorized cross-account access is rejected; secrets never appear in evidence exports. |
| FR-022 | Preserve event provenance. | Every displayed fill/allocation/approval can be traced to a durable record, source identifier, observed time, and account epoch; duplicate transport events do not duplicate accounting. |
| FR-023 | Exercise actual boundary failures. | Release proof combines real testnet simultaneous proposals, response loss after dispatch, process restart, and out-of-band drift with deterministic terminal partial-IOC tests; fixture and real-venue evidence are labelled separately. |
| FR-024 | Ship an operable installation. | A fresh documented install can migrate, start, connect to a verified testnet account, run the complete journey, export evidence, and stop/restart without losing unresolved commitments. |

## 8. Accounting and planning rules

Quantities are exact decimal or scaled-integer values with asset identity. Never add BTC, USDT, and BNB into a single conservation equation. Fiat-marked portfolio value is a separate estimate with an explicit price source and timestamp.

For each asset, the internal ledger records opening assignments, reservations, settled fill movements, actual fees, explicit owner reallocations, and unresolved external differences. Owner-approved budgets are authority limits; a venue snapshot is corroborating capacity evidence, not sole spending authority.

Unassigned assets, fee reserves, and unresolved differences must remain named ledger buckets. They are not silently distributed to strategies. A reservation is an encumbrance on a claim, not newly created capital.

Authoritative gross base fills are allocated FIFO against the immutable approved schedule. Fees are recorded in the actual fee asset. Final quote/fee attribution uses the TDD's deterministic constrained rounding over complete fill evidence, preserving exact source totals and approved strategy debit caps. Provisional cost allocations are not spendable. Missing evidence or an infeasible cost/fee allocation prevents final reconciled status; no strategy silently funds another's rounding or fees.

The sellable quantity of a strategy is its confirmed available base claim after existing reservations. An absolute target below that claim may propose selling only its own inventory. No target, mandate, or coalesced order transfers another strategy's ownership claim implicitly.

An IOC order can expire without fills or partially fill before terminating. An unfilled remainder does not automatically become a new approved order. A later replan requires current revisions, quantities, constraints, account state, and approval.

An approval expires and becomes invalid on relevant change. Approval and required host confirmation may happen at different times; the executor must revalidate the approved digest and current eligibility immediately before dispatch.

> **Amended by ADR-0003.** The approval also binds an absolute `submissionDeadlineAt`: the
> latest instant at which an order may take economic effect. The signed request is frozen at
> the dispatch marker and the sending path cannot re-sign, so a worker that pauses across the
> deadline has its request rejected by the venue rather than executed late. The owner is
> consenting to a deadline, not to an open-ended authorization that a paused process can
> revive.

## 9. First complete release versus later expansion

| First complete release | Later direction; not required for release |
|---|---|
| One owner/account, one selected Spot symbol. | Multiple selected symbols after quote-capacity coordination is proven. |
| Absolute targets, owner budgets, compatible same-side IOC coalescing, explicit opposite-intent conflict. | More order types and scheduling policies with separately specified semantics. |
| Durable reservation, approval, dispatch, fill attribution, drift recovery, evidence export. | Additional exchanges and deeper platform integrations. |
| One verified execution mode, real testnet proof, visibly gated live capability. | Supported managed Agentic execution when authenticated contract tests prove it. |
| Operational web console and proposal SDK/interface. | Organization administration and enterprise operational features. |
| A repeatable installation, monitoring, recovery runbook, and validation report. | Commercial packaging informed by paid pilots. |

Multi-owner custody, pooled client money, internal crossing, leverage, or derivatives require a distinct product and trust-model decision. They are not background items to quietly add while implementing this document.

## 10. Non-functional requirements

| Area | Release target |
|---|---|
| Correctness | All named invariants and high-risk recovery scenarios in `TEST-PLAN.md` pass; duplicate dispatch, double allocation, or unauthorized overspend blocks release. |
| Durability | Restart at every persisted state boundary produces a valid replay/recovery path. No correctness-critical state exists only in worker memory or UI state. |
| Performance | On the documented reference environment, proposal validation and plan preview p95 under 1 second for 10 strategies and 100 queued intents, excluding exchange latency; benchmark conditions published. |
| Read freshness | Views display source age and synchronization state. A configurable freshness threshold blocks dispatch when necessary evidence is too old. *(ADR-0009: four named freshness classes, each requiring a configured maximum age with no default; a missing value refuses startup rather than choosing how stale evidence may be before it authorizes a trade.)* |
| Concurrency | One account's reservation and execution races are serialized or transactionally protected; parallel workers cannot create different active ownership of the same commitment. |
| Accessibility | WCAG 2.2 AA target: keyboard-complete owner journey, visible focus, non-color statuses, minimum 4.5:1 normal-text contrast, and reduced-motion support. |
| Responsive UX | Usable at widths 375, 768, 1024, and 1440 pixels; no page-level horizontal overflow. Wide detailed tables may use a labelled, bounded scroll region. |
| Security | Credentials confined to the execution boundary; authenticated and authorized mutation endpoints; sensitive fields redacted from logs and exports. |
| Operability | Readiness distinguishes dependency health from safe-to-execute state; logs link account/plan/attempt without secrets; unresolved orders have actionable alerts. |
| Reproducibility | Build version, migration version, configuration fingerprint without secrets, integration mode, and test evidence accompany a release. |

Performance numbers are implementation targets to measure, not current product claims. Throughput never overrides the correctness boundary.

## 11. Acceptance journey and judge demonstration

Use one real Binance Spot testnet account and two proposal agents sharing the selected base asset. Establish and visibly inspect the baseline, strategy claims, and budget limits. Agent OS can provide the proposal/research path if its execution integration remains conditional.

First, submit opposite-direction targets. The console must show why the proposals conflict, exactly whose claims are involved, and that no order was dispatched. Defer or revise one target through an owner action.

Next, submit compatible same-direction targets and show atomic reservation, strictest limit, and the fixed FIFO schedule. Obtain actual plan approval. Submit a real IOC order through the verified executor.

Inject response loss after the request reaches the venue boundary and restart the worker. The console must show uncertainty, retain reservations, and recover the existing attempt through real exchange order/trade evidence without blind resubmission. Allocation and actual fees must reconcile to that evidence.

Finally, create an explicitly authorized out-of-band testnet account change and demonstrate drift quarantine. The owner can inspect the difference and reconcile a new valid state. Show an evidence export containing IDs and sources for the complete journey.

Do not force a live venue to produce an unreliable partial fill for presentation. The test suite must exercise partial fills with deterministic contract fixtures; a real venue partial-fill capture is additional evidence and should be labelled accurately. The complete demo still uses real orders for the execution and recovery boundary.

## 12. Validation, success, and kill criteria

Technical release success requires the first real journey above, the critical tests, a fresh-install reproduction, and zero unresolved critical accounting or execution defects. Passing these gates proves the defined implementation behavior, not commercial demand.

Pilot entry requires three operators who actually use overlapping strategies, at least one reproduced or inspectable coordination incident, and a clear reason sub-accounts or single-strategy asset ownership are insufficient. Seek one paid pilot with a written problem statement and measurable operational acceptance before widening scope.

Pilot measurements: conflicting intents detected before dispatch; time from ambiguity to authoritative resolution; manual reconciliation time; unassigned or unresolved ledger quantities; user-approved plans completed correctly; and number of unnecessary blocks. Do not optimize for trading volume, speculative P&L, or automatic approvals.

Change direction if every qualified operator prefers sub-accounts, no owner accepts exclusive credential routing, actual integration cannot correlate submissions with authoritative fills, or a hosted Agentic route cannot support the required confirmation and evidence contract. Proposal-only behavior may remain a tool, but must not be sold as enforced coordination.

## 13. Implementation handoff

Use `TDD.md` as the implementation contract and `TEST-PLAN.md` as the release evidence contract. `IMPLEMENTATION-PLAN.md` establishes dependency order; individual files under `prompts/` are bounded implementation work sessions.

Before writing code, record conflicts between those documents and this PRD. Resolve them explicitly; do not make a silent architectural assumption inside one module. Every requirement above should map to a test, an implementation module, and an observable owner-facing outcome.
