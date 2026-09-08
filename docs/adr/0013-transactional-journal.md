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

### 2. A ledger transaction balances at COMMIT, per asset, and its entry set is then final

A deferred constraint trigger sums each transaction's entries per asset and refuses the
commit when the ASSET_CONTROL side and the claims side differ (INV-02, INV-04). Deferred,
because entries are inserted one at a time and only the whole set can balance. The
repository checks the same property before writing, so the ordinary path never reaches the
trigger; the trigger is for every other path.

Because that trigger fires once — at the commit that inserted the parent — making the
existing entry rows UPDATE- and DELETE-proof left the set itself open. A later transaction
could insert another entry against a committed `ledger_txn_id` and no balance check fired at
all; a probe appended a `+999` claim and left control at 10 against claims of 1009. Each
transaction now records the database transaction that created it, and entries may only be
inserted by that same one. Creating a posting with all its entries atomically is unchanged;
every later append is refused, balanced or not, because a balanced append is still an edit to
a record that was already final.

### 2a. Economic references carry their whole scope

A probe crossed three boundaries that the keys did not close: an epoch-2 fill cited an
epoch-1 observation, an order in one workspace correlated to a client order id marked in
another, and `applied_ledger_txn_id` accepted a string naming no transaction at all.
Reservations named a strategy through an unchecked text column, and so did ledger entries.

Every one of those is now a composite foreign key over the complete tuple — fills to evidence
in the same epoch, orders to attempts in the same workspace, pool and epoch, applied
observations to a real ledger transaction in their own scope, reservations to a real strategy
in their own pool. The ledger's owner column also carries `HOUSE` and `ASSET_CONTROL`, so it
cannot be a foreign key; a trigger checks the same tuple. A `NULL` correlation still means
external activity, and is skipped rather than invented.

Every transaction names its source operation, unique within the pool and epoch. That is what
makes reapplying an observation after a crash idempotent: the second posting of the same fill
is a unique violation, not a double count (T-030).

### 2b. A claim never ends a transaction negative, and a reservation's remainder is derived

Balancing per asset does not keep a claim above zero. A posting that moves 14,000 out of a
RESERVED claim holding nothing and into AVAILABLE balances exactly, and leaves the claim at
-14,000. `release` compared its amount against the reservation's _original_ size, so after a
fill had consumed part of it, releasing the whole original was accepted: AVAILABLE went to
20,000 and RESERVED to -14,000, and only the projection rebuild noticed, afterwards.

Two changes, and the first is the one that matters. Every RESERVED movement now carries the
reservation it belongs to, and a `CHECK` makes that mutual: a RESERVED entry must name one,
and nothing else may. A reservation's remainder is therefore the sum of its own entries -
derived from authoritative postings, not a counter someone maintains - and `release` refuses
more than that, returning `EXCEEDS_REMAINING` with the figure.

Second, a deferred constraint trigger requires that no HOUSE or STRATEGY claim aggregate, and
no individual reservation, ends the transaction below zero, for every affected owner, asset
and claim state. Deferred, so it reads the state actually being committed; per row, so a
direct `postTransaction` caller and a raw SQL writer are held to it equally. INV-03 was a
constraint on the projection, which is rebuilt after the fact; it is now a constraint on the
postings themselves.

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

### 5a. Marking validates the whole authority chain, under the pool lock

`mark` checks the attempt's own state and, before writing anything, locks the pool row and
requires: a dispatchable pool state, an active governance lease for that account, a plan still
at `DISPATCH_PENDING`, and an attempt that is `PREPARED` and not voided.

Checking only the attempt was not enough. A restore could halt the pool, invalidate the plan
and release its reservation, and a `mark` arriving afterwards still produced a marker and a
send message — for a plan whose authority had been withdrawn and whose funds had been
returned. Taking the pool lock first is also what makes marking and `enterRestorePosture`
mutually exclusive: either the marker commits first and restore then finds a marked attempt
and leaves its plan and reservation alone, or restore commits first and the mark is refused.

Invalidating a plan voids the `PREPARED` attempts it left behind. `voided_at` is a durable,
database-enforced terminal posture: the transition trigger refuses to move a voided attempt,
so it can never be marked by any writer, which is the honest state for an attempt that was
never sent and now never can be.

### 6. A dispatch attempt moves forward only

The contract's transition table is copied into a trigger, and a test reads both and fails if
they differ. Identity — client order id, dispatch token, plan, epoch, the marker time and the
signed request once set — is immutable whether or not the state changes; an earlier draft
checked it only on a state change, which is exactly the update a resend would not make. The
marker and the single-attempt outbox message that will carry the send commit together
(T-024). `SEND_ATTEMPTED` is a second write that cannot precede the marker (ADR-0001).

### 6a. Lease and queue deadlines are the database's, not the caller's

Neither the outbox nor `job_leases` accepts a `now`. A caller-supplied clock is a way for a
worker whose watch runs fast to declare another worker's lease lapsed and take work that is
still held; there is now no way to express it. Acquiring a lease is one
`INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`, so a fresh key, a lapsed
lease and a live one are decided atomically — a read followed by an insert left a window in
which two acquirers for a key that did not exist yet both passed the read, and one surfaced a
raw unique violation instead of a decision.

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

### 8. The outbox is single-attempt for dispatch, and the attempt bound is enforced on claim

`max_attempts` must be 1 for any `dispatch.*` kind, and `attempts <= max_attempts` is a table
constraint. A dispatch message that fails once is dead-lettered.

The bound has to be enforced where messages are handed out, not only where they are failed.
It was not: `claim` re-offered any message whose lease had lapsed, without consulting
`attempts`, so an executor that claimed a send message and then crashed had it handed to the
next consumer as attempt 2 — a second delivery of an order placement, which is the single
outcome this queue exists to prevent. `claim` now refuses a message with no attempts left,
and retires one whose lease lapsed with none remaining: dead-lettered, with the reason that
the outcome of its last attempt is unknown. That is a terminal, explicit posture, and it
authorises nothing; resolving what became of the send is the reconciler's work.

`fail` requires a live lease, as `acknowledge` already did. A worker that stalls past its
lease and resumes is still recorded as the holder, so checking the name alone let it consume
an attempt it no longer held.

Nothing in the outbox is ever deleted.

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

### 10a. Contradictory evidence is a conflict, never a duplicate

Two different payloads under one source reference are not a repeat: the source has said two
different things about one fact. Reporting that as an ordinary duplicate discarded the second
statement silently. The digests are compared; an exact repeat deduplicates, and a difference
records an `evidence_conflicts` row holding both the stored and the incoming evidence, for
the incident path in module 15. The stored evidence is still never overwritten.

The same applies to order status. `ON CONFLICT DO NOTHING` meant every observation after the
first was a no-op, so an order seen as `NEW` stayed `NEW` through `PARTIALLY_FILLED` and
`FILLED` — status, version and last-observed time all frozen. The policy is now explicit:
advance, repeat, arrive late, or contradict. Only an advance writes; two different terminal
statuses, or an unsupported status against a known one, are recorded as conflict evidence and
the stored status is kept.

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

Every decision above has a real-PostgreSQL test on independent connections where concurrency
is claimed, and each guard was shown to fail its test when removed. That verification found
two of its own defects: an injection that appeared to prove the restore voiding had not
actually been applied to the file, and the first stale-`fail` test passed with the liveness
check removed because another worker had already taken the message, so `leased_by` alone
excluded the stale holder. Both were corrected before the guards were counted as proven.
