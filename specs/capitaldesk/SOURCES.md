# Evidence and platform assumptions

Research verified 8 September 2026. No authenticated Binance account, order or trading capability was exercised while producing this pack.

## Evidence register

| ID | Source | What it establishes | Limit |
|---|---|---|---|
| S1 | [Binance Agent OS MCP guide](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic) | Current guide describes scopes, Agentic account isolation and user confirmation for non-read actions | Does not publish all authenticated tool schemas or prove this custom application can obtain execution access |
| S2 | [Spot REST semantics](https://developers.binance.com/en/docs/products/spot/rest-api) | Timeout/5XX can leave execution unknown; endpoint freshness differs; 409 can mean partial cancel-replace | Transport success/failure is not an account reconciliation proof |
| S3 | [Binance CLI](https://github.com/binance/binance-cli) | Official CLI integration surface and documentation | Version, supported flags, testnet routing and profile permissions need inspection during implementation |
| S4 | [NFI issue #1036](https://github.com/iterativv/NostalgiaForInfinity/issues/1036) | June 2026 operator report gives opposing de-risk/re-entry examples | Single report, not independently reproduced here; intent may depend on strategy design |
| S5 | [Binance Trading Bot account isolation](https://chrisleekr.github.io/binance-trading-bot/architecture/account-isolation/) | Existing project deliberately restricts same-base-asset sharing across profiles because wallet/stops interfere | A product design choice, not proof of customers paying to remove it |
| S6 | [Official hackathon article](https://www.binance.com/en/blog/community/8802181509900814931) | Track A builder competition and submission route | No full published judging weights, multiple-entry policy or testnet eligibility guarantee in accessible article |
| S7 | [Official Spot API repository](https://github.com/binance/binance-spot-api-docs) | Versionable primary interface, filters, order and testnet references | Pin and inspect the revision; do not infer MCP equivalence |
| S8 | [Gordon](https://github.com/general-liquidity/gordon) | Public competing trading-agent infrastructure claims | README capabilities were not audited; generic safety harness is not new positioning |
| S9 | [Talos customer case study](https://www.talos.com/insights/firinne-capital-scales-fund-operations-and-risk-oversight-with-the-talos-pms) | Adjacent institutional demand for reconciliation and strategy views | Vendor-hosted evidence; not CapitalDesk demand or a buyer price commitment |

## Competition facts

The current Mini Hackathon closes **8 September 2026 at 23:59 UTC**, or **9 September 2026 at 05:29 Asia/Kolkata**. Track A advertises 20,000 USDC; listed first/second/third awards are 2,000/1,500/1,000 USDC and 50 further awards of 300. Listed awards total 19,500, leaving a 500 discrepancy against the headline. Track B is a separate 40,000 USDC participation promotion. Source S6.

The official public steps require following/reposting, a public submission with video/demo and GitHub if applicable, and the survey. The [survey](https://www.binance.com/en/survey/2913aa200aac462c89a737779393f3d4) requires login before its questions are visible. Multiple projects per participant, team/code-start rules, detailed eligibility and the exact allowed testnet/tool combination remain unverified. Product work must not silently claim competition compliance.

## Interface gate — facts to collect

Record the actual tool/SDK revision, redacted input/output schema and environment for:

1. Account identity, permission inspection and environment fingerprint.
2. Symbol filters, decimals, price limits, commissions and supported LIMIT IOC behavior.
3. Placement with exact durable child identity, query by that identity, complete fill retrieval and cancellations.
4. Approved MCP host/client eligibility and exact per-action confirmation behavior.
5. API credential account versus Agentic OAuth account: they are not assumed identical.
6. Pagination, retention, data-source delay, stream recovery and testnet-reset behavior.
7. Whether a response loss can be injected without losing all exact order-correlation handles.

A competitor reporting an OAuth restriction is a useful lead, not a verified fact about our application. No fabricated OAuth client, token reuse, guessed tool name or unsupported refresh flow is permitted.

## Product assumptions, explicitly unproven

- Operators value safe same-asset shared capital more than the simplicity of separate exchange sub-accounts.
- Operators accept an explicit FIFO allocation policy for partially filled aggregate orders.
- The cost of integration is less than the capital/operational benefit.
- At least one paid pilot exists for this exact product: **not demonstrated**.
- Binance native features may absorb parts of the product. Durable differentiation would depend on workflow integrations, exact accounting and operating experience, not an AI label.

## Why no blockchain component

The controlled resource is a Binance exchange balance. PostgreSQL transactions, an isolated execution credential and exchange reconciliation are the appropriate first implementation. A token, smart contract or chain receipt would not enforce Binance order placement and is outside this release.
