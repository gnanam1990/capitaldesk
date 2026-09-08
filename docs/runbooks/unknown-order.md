# Unknown order response

An order becomes unknown when CapitalDesk has a durable dispatch marker or send attempt but
cannot prove the venue outcome. Treat it as a possible live liability. Do not resend it and do
not release its reservation.

## Read-only diagnosis

1. Capture the plan id, attempt id, stable client order id, dispatch marker, send-attempt time
   and latest source health. Do not copy credential material into the incident.
2. Query the venue by client order id with the worker read credential. A transport timeout is
   still unknown; it is not evidence that the venue rejected the order.
3. Compare venue fills, order state, fees and the current account cut with the journal. Preserve
   raw provider timestamps and source ids.
4. Classify the uncertainty:
   - **internal:** journal/outbox/marker state is inconsistent;
   - **source:** venue read is unavailable, stale or contradictory;
   - **external drift:** venue activity exists outside CapitalDesk authority;
   - **policy:** approval, allocation evidence or configuration cannot be validated.
5. Reconcile an acknowledged or filled result idempotently. Prove `NOT_SENT` only from a
   venue response and observation window that meet the adapter contract. Otherwise retain
   `UNKNOWN` or escalate to `IRRECOVERABLE_UNCERTAINTY`.

The operator may halt more pools or the whole executor while investigating. Resolution must
not weaken the original FIFO attribution, invent a fee, edit an approval or make the same
attempt dispatchable again.
