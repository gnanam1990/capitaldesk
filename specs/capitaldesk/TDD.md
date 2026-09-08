# CapitalDesk — Technical Design Document

Version 1.1, amended 8 September 2026. Proposed architecture; no runtime implementation or security audit is claimed.

> **Amended.** Sections 2, 3, 6, 7, 8, 9, 10, 11 and 13 carry amendments resolving review findings F1-F10. Each is marked inline and indexed in [AMENDMENTS.md](AMENDMENTS.md). The original reviewed text is preserved in git history at commit `c68137e`.

## 1. System contract

The first complete release supports one beneficial owner and one Binance **Spot** account per governed pool, one selected quote pair, multiple proposal agents and exact per-strategy inventory attribution. Multiple pools can exist in a workspace but never share funds, locks or economic orders; an account/environment may have only one active governed pool. Production writes require a verified execution mode and release approval; initial end-to-end execution uses actual Spot Testnet orders.

Supported physical order: **LIMIT IOC**, subject to live symbol capability/filter verification. Partial execution is a normal result. No market orders, leverage, short inventory, automatic residual resubmission, cancel-replace, persistent protective orders, internal crossing, derivatives or cross-symbol aggregation in v1. These are product scope decisions, not claims Binance lacks those features.

Absolute strategy targets are distinct from orders. Several compatible BUYs or SELLs can share one physical order. Opposing directions return CONFLICT; owner revision/defer is required. A strategy cannot sell inventory belonging to another strategy. A mandate can block risk increases; it cannot silently transfer another strategy's ownership or liquidate its holdings.

## 2. Proposed stack and repository

Use TypeScript with pnpm workspaces, Fastify, PostgreSQL, Next.js App Router/React, JSON Schema/OpenAPI, Vitest, fast-check and Playwright. These are explicit architecture choices, not a detected CapitalDesk checkout. Pin current supported compatible versions at Prompt 01 and commit a lockfile. Do not copy version numbers from another project without testing.

```text
apps/
  api/                 owner/agent HTTP API; never holds Binance trading secrets
  worker/              ingest, reconciliation, durable jobs, exports, webhooks
  executor/            only component allowed to sign/dispatch venue orders
  web/                 console; server-mediated typed API access
packages/
  contracts/           wire schemas, canonical encoding, IDs and reason codes
  domain/              pure intent, plan, policy and state reducers
  ledger/              per-asset posting, reservations and fill allocation
  db/                  migrations, transactional repositories, outbox
  binance/             narrow read and write adapter interfaces
  planner/             deterministic target reconciliation and aggregation
  observability/       structured redacted logs/metrics/traces
  sdk/                 generated client plus safe convenience methods
  agent-tools/         proposal-only MCP tools and example agents
  fault-lab/           isolated test transport + scenario runner
docs/                  gate evidence, ADRs, runbooks, readiness and proof
specs/capitaldesk/     this specification pack
```

Dependencies: contracts → pure domain/ledger → transactional DB and narrow adapters → planner/services → applications. Web never imports executor, database or secrets. Enforce a mechanical dependency check.

> **Amended by ADR-0007.** The dependency check resolves every import to the workspace
> package owning the file on disk, so a relative path climbing into another package — or
> into its compiled `dist/` — is caught exactly like a package specifier. A `config` package
> holds the validated environment contracts; it sits alongside `observability` above
> `contracts` and below the applications. A queue notification is a hint; PostgreSQL is the authority for work and economic state. Redis is unnecessary for the first release.

## 3. Trust and execution modes

```text
untrusted agent -> scoped proposal API -> deterministic planner
                                              |
owner -> approval API -> sealed plan + reservations
                                              |
isolated executor -> verified Binance route -> actual exchange order
                                              |
read-only ingest -> observations -> fills + ledger -> reconciliation
```

### Mode A: broker-key testnet executor

An isolated process uses an existing explicitly configured Spot Testnet API credential through a pinned official connector/CLI adapter. The exact account belongs to this credential. Agent OS integration supplies actual proposal/orchestration tooling where verified. It does not make this account an Agentic OAuth sub-account. Event eligibility of the combination is a separate UNVERIFIED gate until supported by official terms.

The write adapter invokes an allowlisted command/method with typed arguments; never a shell string assembled from agent input. Credential profiles are immutable per environment and unavailable to proposal agents, API and web processes. If the chosen official SDK retries writes internally, disable that behavior or fail its gate.

### Mode B: supported Agentic MCP execution

Only enable when the actual approved host, authenticated schemas, exact order identity, account/fill observations and per-action confirmation can be proven. The current public guide requires user confirmation for orders, cancels and transfers. A CapitalDesk local approval is not a substitute for native confirmation. The native confirmed payload must match the sealed child order.

Do not share the execution-authorized host session with untrusted proposal agents. If the host exposes unrestricted trade tools to them or cannot bind the final call to the sealed order, the mode is OBSERVATION_ONLY. Never relabel a human-pasted order as controlled execution.

### Credential classes

> **Amended by ADR-0007.** Three separate secret classes with separate mounts:
> `VENUE_READ` (USER_DATA) into the worker's account reader only; `VENUE_TRADE` (TRADE)
> into the executor only; `OWNER_SESSION` into the API only. The console mounts none.
> Configuration carries a *reference* — a path or secret-manager URI — never a value, and a
> credential variable present in the wrong role is a startup refusal naming the variable.
> The read and trade credentials must resolve to the same stable authenticated account id;
> a mismatch blocks governance. Whether the configured account supports the split is an
> authenticated integration question and remains open.

### Enforcement limit

Process, credential and network isolation must prevent proposal agents from reaching execution credentials or a generic signing/RPC/shell escape. In a deployment where the operator runs everything under one unrestricted user, accidental process separation alone is not a security boundary. Use separate container users/mounts/service identities; production host administrators remain trusted.

Other owner-controlled exchange clients cannot be universally blocked. External orders/transfers cause a pool-wide quarantine in v1; claims resume only after explicit adjudication. A local kill switch prevents future governed dispatch, not orders already accepted by Binance.

## 4. Typed identities, precision and time

All quantities are canonical nonnegative integer atom strings in JSON, bigint internally and integer-constrained NUMERIC in PostgreSQL. Specify a maximum supported precision (for example 78 digits), reject overflow and nonintegral database values, and never coerce to JavaScript number. Asset scale comes from a pinned manifest plus verified exchange metadata; trading step size is not necessarily the asset's accounting scale.

```text
venueAccountKey = venue + environment + authenticatedStableAccountId
poolId = workspace + venueAccountKey + baselineEpoch
assetKey = venueAssetCode + verifiedScaleVersion
orderKey = poolId + symbol + venueOrderId
fillKey = poolId + symbol + venueOrderId + venueTradeId
strategyTargetKey = poolId + strategyId + symbol
```

Client order IDs are generated from the unique child dispatch ID, constrained to current documented format/length and unique in our database forever. Binance client-ID behavior is not treated as permanent deduplication: local history prevents reuse even after venue orders close. Testnet resets create a new baselineEpoch; identical venue IDs in different epochs are unrelated.

The account registry has one globally unique active governance lease per venueAccountKey across all workspaces/pools in the authoritative database. API-key fingerprints, aliases and rotated credentials are not account identity. Linking another credential for the same account returns its existing governance record or refuses attachment; it never bootstraps the same funds again. If a stable authenticated identity cannot be established, execution is unavailable. Epoch rotation retains the account lease until old liabilities resolve. Independent deployments not sharing this registry cannot enforce mutual exclusion; the owner must not govern the same account in both, and this remains an explicit deployment/trust limit.

Economic time is UTC. Keep source event time, ingestion time, decision time and sequence separately. IDs/time proximity are not a substitute for exact order correlation. A provider's delayed snapshot must never overwrite newer locally confirmed facts silently.

## 5. Core invariants

| ID | Required invariant |
|---|---|
| INV-01 | A proposal agent can never dispatch, sign or authorize a venue order. |
| INV-02 | Every ledger transaction balances independently per asset; BTC and USDT are never added as comparable quantities. |
| INV-03 | Strategy available/reserved/quarantined claims are nonnegative; reserved units have one owning reservation. |
| INV-04 | Account asset-control balance equals all strategy claims plus HOUSE claims per asset after every committed posting. |
| INV-05 | New reservations fit both internal spendable claims and freshly reconciled venue free capacity; locked venue funds are not counted twice. |
| INV-06 | A child order has exactly one immutable preapproved allocation list; allocations cannot be added after submission. |
| INV-07 | Allocated gross fill quantity and commission per asset sum exactly to the authoritative fill record. |
| INV-08 | Local approval binds the exact plan, allocation order, limits, source revisions and expiry; payload change requires new approval. |
| INV-09 | Dispatch identity and marker commit before network send; an ambiguous marker never automatically re-dispatches. |
| INV-10 | UNKNOWN, incomplete fills, stale snapshots and unexplained drift cannot release funds or admit affected new execution. |
| INV-11 | Same idempotency key/scope/body replays the same result; changed body produces a durable conflict. |
| INV-12 | A strategy cannot reduce another strategy's owned base quantity or use another strategy's reserved quote/fee asset. |
| INV-13 | Opposing intents are explicit conflicts, not imaginary trades, unstated internal transfers or cross-client netting. |
| INV-14 | Testnet, production and reset epochs cannot share economic identities, evidence or approval authority. |
| INV-15 | Terminal order status and complete financial accounting are separate; late evidence remains admissible without granting a resend. |
| INV-16 | Every projection rebuilds from immutable observations/postings; manual reconciliation never edits original evidence. |

Zero invariant violations is the correctness target. No financial amount is silently clamped to make these checks pass.

## 6. Ledger model

### Per-asset accounting

Maintain two sides of a double-entry control ledger:

- `ASSET_CONTROL(pool, asset)` — assets held at the exchange according to booked authoritative economic evidence.
- `CLAIM(pool, strategy|HOUSE, asset, partition)` — owner-attributed claim, with partition AVAILABLE, RESERVED or QUARANTINED.

For each asset a:

```text
A[a] = sum over owners and partitions C[owner,a,partition]
C[strategy,a,AVAILABLE] >= 0
C[strategy,a,RESERVED] >= 0
C[strategy,a,QUARANTINED] >= 0
```

Account asset-control and claim accounts have opposite posting signs; a journal transaction's signed amounts sum to zero **within each asset**. Never create a USDT credit simply to balance BTC. Valuation/P&L is a separate derived report and cannot fund reservations.

### Bootstrap and owner allocations

A first account snapshot is accepted only after account identity, no unknown live orders, supported assets and a bracketed observation boundary are established. Opening balances post to ASSET_CONTROL and matching HOUSE claims with bootstrap evidence. The operator allocates HOUSE claims to strategies through explicit ledger transfers; allocation does not move funds at Binance and is labelled internal budget allocation.

Pre-existing unrelated orders cannot be adopted automatically. Bootstrap either waits for owner resolution or remains read-only. A connected main-account read is never mixed into an Agentic pool baseline. New deposits require authoritative history or explicit reviewed baseline adjustment; they initially belong to HOUSE, not whichever agent notices first.

### Reservations

AVAILABLE → RESERVED is an internal claim transfer; it does not change ASSET_CONTROL. For BUY: reserve the verified cumulative gross quote-debit ceiling plus the supported quote-commission ceiling, within the explicitly approved maxQuoteDebitAtoms. The usual exact-quote fixture is ceil(limitPrice × requestedBaseQty) plus the fee ceiling; it is not a universal assumption about venue rounding. For SELL: reserve gross base quantity plus the validated worst cumulative base commission. Third-asset fees need explicit supported per-strategy fee claims/reservation; unsupported fee routing blocks dispatch.

> **Amended by ADR-0010.** A fee policy is a capability that can be disabled. Each declares
> whether a conservative cumulative debit bound has been proven for every permitted partial
> fill; an unproven policy refuses dispatch with `FEE_BOUND_UNPROVEN` rather than assuming a
> rate. The one initially enabled policy is `STANDARD_NO_BNB_V1`: commission in the received
> asset at the verified per-symbol rate, per-fill ceiling `ceil(rate x fillQuantity)`,
> requiring the account's BNB fee payment to be verified disabled. `BNB_DISCOUNT_UNPROVEN` is
> defined and disabled, because the documented BNB-insufficiency fallback changes the debited
> asset mid-order and has no proven bound. The golden example below uses
> `QUOTE_FEE_FIXTURE_V1`, which remains valid fixture policy and is refused outside the local
> environment.

The adapter must document a conservative cumulative debit/fee bound valid across all permitted partial fills, including venue-native precision/rounding. A quoted rate alone does not prove a bound if repeated fill rounding can exceed it. Bind each strategy's per-asset debit/commission caps and the allocation-algorithm version into approval. If no affordable supported bound can be established, refuse that fee policy before dispatch. Do not assume exchange quoteQty always floors. Base BUY fees may be deducted from the newly acquired gross base only within an explicit fee cap; they cannot consume another strategy's base. Quote SELL fees may consume that strategy's attributed proceeds within the approved cap; extra existing-claim funding requires an explicit reservation. Unfilled proceeds never back unrelated new orders.

Use the same account-wide lock for all claims, including fee assets. v1 rejects a second selected symbol; future multi-symbol support must retain account-wide base/quote collision protection. A frozen source balance does not turn unfilled SELL proceeds into BUY capacity. Snapshot `free + locked` is total balance, but only reconciled `free` can back new exchange lock requirements. Internal reservations and venue locked balance are mapped, not subtracted twice.

An unexpected larger/different-asset fee is preserved as evidence; create an unresolved fee incident and quarantine before spending further. Do not fabricate HOUSE credit, silently borrow from another strategy or discard commission. Unsupported raw facts can remain unapplied until reviewed; the last complete ledger checkpoint must be clearly marked incomplete.

### Actual fills and allocation

The approved allocation list is FIFO, ordered by persisted accepted-sequence then strategy ID then intent ID. This policy is visible before approval. It prioritizes earlier compatible intent, not fair pro-rata execution. Alternative fair allocation is a future version with new consent and tests.

Apply fills in stable exchange order (verified venue ordering key, generally trade ID within the scoped order), not WebSocket arrival order. Ingest out-of-order events into raw evidence and obtain a complete range before final allocation. Fast UI updates may show PROVISIONAL observations; their credit is not spendable until a reconciled checkpoint. Rebuild a provisional projection if an earlier fill appears.

For each gross base fill, consume remaining requested amounts through FIFO. These base allocations cannot change in response to costs or subsequent performance. Final quote/fee attribution waits for terminal status and complete fill evidence; earlier values are PROVISIONAL and never spendable. Do not independently apply largest-remainder rounding per fill: repeated rounding can exceed an individual approved debit cap.

Use controlled integer rounding over the complete fill-by-strategy matrix, preserving every original fill and price rather than replacing them with a cumulative average:

1. For each source quote/commission component r and strategy i, calculate the exact rational share x[r,i] = sourceAmountAtoms[r] × allocatedGrossBaseAtoms[r,i] / sourceGrossBaseAtoms[r]. No floating-point arithmetic.
2. Each cell must become floor(x) or ceil(x); zero-allocation cells stay zero. Every row must sum exactly to its source component. Each strategy column must equal floor or ceil of its cumulative rational share for that grouped asset/direction.
3. For each asset and posting direction, solve the residual integer-flow problem after subtracting cell floors. Row residuals are exact demands, fractional row-to-strategy edges have capacity one, and strategy-to-sink bounds enforce cumulative floor/ceil attribution and the approved remaining debit caps. Per-strategy fee-component intermediate nodes enforce individual commission ceilings before the shared strategy/asset sink; subtract already fixed floor amounts from every bound. Use a standard lower-bounded circulation reduction with integer capacities. Define deterministic node/edge order (scoped fill ID, component kind, approved strategy order) and pin the algorithm version; identical evidence must yield identical cells.
4. BUY quote cost and quote-denominated commission share one total quote-debit cap, not two independent allowances. Preserve component rows for audit. SELL base gross consumption reduces the remaining base fee cap. Attribute gross SELL quote credits before quote commissions; commission debit cannot exceed the explicitly permitted reserved claims plus attributed proceeds. BUY base commission cannot exceed its strategy's attributed acquired base and approved commission cap. Third-asset debits use reserved fee claims only.
5. Validate per-component commission ceilings and all resulting posting/target bounds before committing. If the constrained allocation is infeasible, preserve raw economic facts and quarantine the incomplete checkpoint. Never increase approval, borrow another strategy's claim or insert a HOUSE balancing plug.
6. Commit final fill allocations, ledger postings, checkpoint and eligible reservation release atomically. Finalized cells are immutable. A later contradictory source record is an incident, not permission to rewrite already-spent ownership.

Why this works: exact row sums admit a fractional residual flow; when cumulative caps cover the required shares, integral network-flow feasibility yields exact integer row totals within the column bounds. The solver explicitly checks tighter caps. This removes CapitalDesk's repeated-rounding error; it does not excuse a missing venue cumulative-debit bound or guarantee that arbitrary erroneous venue facts fit an approval.

Posting matrix for each strategy, using its final attributed amounts g (gross base), q (gross quote), fB (base commission), fQ (quote commission), fX (other fee asset):

| Side | Base claim/control change | Quote claim/control change | Other fee asset |
|---|---|---|---|
| BUY | +g − fB | −q − fQ | −fX |
| SELL | −g − fB | +q − fQ | −fX |

Actual asset changes are matched by equal claim changes with the ledger's opposite posting signs. Sell fees do not reduce a nonexistent acquired-base credit.

Do not round subledger fill allocations to the symbol's order step: internal claims may be smaller than an independently tradable order. Dust remains owned and visible. A later sale still must satisfy exchange filters. No synthetic dust disposal.

### Golden partial-fill example

```text
Opening: 1000 USDT, 0 BTC; allocate A=500 USDT, B=500 USDT.
A target 0.01 BTC; B target 0.02 BTC; BUY limit 20000 USDT/BTC.
Verified test fee ceiling 0.1% quote: reserve A200.2, B400.4 USDT.
Aggregate LIMIT IOC request: 0.03 BTC.
Actual fill: 0.02 BTC at 19900; gross quote398; quote fee0.398.
FIFO: A gross0.01/cost199/fee0.199; B gross0.01/cost199/fee0.199.
Final after terminal+complete-fill reconciliation:
  A: 300.801 USDT +0.01 BTC; B: 300.801 USDT +0.01 BTC.
  Account: 601.602 USDT +0.02 BTC. Remaining reservations released.
B's target remains unmet by0.01; no automatic second order.
```

Fee rate and price in this example are deterministic test inputs, not current Binance rates. Venue live tests record their actual outcomes.

## 7. Intent, mandate and planner

### StrategyIntent

Fields: intentId, poolId, strategyId, symbol, targetBaseQtyAtoms, maxBuyPrice/minSellPrice as typed fixed-point decimal, maxQuoteDebitAtoms, expiresAt, strategyRevision, policyVersion, idempotencyKey, createdSequence. Exactly one active target revision per strategyTargetKey. A new revision supersedes only unsealed intent; a sealed or dispatched predecessor requires explicit reconciliation/closure before replacement.

Delta is target minus that strategy's net owned base claim at the last eligible ledger checkpoint. Submitted but incomplete child orders block replanning the same pool in v1. This intentionally conservative one-in-flight-plan-per-pool rule prevents stale cash, cross-quote spending and duplicated target pursuit.

Targets describe net holdings, while orders request gross quantity. For BUY admit gross g <= target − owned; a base commission may leave a residual below target. For SELL let D = owned − target and admit gross g only when g + worstSupportedBaseCommission(g) <= D and the available-claim constraint holds. The fee bound must cover partial as well as full fills. Thus a supported sell cannot move net ownership below its target; lower fees or lot rounding may leave a residual above it. Do not round g up to remove that residual. SATISFIED means the exact net target is reached; no implicit tolerance or automatic residual order is allowed in v1.

> **Amended by ADR-0008.** Sealing binds `cohortClosedAtSequence`, the accepted-sequence at
> which candidates stopped being eligible, and it is part of the plan digest. Proposals
> arriving while a plan is sealed or in flight are accepted and recorded as
> `QUEUED_NEXT_COHORT`, never rejected. A new opposing intent invalidates a sealed but
> **unmarked** plan and releases its reservations; after the marker the plan is untouched,
> because the order cannot be recalled. Expired, superseded, deferred, unauthorized and
> zero-delta intents are excluded **before** opposite-direction evaluation, so an intent that
> has stopped participating cannot cause an account-wide denial.

### Mandates

Owner-configured per-strategy allocation limits, asset/symbol allowlists, max child quote notional, daily gross BUY notional, pool concentration bounds, price-data freshness, plan lifetime and optional owner risk-increase halt.

> **Amended by ADR-0009.** Concentration is
> `value(s,a) / sum over every owner and asset of value(o,b)`, valued in the pool's reference
> quote asset. HOUSE claims, fee assets and quarantined claims are all inside the
> denominator; excluding HOUSE would let unassigned inventory reduce measured concentration.
> The comparison is rational integer arithmetic, never a float. If any denominator asset has
> no reference price inside its freshness class, concentration is `UNCOMPUTABLE` and every
> risk-increasing action is blocked — it is never treated as zero. Freshness classes
> (`PRICE_SNAPSHOT`, `ACCOUNT_SNAPSHOT`, `SYMBOL_METADATA`, `VENUE_CLOCK`) each require a
> configured maximum age with **no default**; a missing value refuses startup. Eligibility
> uses venue `serverTime`, latency budgets use the local monotonic clock, reporting uses UTC. Limits are deterministic versioned policy; LLM confidence is not a permission. An agent cannot create a priority flag that overrides an owner risk mandate.

Daily gross budget = committed filled BUY notional + outstanding worst-case BUY reservations for the budget bucket. Pre-dispatch plans crossing the UTC boundary invalidate. Submitted orders retain their dispatch budget bucket until final, with next-day pool reservations still accounting for open economic exposure. Never recover risk budget by cancelling after an actual fill.

### Plan algorithm

1. Lock/read a consistent eligible pool revision and supported current market snapshot.
2. Exclude expired, superseded, unsupported, stale or unauthorized intents with stable reasons.
3. Compute strategy deltas, owned sellable base, quote and fee requirements.
4. Opposite signs for the same base in the candidate set produce a conflict record and no order. Owner chooses defer/revise; do not automatically average targets or transfer ownership.
5. Group same-side, same-symbol, same fee-policy/IOC-window candidates. No cross-symbol aggregate order.
6. BUY aggregate limit = minimum individual maximum price; SELL aggregate limit = maximum individual minimum price. Quantize without violating any individual's limit: BUY down to tick, SELL up. Base quantity rounds down to lot step; recompute admitted per-strategy amounts under FIFO and show residuals.
7. Validate min/max notional, price/quantity filters, commissions, concentration and actual funding. Whole-child inability returns a reason; never round a user's authorization upward.
8. Simulated preview does not reserve or authorize. Sealing creates child allocations, revisions, reservation entries and plan hash atomically.

v1 one plan contains one child order for the pool's selected symbol. A future multi-child or multi-symbol plan must design shared quote capacity, partial approvals and compensations separately. The complete first release coordinates multiple agents sharing the same real inventory across sequential plans.

## 8. States and terminality

```text
Intent: RECEIVED -> VALIDATED -> PLANNED -> SATISFIED | PARTIAL | UNFILLED
          \-> REJECTED | CONFLICT | SUPERSEDED | EXPIRED | DEFERRED

Plan: PREVIEW -> SEALED_AWAITING_APPROVAL -> APPROVED -> DISPATCH_PENDING
      -> EXECUTING -> RECONCILING -> COMPLETED | PARTIAL | UNFILLED
      \-> INVALIDATED | DECLINED | EXPIRED | MANUAL_REVIEW

Dispatch attempt: PREPARED -> DISPATCH_MARKED -> SEND_ATTEMPTED -> ACKNOWLEDGED | REJECTED | UNKNOWN
                  UNKNOWN -> ACKNOWLEDGED | REJECTED | NOT_SENT_PROVEN | IRRECOVERABLE_UNCERTAINTY

Venue order observation: NEW | PARTIALLY_FILLED | FILLED | CANCELED | PENDING_CANCEL
                       | EXPIRED | EXPIRED_IN_MATCH | REJECTED | UNSUPPORTED_OBSERVATION
Accounting: INCOMPLETE | PROVISIONAL | RECONCILED | CONFLICT
Pool: BOOTSTRAPPING | READY | AWAITING_APPROVAL | IN_FLIGHT | QUARANTINED | HALTED
```

> **Amended by ADR-0001.** `SEND_ATTEMPTED` commits durably immediately before the first
> network byte. An attempt holding `DISPATCH_MARKED` without it, whose sender is provably
> fenced, cannot have sent anything and resolves to `NOT_SENT_PROVEN`, which releases its
> reservations but never authorizes a resend. Where the fence cannot be established the
> attempt terminates at `IRRECOVERABLE_UNCERTAINTY`: an honest record that retains the
> liability and releases nothing. Elapsed time and a repeated NOT_FOUND remain insufficient.
>
> **Amended by ADR-0004.** `EXPIRED_IN_MATCH` is a real Binance self-trade-prevention terminal
> status and was missing. `UNSUPPORTED_OBSERVATION` preserves an unknown future status as raw
> evidence with a fail-closed disposition instead of mapping it to the nearest familiar one.
> `TRADE_PREVENTION` execution reports and their prevented quantities are retained as
> evidence and are never fills.

Keep transport attempt state, observed venue state, accounting state and intent satisfaction separate. An IOC can be EXPIRED with nonzero filled quantity. Plan COMPLETED means the approved gross child fully filled and financially reconciled; it does not mean every net target is SATISFIED. Plan PARTIAL means the child partly filled and its proven terminal remainder is accounted. A completed BUY or SELL can leave an intent PARTIAL because of fees or conservative quantity admission. A manual-review state is not proof of economic absence.

Owner timeout/decline can release only never-dispatched reservations in the same transaction that makes the plan undispatchable. Plan expiry after DISPATCH_MARKED never releases automatically. Late fills stay ingestible after a terminal status; new contradictory facts quarantine rather than silently rewrite an already approved later plan.

## 9. Transaction, dispatch and recovery boundaries

### Seal and approval

Use PostgreSQL SERIALIZABLE transactions, lock pool rows and asset claims in stable order, and retry serialization failure only before any external effect. Seal writes immutable allocations, reservations, source revisions, canonical plan hash and outbox row together.

Plan hash binds pool/account/epoch, child client ID, side/symbol/type/TIF/quantity/limit, allocation order/amounts, allocation-algorithm version, per-strategy asset debit/commission caps, fee policy, intent revisions, mandate revision, baseline/ledger revisions, and expiry. Owner confirmation uses the authenticated session and CSRF defense. Native venue confirmation, if required, remains separate.

> **Amended by ADR-0003.** The approval binds an absolute `submissionDeadlineAt` in addition
> to `approvalExpiresAt`. The complete signed request, including its `timestamp` and
> `recvWindow`, is produced inside the marker transaction and persisted with the marker; the
> sending path holds no key material and no signing function, so an old marker cannot acquire
> a fresh signature. The binding condition is that the **worst-case venue acceptance cutoff**
> — `signedAtLocal + recvWindow + clockSkewBudget` — is no later than `submissionDeadlineAt`.
> Binding the local transmission cutoff instead leaves a window of twice the skew budget in
> which a paused sender's bytes remain valid after the approval lapsed. A `-1021` rejection is
> decisive about that attempt only; it never resolves a different outstanding UNKNOWN.

Before DISPATCH_MARKED, atomically revalidate owner approval, expiry, current mandates, no unresolved prior work, reconciled account/market age and exact payload digest. A newer snapshot revision may be compatible: retain the approved economic payload but recompute eligibility under a versioned predicate; if any bound changes or cannot be proven, invalidate and request a new preview/approval. Never automatically alter quantity/price/fees behind the same approval.

### Single dispatch rule

The executor claims the prepared job, commits one permanent DISPATCH_MARKED record and unique dispatch token, then performs one network call. Retries in SDK, CLI wrapper, HTTP client, queue and process restart must all be disabled for order placement.

Crash before marker: another worker may claim after a lease expires. Crash after marker, including before actual send: UNKNOWN; recovery queries the unique identity and does not send again. A lease/advisory lock only fences our database, not Binance. Never let a new process resend because a lock expired. A stale already-marked sender may still complete; reservation and execution quarantine remain until authoritative reconciliation.

Owner revocation/halt stops not-yet-marked attempts. It cannot retract an already dispatched order; UI explicitly distinguishes requested halt from exchange-confirmed state. No assertion of global exactly-once execution.

### Order reconciliation

Correlate exact scoped client/venue IDs. Fetch order and complete paginated trade/fee history, respecting rate limits and source delay. Dedupe WebSocket and REST facts. Missing order lookup, elapsed local timeout, or absence in one stream is never sufficient to release an UNKNOWN reservation. In v1 absence without documented decisive evidence escalates; there is no automatic NOT_FOUND_SAFE path.

Financial finality requires: known terminal order, cumulative filled quantity/quote consistent with complete trades, actual commission accounted per asset, and account reconciliation at an eligible observation boundary. Then release only unspent reservation in the same ledger transaction as final accounting. Duplicate callbacks return the original transition.

### Account observation boundary

> **Amended by ADR-0002.** Coverage is `COMPLETE` only when all six conditions hold:
> **(U)** the movement universe is proven — every symbol and movement type that could have
> moved a governed asset in the window is enumerable and was enumerated, and this is never
> inferred from an uninterrupted socket; (1) one uninterrupted stream session spanned the
> window, or its gap is closed by a recovery certificate covering that gap; (2) an
> account-wide open-order scan at `t1` showing no unknown order; (3) per-symbol trade backfill
> by contiguous cursor pagination to an already-booked trade, never by assuming trade ids are
> a dense sequence; (4) bracketing balance snapshots differing by exactly the booked effects —
> necessary, never sufficient; (5) every source inside its freshness class.
>
> Condition U is the one the amendment exists for: without it, "one tradable symbol" silently
> becomes "observe only that symbol". Stating five conditions here while the ADR stated six
> would have left implementers following the version that omits it.
>
> The guarantee is narrowed honestly. Binance offers no account-wide completed-trade endpoint,
> so the symbols that traded during an unobserved interval cannot be discovered afterwards.
> Net balance changes across a window are detected by the bracketing reconciliation; movements
> that offset to zero are detected only if their events were observed or their symbol can be
> enumerated. An interrupted stream session therefore yields `UNSUPPORTED`, not `INCOMPLETE`:
> the evidence needed to close it cannot be fetched at all. There is no unconditional
> detection guarantee. Deposits, withdrawals and internal transfers are unobservable in the v1
> testnet surface. No global upstream event cursor is assumed, and trade ids are treated as
> per-symbol and non-dense: backfill completeness comes from contiguous cursor pagination,
> never from assuming consecutive ids.

REST and streams are not assumed to be one atomic snapshot. During v1 reconciliation, pause governed dispatch, catch up exact known order/trade ranges, take before/after account snapshots and verify no intervening economic observations. Record snapshot request intervals, source timestamps, trade cursors and the justified cut. Matching repeated balances alone is not proof of complete history; a missing reliable cut remains INCOMPLETE.

External trade, transfer, unknown open order, scale change, incomplete history or testnet reset quarantines the entire pool in v1. Never overwrite the control ledger to match a snapshot. Resolve with evidenced compensating postings, an explicit owner allocation or a new baseline epoch, retaining the old history. Outstanding UNKNOWN execution prevents rebaseline/release until resolved; rebaseline is not an escape from liability.

## 10. Persistence schema

All mutable business records include workspace/pool scope, optimistic version and created/updated UTC time. Economic deletion is prohibited; use closed/archived states with retained references.

> **Amended by ADR-0005.** `authorizationDurability` is required configuration bound into the
> plan digest. Under `SYNCHRONOUS_REPLICA` the sealed payload, approval, allocation schedule
> and dispatch marker are committed to a replica in a distinct failure domain before the
> executor may mark, giving RPO zero for the authorization record set. `AT_RISK_SINGLE_NODE`
> is permitted for local and testnet work and the owner accepts that a loss covering a sealed
> plan yields `RESTORE_ATTRIBUTION_UNRECOVERABLE`. Before marking, a content-addressed
> authorization evidence bundle is appended outside the database's failure domain so FIFO is
> recoverable when the database is not. Where neither survives, the reconciler records
> `RESTORE_ATTRIBUTION_UNRECOVERABLE` and stops: it never guesses a FIFO order, splits pro
> rata or assigns to HOUSE. A hash cannot recover a lost payload.

| Table | Key facts and constraints |
|---|---|
| workspaces, users, memberships | authenticated owner/operator/viewer roles; no multi-customer custody inference |
| venue_accounts, governance_leases | stable authenticated venueAccountKey, globally unique active governing pool across workspaces; credential rotation cannot duplicate ownership |
| pools, baseline_epochs | governance-lease reference, source capability hash, state, ledger revision, one active epoch; old UNKNOWN liabilities cannot be discarded |
| strategies, agent_credentials | strategy scope, hashed credential, permission/revocation, no venue secret |
| policy_versions, strategy_allocations | immutable limits/allowlists, internal allocation authority |
| intents | scoped idempotency, revision, canonical body hash, current-target uniqueness |
| plan_versions, plan_allocations | immutable child and FIFO allocation facts, canonical approval hash |
| reservations | strategy/asset/plan, nonnegative current amount, version, lifecycle |
| approvals | actor, exact plan hash, expiry, native confirmation reference if actually observed |
| dispatch_attempts | unique child client ID and dispatch token; marker never reset |
| venue_orders, raw_observations | exact account/epoch/symbol IDs; immutable source response facts/hash |
| venue_fills, fill_allocations | unique fill identity; actual quantity/quote/commission by asset |
| ledger_transactions, ledger_entries | immutable append-only, balanced per asset, unique source operation |
| claim_balances | rebuildable available/reserved/quarantined projection; versioned check constraints |
| reconciliation_runs, incidents | cut/cursor/freshness, discrepancy and resolution evidence |
| outbox, job_leases, webhook_deliveries | durable delivery identity, retries/dead letters, no economic blind retry |
| audit_events, idempotency_results | author, action, digest, request scope and stable stored response |

Use composite foreign keys including workspace/pool wherever applicable. Assert balanced ledger entries in the transaction/repository plus deferred database integrity checks; direct application writes to balances are forbidden. Production roles cannot UPDATE/DELETE raw evidence or ledger rows. Numeric signs are restricted by account type. Source event uniqueness and allocation conservation are enforced by constraints and transactional validation.

## 11. API contract

Version `/v1`. Money fields are atom strings plus asset/scale; never anonymous numbers. All write routes require Idempotency-Key, auth scope, strict schema and request-hash conflict handling. Error envelope includes code, safe message, correlationId, retryability, current version and evidence references.

| Route | Scope / behavior |
|---|---|
| GET /pools; GET /pools/:id | owner/viewer; identities, readiness, latest reconciled cut |
| POST /pools/:id/bootstrap | owner; reviewed read-only baseline acquisition, no funding action |
| POST /pools/:id/allocations | owner; HOUSE/strategy AVAILABLE claims only, no exchange transfer |
| POST /strategies; POST /strategies/:id/credentials | owner; issue scoped proposal identity |
| POST /strategies/:id/intents | exact agent or owner; validate target revision |
| GET /intents; GET /plans | scoped list/cursor, outcome and reason codes |
| POST /pools/:id/plans/preview | deterministic preview at evidence revision, no reserves |
| POST /plans/:id/seal | owner; revalidate/reserve atomically, produce immutable version |
| POST /plans/:id/approve; POST /plans/:id/decline | owner; exact sealed hash required |
| POST /pools/:id/halt | operator/owner; durable future-dispatch halt, not a venue liquidate command |
| POST /pools/:id/resume | owner; reconciliation and no blocker gate |
| POST /pools/:id/reconcile | operator; enqueue read-only bounded refresh |
| GET /orders/:id; GET /ledger; GET /incidents | scoped operational evidence |
| POST /incidents/:id/resolutions | owner; typed audited proposal, cannot force evidence to VERIFIED |
| GET /evidence/:digest; POST /exports | scoped content-addressed download/report generation |
| GET /events | authenticated SSE with persisted Last-Event-ID resume |
| GET /health/live; GET /health/ready | process versus DB/source/executor readiness |

> **Amended by ADR-0006.** The lifecycle actions the UI promised are now enumerated with
> allowed actor scopes, idempotency scope, expected-version requirement, emitted event and
> sealed-plan effect: `INTENT_DEFER`, `INTENT_REINSTATE`, `POLICY_VERSION_PUBLISH`,
> `CREDENTIAL_ISSUE`, `CREDENTIAL_REVOKE`, `CREDENTIAL_ROTATE`, `STRATEGY_ARCHIVE`,
> `ACCOUNT_LINK`, `ACCOUNT_UNLINK`, `POOL_CREATE`, `POOL_HALT`, `POOL_RESUME`,
> `POOL_EPOCH_ROTATE`. Authorization is an allowlist per action, not one required role: owner
> and operator may both halt, only the owner may resume, and agents and viewers may perform
> none. Against an unmarked plan an invalidating action invalidates it and releases its
> reservations; against a marked plan the same action affects **future dispatch authority
> only** — it does not invalidate the plan, release reservations, or cancel anything the
> venue accepted. Owner deferral binds the `strategyTargetKey`, so a newer revision from the
> same strategy cannot escape it.

There is no public generic placeOrder, sign, arbitrary command, raw RPC or arbitrary destination endpoint. The executor consumes internally authenticated sealed jobs only. Agent credentials cannot approve/seal/allocate/halt/resume/admin by default; narrowly scoped proposal withdrawal before sealing can be added as a distinct permission.

Pagination caps, retention and idempotency-response lifetime are documented. Keep permanent economic request tombstones even after large response bodies expire; expired cached response must never cause a second economic operation. CSRF protects cookie-authenticated mutations; scoped machine keys use a separate route auth path.

## 12. Agent integration

Read tools: get_pool_state, get_strategy_allocation, get_market_snapshot, get_intent_status, get_plan_status. Proposal tool: propose_target_position. Tool names are **CapitalDesk tools**, not asserted Binance MCP methods. JSON schemas identify every unit, scope, revision and expiry; return exact states and reasons.

Two reference agents use real permitted market observations to form proposals for the same asset with separate identities. LLMs explain evidence and propose targets; deterministic software owns arithmetic, bounds, priority, approval and dispatch. Untrusted news/metadata/tool text cannot modify permissions, reserve funds or supply shell commands. Agents need not predict profit to demonstrate coordination.

## 13. Operations and performance

Release performance requirement: on a declared reference machine with 10 strategies and 100 queued intents, p95 local proposal validation and preview under 1 second excluding venue calls. Stretch capacity benchmark: 100 registered strategies, 20 proposal writes/second sustained for 60 seconds, p95 preview under 500ms and p95 API reads under 300ms for 50 concurrent viewers. These are proposed measurement targets, not observed performance. v1 remains one in-flight plan per pool; do not claim HFT throughput.

Configure source freshness and recovery latency from measured upstream capabilities; document values rather than inventing universal exchange guarantees. Alert on age of UNKNOWN, last complete account cut, unapplied fills, unexplained delta, queue lag, fee mismatch and authorization failure. Bounded retries respect Retry-After. Logs avoid credential material and sensitive raw headers.

> **Amended by ADR-0005.** A restored deployment starts HALTED and RECONCILING and reconciles
> dispatch history against the venue before resuming. A restored copy starting while the
> original still runs must fail the governance lease check rather than both governing.

Backups retain database plus encrypted configuration references and evidence manifests. Restore starts HALTED/RECONCILING; it never drains a restored dispatch outbox into trades. Reconcile dispatch history with the exchange before resuming. Fault injection endpoints are absent from production builds and cannot route to real-money hosts.

## 14. Release gates and future design boundaries

See TEST-PLAN and IMPLEMENTATION-PLAN. Mandatory proof includes concurrent reservation rejection, same-side partial fill attribution, opposite-intent conflict, approval mutation rejection, response-loss recovery without resend, external drift quarantine, broker bypass failure and clean restore.

Future expansion requires separate contracts: multi-child plans, persistent orders and protected inventory, pro-rata fairness, internal inventory transfers with explicit valuation/consent, derivatives margin, multiple venues, multi-owner brokerage and billing. These are not silently hidden behind feature flags in v1. The working first release must complete its narrow real workflow end to end before expansion.
