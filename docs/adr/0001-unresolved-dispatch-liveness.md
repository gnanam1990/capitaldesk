# ADR-0001 — Unresolved dispatch needs a provable exit, not only a safe stop

- Status: accepted
- Date: 2026-09-08
- Resolves: review finding F1 (High)
- Amends: TDD sections 8 and 9; TEST-PLAN sections 7 and 11; prompts 13 and 16

## Context

The reviewed contract handles an ambiguous dispatch safely and incompletely. After
`DISPATCH_MARKED` it forbids a resend, forbids releasing the reservation, and forbids
rebaseline. That is correct. But it supplies no way for any sequence of observations to
_resolve_ the attempt. The reviewer's sequence makes this concrete: commit the marker,
crash before the first network byte, restart, query the client order id, receive NOT_FOUND
forever. One attempt then blocks the pool permanently, and escalating to a person does not
create the missing evidence.

A testnet reset makes it worse. Binance documents resets that remove pending and executed
orders; evidence not captured beforehand may become unfetchable, so the requirement to
resolve old liabilities before a new epoch can make onboarding unrecoverable.

The review is explicit that elapsed time and a repeated NOT_FOUND are not decisive absence
evidence. We accept that and do not weaken it.

## Decision

### 1. A second durable write immediately before the send

The dispatch attempt lifecycle becomes:

```
PREPARED -> DISPATCH_MARKED -> SEND_ATTEMPTED -> ACKNOWLEDGED | REJECTED | UNKNOWN
```

`SEND_ATTEMPTED` is committed durably _immediately before_ the first network byte, on a
single-threaded send path where that write is strictly ordered before the socket write.

This creates a decidable distinction the original contract lacked. An attempt that reached
`DISPATCH_MARKED` but never `SEND_ATTEMPTED` cannot have sent anything, provided the
process that held it can no longer resume.

### 2. Sender fencing, which is what makes absence provable

`NOT_SENT_PROVEN` requires **all** of:

1. The attempt has `DISPATCH_MARKED` and no `SEND_ATTEMPTED` record.
2. The marked sender is fenced, by either:
   - **Egress fence (primary).** The executor transmits through a local egress proxy that
     accepts a single-use dispatch token. The proxy durably records `TOKEN_CONSUMED` before
     forwarding. A token that is durably revoked with no `TOKEN_CONSUMED` record cannot be
     used to send, whether or not the original process is alive.
   - **Host fence (corroborating).** The marker records host boot id, pid and process start
     time. A host whose boot id has since changed cannot host a resumable sender.
3. An account-wide open-order scan and completed-trade backfill covering the whole
   uncertainty window contain no record bearing this client order id.
4. The account observation coverage over that window is `COMPLETE` under ADR-0002.

Condition 2 is the one the original contract was missing, and it is why elapsed time is not
a substitute: without a fence, a paused process remains able to send.

`NOT_SENT_PROVEN` releases the attempt's reservations. It never authorizes a resend under
the old marker; pursuing the target again requires a new preview and a new owner approval.

### 3. Honest representation when absence cannot be proven

If the fence cannot be established — for example a sender that may have resumed, or history
lost to a reset — the attempt terminates at `IRRECOVERABLE_UNCERTAINTY`. This is an honest
record, not a release: reservations stay held, the liability stays attached to the pool and
the governance lease is not freed. The console shows what is known, what is missing, what is
held, the last meaningful progress and that no valid next action exists.

We deliberately accept indefinite quarantine as the correct outcome in this case. The
alternative — inventing a disposition from elapsed time — would let the product report an
economic fact it has not established.

### 4. Testnet epoch archival, separately scoped

A `POOL_EPOCH_ROTATE` after a verified testnet reset is permitted only when: the environment
is `testnet`; the reset is positively evidenced, not inferred from a missing order; every
outstanding sender is fenced under (2); and the old epoch's unresolved attempts are retained
as `IRRECOVERABLE_UNCERTAINTY` under that epoch. Only fresh-epoch assets are assignable.
This never applies to a live-money environment, and it is not a write-off: the historical
liability remains visible and attributed to its original epoch.

## Consequences

- The executor must own its egress path. A generic HTTP client that can reach the venue
  outside the proxy defeats the fence, so this is a deployment requirement, not a library
  choice.
- One extra durable write per dispatch, on the latency-critical path. Accepted: it converts
  an unbounded class of permanent blocks into a provable outcome.
- `-1021` timestamp rejections (ADR-0003) also produce decisive evidence for a _specific_
  attempt. They prove that attempt was not accepted; they do not prove no order exists, and
  never resolve a different outstanding UNKNOWN.

## Tests

Post-marker crash before send with the sender fenced, reaching NOT_SENT_PROVEN; the same
without a fence, reaching UNKNOWN and staying there; a stale sender resumed after recovery;
repeated NOT_FOUND never releasing; UNKNOWN across a reset; fabricated-reset detection.
Extends T-025, T-026, T-029, T-032.
