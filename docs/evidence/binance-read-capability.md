# Binance Spot read capability — evidence for module 05

Collected 8 September 2026. **No credential was used and no authenticated endpoint was
called.** Every request below is a public, non-economic read. No order was placed, amended or
cancelled, and nothing here contacted a funded account.

This file is the source for the endpoint table in `packages/binance/src/endpoints.ts`. Prompt
05 forbids guessing endpoint fields, flags or weights; these are the observations and the
document revision the table was transcribed from.

## What is proven, and what is not

| Boundary                                                                   | Status                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public market reads against the allowlisted testnet host                   | **Verified live**, below                                                                                                                                                                                    |
| Documented weights, parameters, statuses and limit behaviour               | **Verified** against the official document revision below                                                                                                                                                   |
| Authenticated account reads (`account`, `order`, `openOrders`, `myTrades`) | **BLOCKED** — no `VENUE_READ` credential is configured (module 00)                                                                                                                                          |
| Reader/executor account identity equality                                  | **BLOCKED** — needs both credentials                                                                                                                                                                        |
| Live 429/418 and `Retry-After` behaviour                                   | **Not exercised.** Deliberately not provoked: the documented penalty for repeatedly triggering it is an IP ban scaling to three days. Handling is built from the document and proven against a test double. |

## Official document revision

```text
source   https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/rest-api.md
fetched  2026-09-08
sha256   49ea6809243fc7fb426e07f2fe662097736c7bb405bd2da5eef637d715427999
```

Enumerations were read from `enums.md` and filter semantics from `filters.md` in the same
repository:

```text
source   https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/filters.md
fetched  2026-09-08
sha256   4b5a8f0f5d15bcf68fd7ac2059ba6c88da641c06fd7885e642330c5ac8124dd3
```

### Filter semantics that changed a decision

`filters.md` states for `PRICE_FILTER`: "Any of the above variables can be set to 0, which
disables that rule in the price filter", and lists `minPrice`, `maxPrice` and `tickSize` each
as "disabled on ... == 0". A zero is therefore a meaningful value from the venue, not a
malformed one — and equally not an active bound, since a tick of zero read as an interval is a
zero divisor. The decoder represents a present zero as `null`, meaning that part is disabled,
and compares the minimum against the maximum only when both are enabled. A _missing_ part
remains `SOURCE_SCHEMA_UNRECOGNIZED`.

`LOT_SIZE` documents no such disable rule, so its `stepSize` stays strictly positive. The two
filters are deliberately not treated alike, because the source does not treat them alike.

`NOTIONAL` is documented as a _range_ — "the acceptable notional range allowed for an order" —
and its `/exchangeInfo` shape carries `minNotional`, `applyMinToMarket`, `maxNotional`,
`applyMaxToMarket` and `avgPriceMins`. No part is documented as optional and no
missing-means-disabled rule is stated, so every part is required and an absent `maxNotional` is
a schema failure rather than "no maximum".

`MIN_NOTIONAL` is a separate first-class filter with its own fields (`minNotional`,
`applyToMarket`, `avgPriceMins`) and its own rule: "An order will pass this filter evaluation
if: `price` * `quantity` >= `minNotional`". It binds a LIMIT order unconditionally —
`applyToMarket` only decides whether MARKET orders are covered as well — so a symbol carrying
it cannot have a legal LIMIT IOC validated without it. Both filters are decoded, kept distinct,
and a symbol may declare both; when it does, both are minimums an order must satisfy, so the
binding constraint is the larger.

**Not observed live.** BTCUSDT on the testnet host carries `NOTIONAL`, not `MIN_NOTIONAL`, so
the `MIN_NOTIONAL` decoding is built from the documented shape above and exercised against
fixtures. It has no live sample in this evidence file.

## Live public reads

Host `https://testnet.binance.vision`, which `packages/config` allowlists for the `testnet`
deployment.

```text
GET /api/v3/time                          -> 200   {"serverTime":1788867356144}
GET /api/v3/exchangeInfo?symbol=BTCUSDT   -> 200   x-mbx-used-weight-1m: 20
GET /api/v3/exchangeInfo?symbol=NOTASYMBOL1 -> 400 {"code":-1121,"msg":"Invalid symbol."}
GET /api/v3/account                       -> 400 {"code":-1102,"msg":"Mandatory parameter 'signature' was not sent, was empty/null, or malformed."}
GET /api/v3/openOrders                    -> 400 {"code":-1102,"msg":"Mandatory parameter 'signature' was not sent, was empty/null, or malformed."}
```

The `exchangeInfo` response body observed has sha256 `f6096f188053cefbd7b324069c374c25fd9c336023674012b5f90f0b64491f24`.

The two 400s are the evidence that these endpoints are authenticated: an unsigned request is
refused before any account is touched. They are not a capability claim.

### Observed account-level rate limits

From the live `exchangeInfo` response:

| rateLimitType  | interval  | limit  |
| -------------- | --------- | ------ |
| REQUEST_WEIGHT | 1 MINUTE  | 6000   |
| ORDERS         | 10 SECOND | 50     |
| ORDERS         | 1 DAY     | 160000 |
| RAW_REQUESTS   | 5 MINUTE  | 300000 |

The response carried `x-mbx-used-weight-1m`, so used weight is observable per response and is
not something the client has to model blind.

### Observed BTCUSDT filters

`baseAssetPrecision` 8, `quoteAssetPrecision` 8, `quotePrecision` 8,
`baseCommissionPrecision` 8, `quoteCommissionPrecision` 8, `status` TRADING.

```text
PRICE_FILTER          minPrice 0.01000000  maxPrice 1000000.00000000  tickSize 0.01000000
LOT_SIZE              minQty   0.00001000  maxQty   9000.00000000     stepSize 0.00001000
NOTIONAL              minNotional 5.00000000  maxNotional 9000000.00000000  avgPriceMins 5
PERCENT_PRICE_BY_SIDE bid x2/x0.5  ask x2/x0.5  avgPriceMins 5
MAX_NUM_ORDERS 200    MAX_NUM_ALGO_ORDERS 5   ICEBERG_PARTS 100
```

`orderTypes` includes `LIMIT`; `IOC` is a `timeInForce` value, not an order type. Both are
required for the product's LIMIT IOC policy and both are present.

## Endpoint table, as transcribed

| Endpoint                   | Weight                               | Mandatory             | Notes                                                                                               |
| -------------------------- | ------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/v3/time`         | 1                                    | —                     | public                                                                                              |
| `GET /api/v3/exchangeInfo` | 20                                   | —                     | public; `symbol`/`symbols` optional                                                                 |
| `GET /api/v3/account`      | 20                                   | `timestamp`           | returns `uid`, the stable authenticated account id                                                  |
| `GET /api/v3/order`        | 4                                    | `symbol`, `timestamp` | either `orderId` or `origClientOrderId` must be sent                                                |
| `GET /api/v3/openOrders`   | **6** with `symbol`, **80** without  | `timestamp`           | account-wide when the symbol is omitted (ADR-0002 condition C2)                                     |
| `GET /api/v3/myTrades`     | **20** without `orderId`, **5** with | `symbol`, `timestamp` | `startTime`..`endTime` ≤ 24h; `limit` max 1000, default 500; `fromId` returns trades **>=** that id |

`myTrades` requires a symbol. There is no account-wide completed-trade endpoint, which is the
fact ADR-0002 is built on: the set of symbols that traded during an unobserved interval cannot
be discovered afterwards, so such a window is `UNSUPPORTED` rather than `INCOMPLETE`.

## Rate limiting and bans, as documented

- HTTP `429` — a request rate limit was broken.
- HTTP `418` — the IP was auto-banned for continuing to send after receiving 429s.
- `Retry-After` accompanies a 418 or 429 and gives **the number of seconds** to wait: on a
  429 to prevent a ban, on a 418 until the ban is over.
- "IP bans are tracked and scale in duration for repeat offenders, **from 2 minutes to 3
  days**."

So a three-day `Retry-After` is a legitimate instruction. The reader accepts the full
documented range up to 259200 seconds and converts it to an absolute defer instant rather than
sleeping, because blocking a worker for three days is an outage rather than a backoff.

## Statuses and execution types, as documented

Order status: `NEW`, `PENDING_NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`,
`PENDING_CANCEL`, `REJECTED`, `EXPIRED`, `EXPIRED_IN_MATCH`.

Execution types: `NEW`, `CANCELED`, `REPLACED`, `REJECTED`, `TRADE`, `EXPIRED`,
`TRADE_PREVENTION`.

`EXPIRED_IN_MATCH` and `TRADE_PREVENTION` are confirmed present, as ADR-0004 requires.

**Finding.** `PENDING_NEW` is documented upstream but is not in this repository's
`venue_orders_status_known` CHECK, which was written in module 04. The reader therefore
preserves it raw and maps it to `UNSUPPORTED_OBSERVATION`, which quarantines the affected
accounting. That is the fail-closed direction ADR-0004 section 4 prescribes for a status this
build has not designed accounting for. Adopting it would be an accounting decision needing its
own ADR, and is not made here.

## Error envelope

`{"code": <negative integer>, "msg": "<text>"}` with HTTP 400, confirmed live twice above. The
code is retained on every rejection: a single `-2013` "Order does not exist." must never
release a reservation (T-029), and that rule can only be applied by a caller that can see which
code it was.
