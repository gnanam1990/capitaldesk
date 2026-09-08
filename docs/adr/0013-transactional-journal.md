# ADR-0013 — The transactional journal: what the database refuses on its own

- Status: accepted
- Date: 2026-09-08
- Implements: module 04 (transactional journal, outbox, replay records)
- Depends on: ADR-0001 (unresolved dispatch), ADR-0005 (durability), ADR-0006 (lifecycle)
- Amends: TDD section 10; prompt 04

## Context

Module 04 makes economic state durable and atomically replayable. Most of what it promises
can be stated as a property of the database rather than of the code that uses it: a posting
that does not balance cannot be committed; an attempt cannot be un-marked; a balance cannot
be written except by deriving it from the entries; one account cannot be governed twice. The
decisions below choose, for each promise, whether it is enforced by a constraint, a trigger,
or the repository — and say why, because the difference is who can break it.

## Decision

### 1. Enforcement lives in the database wherever a constraint or trigger can express it

Append-only tables refuse `DELETE` and, where the row is evidence, `UPDATE`, by trigger. The
alternative — revoking `UPDATE`/`DELETE` from an application role — is stronger against a
misbehaving role but invisible to the tests, which run as the schema owner. Triggers bind
every role including the owner, and are exercised by every test. Role-based revocation is a
deployment step recorded as such in the handoff, not a substitute claimed here.

### 2. A ledger transaction balances at COMMIT, per asset

A deferred constraint trigger sums each transaction's entries per asset and refuses the
commit when the ASSET_CONTROL side and the claims side differ (INV-02, INV-04). Deferred,
because entries are inserted one at a time and only the whole set can balance. The
repository checks the same property before writing, so the ordinary path never reaches the
trigger; the trigger is for every other path.

Every transaction names its source operation, unique within the pool and epoch. That is what
makes reapplying an observation after a crash idempotent: the second posting of the same fill
is a unique violation, not a double count (T-030).

### 3. Balances are a projection with one writer

`claim_balances` refuses every write unless a session flag has been set — and the only thing
that sets it is `rebuild_claim_balances`, which derives the rows from the entries inside the
same statement sequence and clears the flag on exit. The flag is transaction-local, so an
error cannot leave it on. A read of balances checks the projection's recorded ledger revision
against the pool's and rebuilds first when they differ (INV-16).

**Limitation.** A session that sets the flag itself could write the table. That is a
deliberate act by someone with a database connection, not an application bug, and the same
person could rewrite the entries.

### 4. Composite identity everywhere a venue id appears

Orders are unique within `(workspace, pool, epoch, symbol, venue order id)`; fills add the
trade id; a fill must name an order this pool observed. An id the venue reused on another
symbol, account or epoch is a different row and can never collide or cross-link (T-031).
Plans, attempts and reservations reference `(workspace, pool, epoch, plan)` as a tuple, so an
attempt cannot name a plan from another epoch of the same pool (T-032).

### 5. One of each: lease, epoch, in-flight plan

Each is a partial unique index. One active governance lease per venue account across every
workspace (T-056); one open epoch per pool; one plan in a non-terminal post-seal state per
pool. "In flight" includes `MANUAL_REVIEW`, which is post-marker and not terminal.

The lease race is decided by the index. The losing transaction hits it with a snapshot that
predates the winner; PostgreSQL reports that unique violation as a serialization failure
under SERIALIZABLE, so the ordinary retry re-runs it from a fresh snapshot, where it reads
the winner's lease and returns a typed refusal naming the governing pool. An earlier draft
carried a special retry for the unique violation; removing it changed nothing in the race
test, so it is gone. A lease cannot be released while any attempt on that
account, in any epoch, is `DISPATCH_MARKED`, `SEND_ATTEMPTED`, `UNKNOWN` or
`IRRECOVERABLE_UNCERTAINTY` (ADR-0001 section 3); a trigger enforces this for every writer.
Epoch rotation is refused while any attempt is unresolved, and never touches the lease.

### 6. A dispatch attempt moves forward only

The contract's transition table is copied into a trigger, and a test reads both and fails if
they differ. Identity — client order id, dispatch token, plan, epoch, the marker time and the
signed request once set — is immutable whether or not the state changes; an earlier draft
checked it only on a state change, which is exactly the update a resend would not make. The
marker and the single-attempt outbox message that will carry the send commit together
(T-024). `SEND_ATTEMPTED` is a second write that cannot precede the marker (ADR-0001).

### 7. SERIALIZABLE for economic writes, with retries only before an effect

Economic writes run at SERIALIZABLE and re-run on SQLSTATE 40001/40P01 a bounded number of
times. A guard records the first external effect; after it, no retry is permitted whatever
the error, because a retry would repeat the effect. Pool rows are locked in one sorted order.
Queue operations — outbox claims with `SKIP LOCKED`, lease takeovers — run at READ COMMITTED,
where a blocked row lock re-evaluates against the committed row, which is the arbitration
they need.

Under contention two reservers that read the same opening availability cannot both commit:
the second blocks on the pool row, fails serialization when the first commits, and on re-run
reads the reduced availability and is refused (T-013).

### 8. The outbox is single-attempt for dispatch, by constraint

`max_attempts` must be 1 for any `dispatch.*` kind. A dispatch message that fails once is
dead-lettered; there is no path by which it is delivered twice (INV-09). Nothing in the outbox
is ever deleted.

### 9. Idempotency rows are tombstones

One row per scope and key, forever. The stored response body may be discarded after its
retention lapses; the row, its request digest, action and economic reference cannot be
changed or removed. A replay after discard returns `replay-expired` with the reference — the
action is not performed again (INV-11).

### 10. Restore starts halted and drains nothing

`enterRestorePosture` halts every pool, quarantines every unpublished outbox message,
invalidates sealed plans that never reached a marker and releases their reservations, and
leaves every marked attempt, its reservation and its uncertainty exactly as found. It reports
how many liabilities it retained (T-035, ADR-0005 section 4).

### 11. Evidence is digested as received, not canonically

Raw observation payloads are venue JSON, full of numbers the canonical money encoding refuses
by design. The stored digest is over the bytes as received when the adapter supplies them,
otherwise over the persisted serialisation. Deduplication is by source reference, not digest.

## What this module does not do

- Tables for intents, approvals, policy versions, incidents, reconciliation runs and webhook
  deliveries are not created here. Their columns are defined by the modules that own the
  behaviour behind them, and guessing them now would fix a shape the wrong module then has
  to live with. Nothing in this module needs them.
- No role-based `REVOKE` is applied. The triggers bind every role; the revocation is a
  deployment control recorded in the handoff.
- Nothing here contacts a venue, and no repository method can.

## Tests

Every decision above has a real-PostgreSQL test on independent connections where
concurrency is claimed, and the load-bearing ones were shown to fail with the guard removed:
the deferred balance check, the pool lock under contention, the lease-race re-read, the
restore quarantine, and the projection write guard.
