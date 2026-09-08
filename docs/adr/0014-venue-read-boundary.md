# ADR-0014 — The venue read boundary is origin-bound, evidence-backed and cursor-durable

- Status: accepted
- Date: 2026-09-08
- Amends: TDD sections 2 and 9; prompts 05 and 15; adds three reason codes to the wire contract

## Context

Module 05 needs authenticated account readers, public market readers and the worker ingest
boundary. Prompt 05 forbids guessing endpoint fields, flags or MCP names, and ADR-0007 requires
that the reader hold a `VENUE_READ` credential and never a trade key. Three questions were
unresolved by the existing documents:

- where the endpoint shapes, weights and limits come from, given that module 00 is BLOCKED on
  an authenticated credential;
- what a failed read _is_, since the existing reason codes describe economic and evidence
  failures rather than transport ones;
- where the venue host allowlist lives, given that two components now need to agree on it.

## Decision

### 1. The endpoint table is transcribed evidence, not recollection

`packages/binance/src/endpoints.ts` is transcribed from the official Spot REST document at a
recorded sha256, with enums and filter semantics from `enums.md` and `filters.md` at their own
recorded revisions. The public shapes were confirmed against live, non-economic reads of
`testnet.binance.vision`. `docs/evidence/binance-read-capability.md` records the revisions, the
observed responses and — as importantly — what remains unproven.

Two consequences the source forced, rather than convenience:

- `PRICE_FILTER` documents each of `minPrice`, `maxPrice` and `tickSize` as "disabled on == 0",
  so a present zero is represented as _disabled_ rather than as an active bound. A tick of zero
  read as an interval is a zero divisor. `LOT_SIZE` documents no such rule, so its `stepSize`
  stays strictly positive. The two are deliberately not treated alike.
- `NOTIONAL` and `MIN_NOTIONAL` are separate first-class filters with different fields.
  `MIN_NOTIONAL` binds a LIMIT order unconditionally, so a symbol carrying it cannot have a
  legal LIMIT IOC validated without it, and preserving it only as unmodelled raw data would
  have left the market context unable to answer that question.

### 2. A read is bound to one origin, and a URL is never supplied by a caller

A `USER_DATA` read carries the API key in a header and the HMAC in the query string, so a
request built for the wrong origin hands both to whoever answers. The reader therefore takes an
endpoint _name_, never a URL, and the transport validates the constructed request against the
deployment's approved origin — scheme, host, port, userinfo, fragment and the path of the
endpoint that was actually named. Redirects are refused rather than followed.

The approved-origin table moves to `@capitaldesk/contracts` so `@capitaldesk/config` and the
transport enforce one table. Two copies would eventually differ, and the difference would
surface as a signed request sent to whoever owned the other host.

### 3. Three transport reason codes, because their responses differ

`SOURCE_RATE_LIMITED`, `SOURCE_UNAVAILABLE` and `SOURCE_SCHEMA_UNRECOGNIZED` are added to the
wire contract. They are separate because the correct response to each is different — back off
until a named instant, treat the source as degraded and preserve reservations, or quarantine an
unrecognised fact for an owner — and because an empty list is never one of them.

`Retry-After` is honoured across the full documented ban range, up to 259200 seconds, because
the venue documents bans scaling from two minutes to three days and `Retry-After` on a 418 says
when the ban ends. A long defer becomes an absolute instant to be persisted and scheduled, never
a sleep: blocking a worker for three days is an outage, not a backoff.

### 4. Cursors are durable state, not a cache

Per-symbol trade cursors, account snapshots and observation cuts are persisted by forward
migration `0004_venue_read.sql`. ADR-0002 condition C3 establishes backfill completeness by
contiguous cursor pagination, so a lost cursor is a window that can no longer be proven — it
corrupts nothing and makes the window `UNSUPPORTED`, which stops dispatch.

Cursors are per symbol and per epoch, because `myTrades` requires a symbol and its ids are
per-symbol: there is no account-wide trade cursor to keep. They are canonical digit strings
rather than integers, because venue ids exceed what a JSON number holds and a rounded cursor
fetches a different page. They only move forward, enforced numerically in both the repository
and a trigger — `'9'` sorts after `'10'` as text, so a text comparison would accept a rollback
from 10 to 9 while rejecting a legitimate advance from 9 to 10.

A recorded cut carries its verdict, every unmet condition and the symbol set it claims to have
enumerated. Two CHECKs make the dangerous contradiction unstorable: a `COMPLETE` cut cannot
list an unmet condition, and cannot claim `COMPLETE` while its detection scope is only net
balance changes.

### 5. The ingest boundary gathers; the shared predicate judges

`apps/worker/src/ingest.ts` assembles the evidence and calls `assessCoverage`. It does not
reimplement the predicate. Its own contribution is the evidence the predicate cannot gather:
whether every observed symbol paged contiguously, whether the account-wide scan found an order
the journal does not know, and whether the two brackets were taken under the same market rules.

## Consequences

- `PENDING_NEW` is documented upstream but absent from the `venue_orders_status_known` CHECK
  written in module 04. It is preserved raw and quarantined as `UNSUPPORTED_OBSERVATION`, the
  direction ADR-0004 section 4 prescribes. Supporting it is an accounting decision needing its
  own ADR.
- The authenticated boundary stays **BLOCKED**: no `VENUE_READ` credential is configured, so
  no account read, no reader/trader identity equality and no live rate-limit behaviour has been
  exercised. Those are named as blockers rather than asserted.

## Tests

Origin binding including a hostile HTTPS credential-exfiltration regression proving `fetch` is
never called; credential-class refusal; bounded parameters and the documented limits with
positive controls at each bound; every decoder counterexample and positive control; cursor
rollback refused in both the repository and the database; a bracketed cut reaching each
coverage verdict; filter, status and precision drift during a cut; restart from a persisted
cursor. Mutation proofs are recorded in `docs/handoffs/05.md`.
