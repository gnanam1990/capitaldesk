# CapitalDesk — Adversarial Test Plan

Status: implementation specification; no tests or live integrations have been executed for this document.

Read alongside `PRD.md`, `TDD.md`, `IMPLEMENTATION-PLAN.md`, `UI-UX.md`, and `SOURCES.md`. If those documents disagree on a money or authorization boundary, record the conflict and stop that implementation slice until the contracts agree. Tests refer to invariant descriptions rather than unstable numbering.

## 1. Scope and proof standard

The release under test serves one beneficial owner, one Binance SPOT account, and multiple untrusted strategy agents. Agents propose absolute `targetBaseQtyAtoms` values with explicit asset scale and monotonically increasing revisions. Version one dispatches only LIMIT IOC orders. No leverage, derivatives, customer pooling, cross-symbol aggregation, internal crossing, virtual fills, or automatic compensating trades are supported.

Same-side compatible proposals may coalesce. Opposing directions enter `CONFLICT`; the owner revises or defers them. Fixed FIFO allocation is ordered before approval. All ownership changes must derive from actual exchange fills or an explicitly classified external event; a proposal, approval, reservation, or internal book entry is not a fill.

Three evidence classes stay separate:

- **Unit/property:** deterministic reference models, generated cases, and mocks are permitted and labelled.
- **Integration:** actual PostgreSQL, production ledger code, and independently scheduled processes exercise transactions, contention, restart, and persistence.
- **External proof:** actual Binance testnet interaction through the production adapter. A local fault proxy may interrupt transport after a real exchange action. Fake exchange success cannot satisfy this class.

Passing tests establishes tested behavior at the recorded commit and configuration. It does not establish profitability, uninterrupted protection, universal exchange availability, or coverage for untested account modes.

## 2. Test-driven delivery contract

For each feature, write a failing behavior test, record why it fails, implement the smallest coherent change, and refactor with the behavior suite still green. Existing behavior may require a characterization test first. Do not turn a failing expectation into a weaker contract to obtain green output.

Every money or dispatch change needs a falsifiable negative case. Tests must assert durable database state and observed venue requests, not merely a returned status. A rejection must prove that no unauthorized exchange request was sent.

Use independent calculation oracles for conservation, fees, and allocation. Do not compute expected results by calling the same production helper being tested. A property that repeats the implementation formula does not independently validate it.

Record seeds for randomized cases. Minimize and retain any failing counterexample. Test names must describe the violated behavior, not the function name alone.

## 3. Required fixtures and environments

Use exact integer units or exact decimal strings resolved against verified asset precision. No binary floating-point money calculation is permitted, including fixture generation and assertion tolerances. Token precision and exchange filters are versioned inputs, not guessed constants.

The integration environment contains actual PostgreSQL, at least two independent worker processes, two independent database connections, a controllable clock boundary, and a fault proxy. Use barriers/latches to force contention; a sleep and one lucky interleaving are not a concurrency proof.

Fixtures include SPOT asset balances, free/locked observations, symbol/filter versions, pagination cursors, order/fill/commission records, account identifiers, testnet epochs, policy versions, approvals, and redacted transport transcripts. Preserve both raw provider records and normalized facts.

Every proof artifact records commit, dependency lockfile digest, database migration version, adapter mode, account pseudonym, epoch, symbol, timestamp, scenario, observed requests, and outcome. Never record credentials or full authentication headers.

## 4. Golden partial-fill example

Opening account control is `1000 USDT`. Allocate `500 USDT` to strategy A and `500 USDT` to B; HOUSE starts at zero for this example. A targets `0.01 BTC`; B targets `0.02 BTC`. Their compatible BUY limit is `20000 USDT/BTC`. A precedes B in the approved FIFO order.

With an illustrative explicit quote-fee ceiling of `0.1%`, reserve up to `200.2 USDT` for A and `400.4 USDT` for B before dispatch. This ceiling is fixture policy, not a claim about the current account's fee schedule. The approved order requests `0.03 BTC`.

The exchange actually fills `0.02 BTC` at `19900`, spending `398 USDT`, and reports a commission of `0.398 USDT`. The remaining `0.01 BTC` expires unfilled. Once terminal status and complete paginated fill/commission evidence are proven, FIFO assigns `0.01 BTC` to A and `0.01 BTC` to B.

Each strategy's actual quote cost is `199.199 USDT`. Final balances: A owns `300.801 USDT + 0.01 BTC`; B owns `300.801 USDT + 0.01 BTC`. Account totals are `601.602 USDT + 0.02 BTC`. Neither the unfilled claim nor its reservation becomes owned BTC. Residual reservations release only after evidence completeness is established.

This exact fixture is deterministic test evidence. A live testnet run must report the fill quantities and commissions actually observed; it must not manufacture this partial fill for the video.

## 5. Intent, approval, and dispatch eligibility

### T-001 — Absolute targets do not become repeated buys

Given A already owns `0.01 BTC`, replay its unchanged target of `0.01 BTC`, serialized as integer atoms at the fixture's explicit scale, with a valid unchanged revision. Assert no additional buy, reservation, or ownership increase. Target calculation uses A's attributable raw units, not the entire account balance.

### T-002 — Monotonic revisions and conflicting replay

Accept a higher revision once; reject lower revisions. An exact replay returns its durable prior disposition; reuse of the same revision with different content is a conflict. Simultaneous conflicting submissions must not both become current.

### T-003 — Stale pending proposal supersession

Replace an unapproved target while another worker reads it. Assert only the winning revision can enter an approval plan. A superseded proposal cannot regain eligibility after restart or delayed queue delivery.

### T-004 — Same-side compatibility boundary

Coalesce only intents whose symbol, side, limits, fee policy, and other required execution constraints are compatible under the frozen policy. Mixed accounts, epochs, symbols, or incompatible limits produce an explicit rejection/conflict, never a silently broadened order.

### T-005 — Opposite sides never internally cross

A requests BUY while B requests SELL on the same symbol. Assert `CONFLICT`, no venue request, no virtual fill, and unchanged owned balances. Owner deferral or a new target revision is required to create a dispatchable plan.

### T-006 — Approval binds the complete plan

Mutate allocation order, strategy revision, symbol, side, quantity, limit, fee ceiling, account, epoch, policy version, inventory version, or expiry after approval. Assert the old approval cannot authorize the changed plan. No field may be silently repaired under an old approval.

### T-007 — Expiry at the dispatch boundary

Approve before expiry, block the worker, advance the clock past expiry, then release it. Assert the atomic eligibility check refuses dispatch and persists a reason. Test exact-boundary comparisons and database/application clock disagreement.

### T-008 — Policy or inventory changes after approval

Race approval with owner budget reduction, agent revocation, an external fill, or a policy update. Dispatch must atomically revalidate the approved economic versions and current eligibility. Changed bound fields or incompatible evidence require a new plan/approval. A newer read-only snapshot that proves the same account state may refresh freshness without changing the approved payload; test that distinction explicitly.

### T-009 — Fixed FIFO cannot be reprioritized

Shuffle proposal arrival, database retrieval order, worker scheduling, and UI sorting after approval. Assert actual fills follow the approved FIFO order. No worker may promote its own strategy or use best-effort arrival time as allocation authority.

### T-010 — Unsupported actions cannot escape through adapters

Submit MARKET, GTC, futures, margin, cross-symbol bundles, transfers, withdrawals, and compensating trades through every public API, agent tool, and worker entry point. Assert structured refusal before adapter dispatch, including malformed and unknown enum values.

## 6. Ledger, reservations, and allocation

### T-011 — Opening baseline ownership is explicit

Import an account with balances and prior orders. Require a versioned baseline that distinguishes included assets, excluded history, HOUSE claims, and unresolved ownership. Never allocate unknown inventory to a strategy merely because its symbol matches.

### T-012 — Per-asset conservation through every transition

For reserve, dispatch-unknown, fill, commission, terminal completion, quarantine, and release, assert account asset-control units equal strategy available + reserved + quarantined claims plus classified HOUSE claims for each asset. A balancing plug is a test failure.

### T-013 — Account quota contention in PostgreSQL

Two workers simultaneously reserve against the same account and asset using independent connections. Force both to read the same opening availability. Assert committed reservations remain within the account and strategy bounds; inspect both transactions and dispatch counts.

### T-014 — Golden partial fill and expiry

Execute the example in section 4 through the real ledger/reconciler with actual PostgreSQL. Assert every intermediate reservation, fill allocation, commission debit, final raw asset total, and released remainder exactly matches the independent fixture.

### T-015 — FIFO spans multiple actual fills

Supply several fills at different prices and fees where one fill completes A and starts B. Assert FIFO capacity consumption, actual cost attribution, and deterministic dust/rounding policy. Aggregate allocated base, quote, and commissions must equal source totals exactly.

### T-016 — Fee charged in quote, base, and BNB

Run distinct fee-asset fixtures. Debit the asset actually reported; base-denominated commission reduces net base ownership, and BNB commission reduces explicitly authorized BNB claims. Do not translate every fee into USDT or report gross base as net ownership.

### T-017 — Unsupported or unowned fee asset

Return a commission in an unsupported asset or BNB without an authorized fee source. Preserve the raw fact, quarantine affected allocation, and block new activity as policy requires. Never fabricate a balance, negative invisible ownership, or HOUSE adjustment to force conservation.

### T-018 — Fee exceeds the approved reserve bound

Return actual fees above the approved assumption. Preserve observed financial facts; quarantine the discrepancy and refuse new exposure. Do not reject or discard the fill because reality exceeded the plan, and do not retroactively change the approved fee limit.

### T-019 — Decimal boundaries and exchange filters

Generate tiny/large quantities, maximum precision, minimum notional boundaries, and tick/lot changes. Assert exact arithmetic, explicit rounding direction, and refusal where a legal IOC cannot fit the budget. Never round an order up past an approved quantity or amount.

### T-020 — Strategy ownership stays separate

Give A and B distinct attributable BTC claims. A reducing its target cannot sell B's claim or count another strategy's internal reclassification as its own market disposal. No internal transfer between strategies may masquerade as a sale or fill.

### T-021 — Reservation lifetime requires complete evidence

Observe terminal status while one fill or commission page remains unavailable. Assert reservations remain held and ownership is not finalized. Completion requires terminal order evidence plus a demonstrated complete fill/commission retrieval for that exact order identity.

### T-022 — Duplicate, reordered, and corrected provider records

Deliver identical fills through websocket and repeated REST pages in varying orders. Assert one economic effect. A same-identity record with conflicting content becomes a discrepancy requiring resolution; it must not overwrite an already applied fact silently.

### T-023 — Property-based money-state exploration

Generate valid and invalid transitions, duplicate deliveries, restarts, fee assets, partial fills, and approval invalidations. Assert per-asset conservation, no negative spendable claims, no virtual fills, and deterministic replay. Retain minimized failures as regression fixtures.

## 7. Crash consistency and uncertain execution

### T-024 — Durable marker precedes all sends

Intercept every network dispatch path. Assert its dispatch marker and client identifier are durably committed before the first byte is sent. Force transaction failure and verify zero exchange requests, including retries and recovery paths.

### T-025 — Kill after marker, before send

Kill the broker after marker commit but before network send. Restart with a new lease owner. Assert the operation is `UNKNOWN`; neither automatic takeover nor automatic send occurs. Keep its reservations held pending the approved resolution process.

### T-026 — Exchange accepted, response lost

Use a real testnet order and drop the response in the local fault proxy after forwarding. Assert `UNKNOWN`, no blind resubmission, and reconciliation against the exact account/epoch/symbol identity. Capture downstream request count and independently fetched order/fill evidence.

### T-027 — Lease expiry does not fence the exchange

Pause worker A after its authorization check; allow its lease to expire and worker B to acquire a lease. Resume A. Assert lease turnover cannot authorize B to duplicate an uncertain send; the dispatch journal still owns resolution. Include late response delivery from A.

### T-028 — Client identifiers are not lifetime idempotency

Complete an order, then replay an old request/client ID in a fixture where the exchange would accept reuse. Assert the local durable operation identity still blocks a second dispatch. Provider acceptance rules must not substitute for application lifetime replay protection.

### T-029 — A single NOT_FOUND cannot release or retry

Return NOT_FOUND once, then reveal an accepted order/fill on a later query. Assert the first response causes no re-send, reservation release, or final rejection. Exercise delayed visibility and failed query paths independently.

### T-030 — Crash during allocation commit

Kill between raw record persistence, allocation calculation, and ledger transaction commit. Reconcile on restart and assert the entire economic transition occurs once. Rollback must leave a replayable fact, not a partly allocated commission or orphan claim.

### T-031 — Order identity includes account, epoch, and symbol

Reuse an order ID across symbols, accounts, and epochs; reuse a trade ID outside its intended identity scope. Assert no cross-link, deduplication collision, or incorrect commission attribution. Queries and unique constraints must enforce the full identity.

### T-032 — Testnet reset invalidates the epoch

Simulate reset detection followed by reused order IDs and changed balances. Assert prior approval, dispatch eligibility, snapshots, and order correlations cannot cross into the new epoch. Require a fresh baseline/reconciliation; never reinterpret old test funds as current holdings.

### T-033 — Cancel/expiry races with late fills

Deliver cancel acknowledgment or IOC expiry before late-arriving fill evidence. Reconciliation must consume actual executed quantity, allocate its fees, and release only the proven remainder. Cancellation success must never mean zero execution by assumption.

### T-034 — Pagination proves coverage

Exercise multiple pages, duplicate boundary rows, empty intermediate pages, rate limits, cursor expiry, and truncated windows. Assert completeness is false until the adapter's documented coverage conditions hold; a successful first page is insufficient.

### T-035 — Restore starts in reconciliation mode

Restore an older database backup while the venue has later fills. Assert all writes remain disabled until the account, epoch, orders, fees, and ownership are reconciled. Recovery must not replay an old outbox, reuse stale approvals, or manufacture missing history.

## 8. Credentials, account boundaries, and operational drift

### T-036 — Untrusted agent cannot obtain broker credentials

Attempt reads through environment, filesystem, tool metadata, process arguments, debug endpoints, logs, error serialization, and injected prompts. Assert agent identity has no credential material or direct broker execution capability. Document the actual process/OS boundary tested.

### T-037 — Direct bypass is contained by the execution boundary

From the agent sandbox, attempt direct Binance HTTP, official CLI invocation, broker IPC, forged approval, and alternate tool dispatch. Assert no authenticated write succeeds. If credentials or host permissions make a bypass possible, fail the enforcement claim and release gate.

### T-038 — Broker-key and approved-host modes never mix

Use distinct account/mode identifiers and journals for broker-key versus approved MCP-host execution. Try cross-mode approvals, lookups, cached balances, and dispatches. Assert mismatch refusal. A UI label alone cannot establish account or environment identity.

### T-039 — MCP native confirmation remains required

In approved-host mode, give CapitalDesk a valid owner approval but deny or omit the host's native confirmation. Assert no write occurs and no success is recorded. Approval in CapitalDesk does not bypass or stand in for Binance/host confirmation.

### T-040 — Owner authorization and agent revocation

Expire the owner session, revoke an agent, or change its policy while a request is queued. Assert fresh dispatch eligibility observes the change. Read access, proposal rights, owner approval, and broker execution rights must have independent negative tests.

### T-041 — External orders and balance drift

Place or import an external manual order, transfer, or fill outside CapitalDesk. Assert drift is visible, new exposure pauses where attribution is unresolved, and current reservations are not freed from a misleading free-balance observation. No automatic compensating trade occurs.

### T-042 — Baseline exclusions remain visible

Exclude pre-baseline history or unsupported assets deliberately, then request totals and performance. Assert coverage disclosures remain attached to exports and UI. An incomplete starting cost basis cannot yield a confidently complete P&L or strategy ownership claim.

### T-043 — Rate limits, degraded reads, and authentication expiry

Compete reconciliation and read requests against the same account quota; inject 429, timeout, expiry, and permission errors. Assert bounded retry/backoff, preserved reservations, explicit degraded state, and no new exposure from stale evidence. Recovery must not starve unresolved orders indefinitely.

### T-044 — Sensitive artifacts and diagnostics

Trigger parsing, provider, and database errors containing representative secrets. Assert logs, exports, screenshots, traces, and support bundles redact them. Preserve enough nonsecret correlation to reproduce the incident without exposing credentials.

## 9. Product UI and end-to-end acceptance

### T-045 — Honest plan-to-exchange journey

A fresh owner connects the supported mode, establishes baseline claims, accepts two compatible proposals, reviews FIFO/fees/limits, approves, completes any native confirmation, and inspects actual IOC results. Assert no hidden database edits, manual fixture swaps, or hard-coded success state.

### T-046 — Financial states remain distinguishable

Check proposed, conflict, approved, reserved, dispatch-unknown, partial, evidence-incomplete, quarantined, and reconciled views. Pending claims cannot look owned or spendable. Show actual fee asset and gross versus net received quantity where relevant.

### T-047 — Recovery is understandable and bounded

From an UNKNOWN or incomplete incident, use the user-facing reconcile action and inspect its result. Explain what is known, missing, held, and permitted next. A Retry label must never hide a fresh order submission or imply that NOT_FOUND proves failure.

### T-048 — Responsive and accessible operation

Verify widths 375, 768, 1024, and 1440 with real long IDs, asset symbols, and amounts. Check keyboard-only completion, visible focus, semantic labels, contrast, reduced motion, screen-reader status announcements, and no color-only financial state. Approval details must remain readable without clipped limits.

### T-049 — Complete asynchronous UI states

Exercise loading, empty account, partial history, disconnected service, denied permissions, expired approval, conflicting revision, rate limit, and backend failure. Disable only actions actually unavailable; preserve inspectable evidence and explain recovery. Reconnect must not double-submit.

### T-050 — Independent evidence export

Export a completed and an unresolved operation. Verify each export binds plan/approval versions, FIFO, environment, identity, raw fills, commissions, and completeness status. Recalculate the golden result independently from export data and compare exact totals.

## 10. Release and reproducibility gates

### T-051 — Migration and restart preserve unresolved liabilities

Upgrade a database containing reserved, UNKNOWN, partial, and quarantined operations. Assert approvals retain their original meaning, journal identities do not change, and no migration marks incomplete evidence complete. Repeat with a stopped worker resuming old queue messages.

### T-052 — Mutation tests challenge the actual boundaries

Deliberately remove account scoping, reverse FIFO, drop a fee, use floats, release on terminal alone, allow approval-version mismatch, or permit UNKNOWN resend. The targeted suite must fail for the intended reason. Record survivors as uncovered behavior, not a passing safety score.

### T-053 — Clean-room testnet proof

From a clean checkout and fresh supported account baseline, run the normal product path, restart the worker, and run the dropped-response scenario. Record real order/fill evidence and transport count. If authorization, testnet, or partial-fill coverage is unavailable, label that proof blocked/unproven rather than substituting a mock.

### T-054 — Release report is bound to the tested build

Change the commit, migration, adapter mode, fee policy, or account epoch after evidence capture. Assert release tooling marks the affected proof stale. The final report separates passing tests, blocked external proofs, known limitations, and untested production behavior.

## 11. Additional reviewed correctness regressions

### T-055 — Repeated rounding cannot overdraw a strategy cap

Use FIFO approved gross base allocations A=3, B=3, C=8, D=3, E=3 atoms. Two authoritative fills each consume 10 base atoms and cost 1 quote atom. C receives 4 base atoms in each fill; independently awarding its largest remainder twice would debit 2 quote atoms despite its approved cumulative gross-cost ceiling of 1. The batch controlled-rounding solver must conserve both source quote rows, preserve base FIFO, and keep C's debit <=1. Every cell is floor/ceil of its exact proportional share and cumulative columns respect their floor/ceil bounds. Reordered transport yields identical final cells. Test BUY quote cost plus quote commission sharing one cap, no feasible allocation, partial source rows, and unknown venue cumulative rounding semantics. Infeasibility preserves source evidence and quarantines; it never increases a cap or borrows HOUSE. Compare small generated matrices with an independently enumerated feasible-allocation oracle.

### T-056 — One stable account cannot bootstrap twice

Race two workspaces/pools attaching different credentials or aliases for the same authenticated venue account. Assert one active governance lease across the registry and only one claim bootstrap. Rotate a key and keep the identity unchanged. Unknown stable identity blocks governance. Closing a pool or resetting an epoch with an UNKNOWN liability cannot free the lease for a new account baseline. Document the limitation for independent deployments without a shared registry.

### T-057 — Fully filled BUY can leave a net target unmet

Fixture owned base=0, target=1000 base atoms, approved gross BUY=1000. A full fill charges 1 base atom commission. Assert gross order COMPLETED only after financial reconciliation, net base=999, intent PARTIAL with residual1, exact quote debit and no automatically created second order. Commission cannot be attributed above the explicit cap or above acquired base without authorized funding. UI/export must expose gross/net and source fee separately.

### T-058 — SELL quantity includes base commission before admission

Fixture owned base=2000, target=1000, lot step1, verified fee bound=1 base atom for any nonzero permitted execution. The largest admitted gross sale is999, not1000. A full sale with fee1 leaves net1000 and SATISFIED; actual fee0 leaves net1001 and PARTIAL. Test partial fill600 plus fee1 leaves1399. Gross order status and intent satisfaction remain separate, all asset posting signs follow the BUY/SELL matrix, and no replan is automatic. A fee above the verified bound preserves the actual observation and quarantines the checkpoint without debiting another strategy.

## 12. Proposed command and evidence contract

The commands below are proposed implementation interfaces. They are not existing commands, nor claims of successful execution. The implementation plan may choose equivalent names, but must preserve independently runnable layers and explicit environment selection.

```sh
pnpm test:unit
pnpm test:property -- --seed 20260908
pnpm test:integration -- --project postgres-concurrency
pnpm test:integration -- --project crash-recovery
pnpm test:security -- --project credential-boundary
pnpm test:e2e -- --project responsive-accessibility
pnpm test:mutation -- --scope capital-ledger-dispatch
pnpm proof:testnet -- --scenario approved-ioc --account-alias capitaldesk-proof
pnpm proof:testnet -- --scenario response-lost --account-alias capitaldesk-proof
pnpm proof:verify -- --bundle artifacts/proofs/latest
```

Live proof commands require the user's explicitly authorized account and testnet setup; they must display the resolved mode/account before any order. They must never silently fall back to production. No command here authorizes a mainnet trade or hackathon submission.

Expected artifacts: machine-readable test results; failing/passing regression evidence; recorded property seeds; schema/migration versions; redacted request transcripts; source order/fill/commission records; independent ledger calculations; responsive/keyboard evidence; and one version-bound proof manifest.

Release is blocked by any unresolved duplicate dispatch, unauthorized write, lost commission, unaccounted asset unit, silently changed approved plan, cross-account/epoch correlation, premature reservation release, or fake external proof. Passing local tests cannot waive a blocked real-integration claim.
