-- 0003_journal
--
-- Module 04: the transactional journal. Reserved for this module only.
--
-- What this migration makes true, and keeps true against every role that can reach it:
--
--  * Economic records are append-only. Raw observations, ledger transactions and entries,
--    dispatch attempts, idempotency tombstones and outbox rows refuse DELETE; the immutable
--    ones refuse UPDATE too. Nothing here can be made to un-happen.
--  * Every ledger transaction balances per asset, checked at commit, so a partial posting
--    cannot survive a crash between two entries.
--  * Balances are a projection. The application cannot write claim_balances directly; only
--    the rebuild function can, and it derives them from the entries.
--  * Identity is composite. Orders and fills are unique within (workspace, pool, epoch,
--    symbol), never by a bare venue id, so a reused id in another epoch is a different fact.
--  * One active governance lease per authenticated venue account across every workspace, one
--    current epoch per pool, one in-flight plan per pool - each a partial unique index rather
--    than a convention.
--  * A dispatch attempt moves forward only. The transition table is the one in
--    packages/contracts/src/states.ts, copied here and cross-checked by a test that reads both.
--
-- Quantities are NUMERIC(78,0): integer atoms, never a float, never a JavaScript number.

-- --------------------------------------------------------------------------------------
-- Shared guards
-- --------------------------------------------------------------------------------------

-- refuse_mutation() already exists from 0002 (audit_events). Reused here.

-- Columns that may change on an otherwise immutable row are named per table; everything else
-- is compared. hstore is not assumed, so each trigger names its own mutable columns.

-- --------------------------------------------------------------------------------------
-- Venue accounts and governance
-- --------------------------------------------------------------------------------------
--
-- The stable authenticated identity of an account. Not a key fingerprint, not an alias: the
-- venue's own durable account id, established by an authenticated read. Rotating a credential
-- observes the same identity and must find the same row.

CREATE TABLE venue_accounts (
  venue              TEXT        NOT NULL,
  environment        TEXT        NOT NULL,
  stable_account_id  TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (venue, environment, stable_account_id),
  CONSTRAINT venue_accounts_venue_known CHECK (venue IN ('binance-spot')),
  CONSTRAINT venue_accounts_environment_known
    CHECK (environment IN ('local', 'testnet', 'production')),
  CONSTRAINT venue_accounts_id_shape
    CHECK (stable_account_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);

-- Credential aliases observed for an account. Evidence of which credentials have seen it;
-- never identity, and never a second bootstrap.
CREATE TABLE venue_account_credentials (
  venue              TEXT        NOT NULL,
  environment        TEXT        NOT NULL,
  stable_account_id  TEXT        NOT NULL,
  credential_alias   TEXT        NOT NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (venue, environment, stable_account_id, credential_alias),
  FOREIGN KEY (venue, environment, stable_account_id)
    REFERENCES venue_accounts (venue, environment, stable_account_id)
);

-- Pools are declared before leases because a lease names its governing pool, and a pool
-- names its account; the pool -> lease reference is added after both exist.
CREATE TABLE pools (
  workspace_id       TEXT        NOT NULL REFERENCES workspaces (workspace_id),
  pool_id            TEXT        NOT NULL,
  venue              TEXT        NOT NULL,
  environment        TEXT        NOT NULL,
  stable_account_id  TEXT        NOT NULL,
  state              TEXT        NOT NULL DEFAULT 'BOOTSTRAPPING',
  -- Incremented by every committed ledger transaction; the revision a projection was built at.
  ledger_revision    BIGINT      NOT NULL DEFAULT 0,
  version            INTEGER     NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id),
  FOREIGN KEY (venue, environment, stable_account_id)
    REFERENCES venue_accounts (venue, environment, stable_account_id),
  CONSTRAINT pools_id_shape CHECK (pool_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT pools_state_known CHECK (state IN
    ('BOOTSTRAPPING', 'READY', 'AWAITING_APPROVAL', 'IN_FLIGHT', 'QUARANTINED', 'HALTED')),
  CONSTRAINT pools_revision_nonnegative CHECK (ledger_revision >= 0),
  CONSTRAINT pools_version_positive CHECK (version >= 1)
);

-- One active governance lease per venue account, across every workspace and pool in this
-- registry. This is the row that makes "the same funds cannot be bootstrapped twice" a
-- database fact. Independent deployments that do not share this registry cannot enforce it,
-- and that limit is documented rather than hidden.
CREATE TABLE governance_leases (
  lease_id           TEXT        NOT NULL PRIMARY KEY,
  venue              TEXT        NOT NULL,
  environment        TEXT        NOT NULL,
  stable_account_id  TEXT        NOT NULL,
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at        TIMESTAMPTZ,
  released_reason    TEXT,
  FOREIGN KEY (venue, environment, stable_account_id)
    REFERENCES venue_accounts (venue, environment, stable_account_id),
  FOREIGN KEY (workspace_id, pool_id) REFERENCES pools (workspace_id, pool_id),
  CONSTRAINT governance_leases_id_shape CHECK (lease_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT governance_leases_released_together
    CHECK ((released_at IS NULL) = (released_reason IS NULL))
);

CREATE UNIQUE INDEX governance_leases_single_active
  ON governance_leases (venue, environment, stable_account_id)
  WHERE released_at IS NULL;

-- A pool holds at most one lease at a time, and the lease it holds governs its own account.
CREATE UNIQUE INDEX governance_leases_single_per_pool
  ON governance_leases (workspace_id, pool_id)
  WHERE released_at IS NULL;

-- --------------------------------------------------------------------------------------
-- Baseline epochs
-- --------------------------------------------------------------------------------------
--
-- A pool's economic history is partitioned into epochs. A testnet reset opens a new one; the
-- old one is never deleted, and every order, fill, plan and attempt names its epoch, so an id
-- the venue reused after a reset is a different identity here (INV-14).

CREATE TABLE baseline_epochs (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when a later epoch replaced this one. The rows under it remain.
  closed_at          TIMESTAMPTZ,
  closed_reason      TEXT,
  PRIMARY KEY (workspace_id, pool_id, epoch),
  FOREIGN KEY (workspace_id, pool_id) REFERENCES pools (workspace_id, pool_id),
  CONSTRAINT baseline_epochs_positive CHECK (epoch >= 1),
  CONSTRAINT baseline_epochs_closed_together
    CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);

-- Exactly one current epoch per pool.
CREATE UNIQUE INDEX baseline_epochs_single_current
  ON baseline_epochs (workspace_id, pool_id)
  WHERE closed_at IS NULL;

-- --------------------------------------------------------------------------------------
-- Plans
-- --------------------------------------------------------------------------------------
--
-- The sealed plan is immutable: payload and digest never change after insert; only the state
-- machine advances. One in-flight plan per pool (TDD section 13).

CREATE TABLE plans (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  plan_id            TEXT        NOT NULL,
  state              TEXT        NOT NULL,
  -- Canonical sealed payload and its digest (module 09 fills these; the journal only
  -- guarantees they cannot change once written).
  payload            JSONB       NOT NULL,
  payload_digest     TEXT        NOT NULL,
  version            INTEGER     NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, plan_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  CONSTRAINT plans_id_shape CHECK (plan_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT plans_state_known CHECK (state IN
    ('PREVIEW', 'SEALED_AWAITING_APPROVAL', 'APPROVED', 'DISPATCH_PENDING', 'EXECUTING',
     'RECONCILING', 'COMPLETED', 'PARTIAL', 'UNFILLED', 'INVALIDATED', 'DECLINED', 'EXPIRED',
     'MANUAL_REVIEW')),
  CONSTRAINT plans_version_positive CHECK (version >= 1),
  -- Referenced by attempts through the full tuple, so an attempt cannot name a plan from
  -- another epoch of the same pool.
  CONSTRAINT plans_scope_tuple UNIQUE (workspace_id, pool_id, epoch, plan_id)
);

-- One in-flight plan per pool. In flight: sealed, and not yet at a terminal outcome.
CREATE UNIQUE INDEX plans_single_in_flight
  ON plans (workspace_id, pool_id)
  WHERE state IN ('SEALED_AWAITING_APPROVAL', 'APPROVED', 'DISPATCH_PENDING', 'EXECUTING',
                  'RECONCILING', 'MANUAL_REVIEW');

CREATE OR REPLACE FUNCTION refuse_plan_payload_change() RETURNS trigger AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.epoch IS DISTINCT FROM OLD.epoch THEN
    RAISE EXCEPTION 'plan % is sealed; its payload, digest and epoch are immutable', OLD.plan_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER plans_payload_is_immutable
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION refuse_plan_payload_change();

CREATE TRIGGER plans_are_never_deleted
  BEFORE DELETE ON plans
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Dispatch attempts
-- --------------------------------------------------------------------------------------
--
-- The marker. client_order_id and dispatch_token are unique across the whole table forever:
-- venue client-id behaviour is not treated as permanent deduplication, local history is
-- (TDD section 4). State advances only along the contract's transition table; a marked
-- attempt is never reset, retried or reused (INV-09).

CREATE TABLE dispatch_attempts (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  attempt_id         TEXT        NOT NULL,
  plan_id            TEXT        NOT NULL,
  client_order_id    TEXT        NOT NULL,
  dispatch_token     TEXT        NOT NULL,
  state              TEXT        NOT NULL DEFAULT 'PREPARED',
  -- The signed request is produced inside the marker transaction and persisted with it
  -- (ADR-0003). The journal stores it opaquely; the sending path holds no signing function.
  signed_request     JSONB,
  prepared_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  marked_at          TIMESTAMPTZ,
  send_attempted_at  TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  -- Host fence evidence (ADR-0001): what held the marker, so a resumed sender is detectable.
  marker_host_boot_id TEXT,
  marker_pid         INTEGER,
  -- Set when an attempt that never marked is made permanently undispatchable - by a restore,
  -- or by the invalidation of its plan. An honest terminal posture for a PREPARED attempt
  -- whose authority is gone: it was never sent, and it can never be sent.
  voided_at          TIMESTAMPTZ,
  voided_reason      TEXT,
  PRIMARY KEY (workspace_id, pool_id, attempt_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, plan_id)
    REFERENCES plans (workspace_id, pool_id, epoch, plan_id),
  CONSTRAINT dispatch_attempts_id_shape CHECK (attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT dispatch_attempts_client_id_unique UNIQUE (client_order_id),
  -- Referenced by venue_orders through the complete tuple. A bare client_order_id reference
  -- let an order in one workspace and pool correlate to an attempt marked in another.
  CONSTRAINT dispatch_attempts_correlation_tuple
    UNIQUE (workspace_id, pool_id, epoch, client_order_id),
  CONSTRAINT dispatch_attempts_token_unique UNIQUE (dispatch_token),
  CONSTRAINT dispatch_attempts_state_known CHECK (state IN
    ('PREPARED', 'DISPATCH_MARKED', 'SEND_ATTEMPTED', 'ACKNOWLEDGED', 'REJECTED', 'UNKNOWN',
     'NOT_SENT_PROVEN', 'IRRECOVERABLE_UNCERTAINTY')),
  CONSTRAINT dispatch_attempts_marked_has_time
    CHECK (state = 'PREPARED' OR marked_at IS NOT NULL),
  CONSTRAINT dispatch_attempts_send_has_time
    CHECK (state NOT IN ('SEND_ATTEMPTED', 'ACKNOWLEDGED', 'REJECTED') OR send_attempted_at IS NOT NULL),
  CONSTRAINT dispatch_attempts_voided_together
    CHECK ((voided_at IS NULL) = (voided_reason IS NULL)),
  -- Voiding says the attempt never marked. An attempt past PREPARED cannot be voided, and a
  -- voided attempt cannot later be marked; the trigger enforces the second direction.
  CONSTRAINT dispatch_attempts_voided_only_when_prepared
    CHECK (voided_at IS NULL OR state = 'PREPARED')
);

-- The transition table from packages/contracts/src/states.ts (DISPATCH_ATTEMPT_TRANSITIONS).
-- A test reads this file and that module and fails if they differ.
CREATE OR REPLACE FUNCTION refuse_dispatch_regression() RETURNS trigger AS $$
DECLARE
  permitted BOOLEAN;
BEGIN
  -- Identity never changes once written, whether or not the state moves. A marker that could
  -- be re-pointed at a new client id would be a resend wearing the old attempt's record. An
  -- earlier draft checked this only on a state change, which is exactly the update a resend
  -- would not make.
  IF NEW.client_order_id IS DISTINCT FROM OLD.client_order_id
     OR NEW.dispatch_token IS DISTINCT FROM OLD.dispatch_token
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.epoch IS DISTINCT FROM OLD.epoch
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR (OLD.marked_at IS NOT NULL AND NEW.marked_at IS DISTINCT FROM OLD.marked_at)
     OR (OLD.send_attempted_at IS NOT NULL AND NEW.send_attempted_at IS DISTINCT FROM OLD.send_attempted_at)
     OR (OLD.signed_request IS NOT NULL AND NEW.signed_request IS DISTINCT FROM OLD.signed_request) THEN
    RAISE EXCEPTION 'dispatch attempt % identity is immutable', OLD.attempt_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- A voided attempt is permanently undispatchable, whichever writer tries.
  IF OLD.voided_at IS NOT NULL AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'dispatch attempt % was voided (%): it can never be marked',
      OLD.attempt_id, OLD.voided_reason
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'dispatch attempt % cannot be un-voided', OLD.attempt_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  permitted := CASE OLD.state
    WHEN 'PREPARED'        THEN NEW.state IN ('DISPATCH_MARKED')
    WHEN 'DISPATCH_MARKED' THEN NEW.state IN ('SEND_ATTEMPTED', 'UNKNOWN', 'NOT_SENT_PROVEN')
    WHEN 'SEND_ATTEMPTED'  THEN NEW.state IN ('ACKNOWLEDGED', 'REJECTED', 'UNKNOWN')
    WHEN 'UNKNOWN'         THEN NEW.state IN ('ACKNOWLEDGED', 'REJECTED', 'NOT_SENT_PROVEN', 'IRRECOVERABLE_UNCERTAINTY')
    ELSE FALSE
  END;
  IF NOT permitted THEN
    RAISE EXCEPTION 'dispatch attempt % cannot move from % to %', OLD.attempt_id, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dispatch_attempts_move_forward_only
  BEFORE UPDATE ON dispatch_attempts
  FOR EACH ROW EXECUTE FUNCTION refuse_dispatch_regression();

CREATE TRIGGER dispatch_attempts_are_never_deleted
  BEFORE DELETE ON dispatch_attempts
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- A lease cannot be released while the account carries an unresolved dispatch liability, in
-- any epoch of any pool that governed it (ADR-0001 section 3; TDD section 4). Rebaseline is
-- not an escape from liability.
CREATE OR REPLACE FUNCTION refuse_lease_release_with_liabilities() RETURNS trigger AS $$
DECLARE
  outstanding INTEGER;
BEGIN
  IF NEW.released_at IS NULL OR OLD.released_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO outstanding
    FROM dispatch_attempts a
    JOIN pools p ON p.workspace_id = a.workspace_id AND p.pool_id = a.pool_id
   WHERE p.venue = NEW.venue
     AND p.environment = NEW.environment
     AND p.stable_account_id = NEW.stable_account_id
     AND a.state IN ('DISPATCH_MARKED', 'SEND_ATTEMPTED', 'UNKNOWN', 'IRRECOVERABLE_UNCERTAINTY');
  IF outstanding > 0 THEN
    RAISE EXCEPTION 'governance lease % cannot be released: % unresolved dispatch liabilities remain on this account',
      NEW.lease_id, outstanding
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER governance_leases_hold_liabilities
  BEFORE UPDATE ON governance_leases
  FOR EACH ROW EXECUTE FUNCTION refuse_lease_release_with_liabilities();

CREATE TRIGGER governance_leases_are_never_deleted
  BEFORE DELETE ON governance_leases
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Reservations
-- --------------------------------------------------------------------------------------

CREATE TABLE reservations (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  reservation_id     TEXT        NOT NULL,
  strategy_id        TEXT        NOT NULL,
  plan_id            TEXT        NOT NULL,
  asset_code         TEXT        NOT NULL,
  asset_scale        TEXT        NOT NULL,
  reserved_atoms     NUMERIC(78, 0) NOT NULL,
  state              TEXT        NOT NULL DEFAULT 'HELD',
  version            INTEGER     NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, reservation_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, plan_id)
    REFERENCES plans (workspace_id, pool_id, epoch, plan_id),
  -- Economic ownership references a real strategy in this pool, not an unchecked text owner.
  FOREIGN KEY (workspace_id, pool_id, strategy_id)
    REFERENCES strategies (workspace_id, pool_id, strategy_id),
  CONSTRAINT reservations_id_shape CHECK (reservation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT reservations_atoms_integral CHECK (reserved_atoms = trunc(reserved_atoms)),
  CONSTRAINT reservations_atoms_nonnegative CHECK (reserved_atoms >= 0),
  CONSTRAINT reservations_state_known
    CHECK (state IN ('HELD', 'CONSUMED', 'RELEASED', 'QUARANTINED')),
  CONSTRAINT reservations_version_positive CHECK (version >= 1)
);

CREATE TRIGGER reservations_are_never_deleted
  BEFORE DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Evidence conflicts
-- --------------------------------------------------------------------------------------
--
-- What a source said that contradicts what it said before: a second payload under one source
-- reference, or a terminal order status replaced by a different terminal status. Neither is a
-- duplicate, and neither may overwrite the stored evidence. The row is the durable record the
-- incident path in module 15 consumes; recording it is not resolving it.

CREATE TABLE evidence_conflicts (
  conflict_id        BIGSERIAL   NOT NULL PRIMARY KEY,
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  subject_kind       TEXT        NOT NULL,
  -- What the conflicting statements are about: an observation id, or symbol/venue order id.
  subject_ref        TEXT        NOT NULL,
  stored             JSONB       NOT NULL,
  incoming           JSONB       NOT NULL,
  detected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  CONSTRAINT evidence_conflicts_subject_known
    CHECK (subject_kind IN ('observation', 'order-status'))
);

CREATE INDEX evidence_conflicts_by_subject
  ON evidence_conflicts (workspace_id, pool_id, subject_kind, subject_ref);

CREATE TRIGGER evidence_conflicts_are_append_only
  BEFORE UPDATE OR DELETE ON evidence_conflicts
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Ledger
-- --------------------------------------------------------------------------------------
--
-- Append-only double entry per asset. A transaction is the unit of economic change; its
-- entries must sum to zero per asset, checked at commit by a deferred constraint trigger, so
-- an unbalanced posting - a crash between two entries, a bug that wrote one side - cannot
-- become a committed fact (INV-02, T-030).
--
-- Every transaction names its source operation, unique within the pool: a fill, a bootstrap
-- allocation, a reservation. Posting the same fill twice is a unique violation, which is what
-- makes reapplying an observation after a crash idempotent rather than double-counted.

CREATE TABLE ledger_transactions (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  ledger_txn_id      TEXT        NOT NULL,
  -- The transaction that created this row. Entries may only be added by that same database
  -- transaction, which is what makes the committed entry set final: see
  -- refuse_entry_after_commit() below.
  created_xid        XID8        NOT NULL DEFAULT pg_current_xact_id(),
  -- The pool's ledger revision this transaction produced. Strictly increasing per pool.
  revision           BIGINT      NOT NULL,
  source_kind        TEXT        NOT NULL,
  source_ref         TEXT        NOT NULL,
  description        TEXT        NOT NULL,
  posted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, ledger_txn_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  CONSTRAINT ledger_transactions_id_shape
    CHECK (ledger_txn_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT ledger_transactions_revision_positive CHECK (revision >= 1),
  CONSTRAINT ledger_transactions_revision_unique UNIQUE (workspace_id, pool_id, revision),
  CONSTRAINT ledger_transactions_source_unique
    UNIQUE (workspace_id, pool_id, epoch, source_kind, source_ref),
  -- Referenced by raw_observations.applied_ledger_txn_id through the complete tuple.
  CONSTRAINT ledger_transactions_scope_tuple UNIQUE (workspace_id, pool_id, epoch, ledger_txn_id)
);

-- Account kinds. ASSET_CONTROL mirrors what the venue holds; the claims partition it among
-- strategies and HOUSE (INV-04). The sign convention is a delta per entry; each account's
-- running balance is what the projection checks for nonnegativity.
CREATE TABLE ledger_entries (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  ledger_txn_id      TEXT        NOT NULL,
  entry_seq          INTEGER     NOT NULL,
  account_kind       TEXT        NOT NULL,
  -- 'HOUSE', 'ASSET_CONTROL' or a strategy id, depending on account_kind.
  account_owner      TEXT        NOT NULL,
  claim_state        TEXT        NOT NULL,
  asset_code         TEXT        NOT NULL,
  asset_scale        TEXT        NOT NULL,
  delta_atoms        NUMERIC(78, 0) NOT NULL,
  -- Which reservation a RESERVED movement belongs to. This is what makes a reservation's
  -- remainder a fact derived from postings rather than a number someone maintains: the
  -- remainder is the sum of these entries. Release compared against the reservation's
  -- original amount instead, so after a fill had consumed part of it, releasing the whole
  -- original drove the RESERVED claim negative.
  reservation_id     TEXT,
  PRIMARY KEY (workspace_id, pool_id, ledger_txn_id, entry_seq),
  FOREIGN KEY (workspace_id, pool_id, reservation_id)
    REFERENCES reservations (workspace_id, pool_id, reservation_id),
  FOREIGN KEY (workspace_id, pool_id, ledger_txn_id)
    REFERENCES ledger_transactions (workspace_id, pool_id, ledger_txn_id),
  CONSTRAINT ledger_entries_kind_known
    CHECK (account_kind IN ('ASSET_CONTROL', 'HOUSE', 'STRATEGY')),
  CONSTRAINT ledger_entries_owner_matches_kind CHECK (
    (account_kind = 'ASSET_CONTROL' AND account_owner = 'ASSET_CONTROL')
    OR (account_kind = 'HOUSE' AND account_owner = 'HOUSE')
    OR (account_kind = 'STRATEGY' AND account_owner NOT IN ('HOUSE', 'ASSET_CONTROL'))),
  -- ASSET_CONTROL has no claim state; claims are AVAILABLE, RESERVED or QUARANTINED.
  CONSTRAINT ledger_entries_claim_state_known CHECK (
    (account_kind = 'ASSET_CONTROL' AND claim_state = 'CONTROL')
    OR (account_kind <> 'ASSET_CONTROL' AND claim_state IN ('AVAILABLE', 'RESERVED', 'QUARANTINED'))),
  CONSTRAINT ledger_entries_delta_integral CHECK (delta_atoms = trunc(delta_atoms)),
  CONSTRAINT ledger_entries_delta_nonzero CHECK (delta_atoms <> 0),
  -- Every RESERVED movement is attributable, and only a RESERVED movement is.
  CONSTRAINT ledger_entries_reserved_names_its_reservation
    CHECK ((claim_state = 'RESERVED') = (reservation_id IS NOT NULL))
);

CREATE INDEX ledger_entries_by_account
  ON ledger_entries (workspace_id, pool_id, account_owner, asset_code, asset_scale);

-- A strategy-owned entry names a real strategy in this pool. The owner column also carries
-- 'HOUSE' and 'ASSET_CONTROL', so this cannot be a foreign key; the check is a trigger over
-- the same scope tuple, and it is the same guarantee reservations get from their key.
CREATE OR REPLACE FUNCTION refuse_unknown_strategy_owner() RETURNS trigger AS $$
BEGIN
  IF NEW.account_kind = 'STRATEGY' AND NOT EXISTS (
    SELECT 1 FROM strategies s
     WHERE s.workspace_id = NEW.workspace_id
       AND s.strategy_id = NEW.account_owner
       AND s.pool_id = (SELECT pool_id FROM pools p
                         WHERE p.workspace_id = NEW.workspace_id AND p.pool_id = NEW.pool_id)
  ) THEN
    RAISE EXCEPTION 'ledger entry names strategy % which does not exist in %/%',
      NEW.account_owner, NEW.workspace_id, NEW.pool_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_owner_is_real
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_unknown_strategy_owner();

-- Balanced per asset: for every transaction and asset, the control side equals the claims
-- side. Control entries carry the venue-facing change; claim entries partition it. So the
-- invariant is sum(control) = sum(claims) per asset, i.e. sum(control) - sum(claims) = 0.
-- Internal claim transfers (AVAILABLE -> RESERVED) have no control entry and sum to zero on
-- the claims side alone; the same predicate covers them.
CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced() RETURNS trigger AS $$
DECLARE
  unbalanced RECORD;
BEGIN
  SELECT e.asset_code, e.asset_scale,
         sum(CASE WHEN e.account_kind = 'ASSET_CONTROL' THEN e.delta_atoms ELSE 0 END) AS control,
         sum(CASE WHEN e.account_kind <> 'ASSET_CONTROL' THEN e.delta_atoms ELSE 0 END) AS claims
    INTO unbalanced
    FROM ledger_entries e
   WHERE e.workspace_id = NEW.workspace_id AND e.pool_id = NEW.pool_id
     AND e.ledger_txn_id = NEW.ledger_txn_id
   GROUP BY e.asset_code, e.asset_scale
  HAVING sum(CASE WHEN e.account_kind = 'ASSET_CONTROL' THEN e.delta_atoms ELSE 0 END)
      <> sum(CASE WHEN e.account_kind <> 'ASSET_CONTROL' THEN e.delta_atoms ELSE 0 END)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced for %:% (control % vs claims %)',
      NEW.ledger_txn_id, unbalanced.asset_code, unbalanced.asset_scale,
      unbalanced.control, unbalanced.claims
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A transaction with no entries is not a transaction.
  IF NOT EXISTS (
    SELECT 1 FROM ledger_entries e
     WHERE e.workspace_id = NEW.workspace_id AND e.pool_id = NEW.pool_id
       AND e.ledger_txn_id = NEW.ledger_txn_id) THEN
    RAISE EXCEPTION 'ledger transaction % has no entries', NEW.ledger_txn_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_transactions_balance_at_commit
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE TRIGGER ledger_transactions_are_immutable
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- A committed transaction's entry set is final.
--
-- Making the existing rows UPDATE- and DELETE-proof is not enough: the balance check is a
-- deferred trigger on ledger_transactions, so it fires once, at the commit that inserted the
-- parent row. A later transaction could INSERT another entry against that same
-- ledger_txn_id and no balance check would fire at all - a probe appended a +999 claim to a
-- committed transaction and left control at 10 against claims of 1009.
--
-- So entries may only be inserted by the same database transaction that created their parent.
-- Atomic creation of a posting and all its entries is unaffected; every later append is
-- refused, whether it would balance or not, because a balanced append is still a change to a
-- record that was already final.
CREATE OR REPLACE FUNCTION refuse_entry_after_commit() RETURNS trigger AS $$
DECLARE
  parent_xid XID8;
BEGIN
  SELECT created_xid INTO parent_xid FROM ledger_transactions
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND ledger_txn_id = NEW.ledger_txn_id;
  IF NOT FOUND THEN
    -- The foreign key reports this; reaching here means the parent is not visible to us.
    RAISE EXCEPTION 'ledger transaction % does not exist', NEW.ledger_txn_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_xid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'ledger transaction % is committed; its entries are final', NEW.ledger_txn_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_belong_to_their_posting
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_entry_after_commit();

-- No claim aggregate may end a transaction negative (INV-03).
--
-- Balancing per asset is not the same guarantee. A posting that moves 14,000 out of a
-- RESERVED claim holding nothing and into AVAILABLE balances perfectly and leaves the
-- reservation at -14,000; only the projection rebuild noticed, and only later. Deferred, so
-- it reads the state the transaction actually commits, and applied per affected owner, asset
-- and claim state - and per reservation, so a release cannot exceed its own remainder even
-- when the strategy holds other reservations in the same asset.
CREATE OR REPLACE FUNCTION assert_claims_nonnegative() RETURNS trigger AS $$
DECLARE
  total NUMERIC;
BEGIN
  IF NEW.account_kind = 'ASSET_CONTROL' THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(delta_atoms), 0) INTO total FROM ledger_entries
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND account_owner = NEW.account_owner AND asset_code = NEW.asset_code
     AND asset_scale = NEW.asset_scale AND claim_state = NEW.claim_state;
  IF total < 0 THEN
    RAISE EXCEPTION '% claim for %:% held by % would be negative (%)',
      NEW.claim_state, NEW.asset_code, NEW.asset_scale, NEW.account_owner, total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.reservation_id IS NOT NULL THEN
    SELECT coalesce(sum(delta_atoms), 0) INTO total FROM ledger_entries
     WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
       AND reservation_id = NEW.reservation_id;
    IF total < 0 THEN
      RAISE EXCEPTION 'reservation % would be over-consumed (%)', NEW.reservation_id, total
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_claims_stay_nonnegative
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_claims_nonnegative();

CREATE TRIGGER ledger_entries_are_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Raw observations
-- --------------------------------------------------------------------------------------
--
-- What a source said, verbatim and once. Immutable. Applying an observation to the ledger is
-- a separate, later act, recorded by applied_ledger_txn_id, so a crash between persisting an
-- observation and posting its effect leaves a replayable fact rather than nothing (T-030).

CREATE TABLE raw_observations (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  observation_id     TEXT        NOT NULL,
  source             TEXT        NOT NULL,
  kind               TEXT        NOT NULL,
  -- The source's own reference for this fact (e.g. venue trade id, stream event id). With
  -- source and kind, unique within the epoch: the dedupe boundary for duplicate boundary rows
  -- across pages or across REST and stream.
  source_ref         TEXT        NOT NULL,
  source_event_time  TIMESTAMPTZ,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload            JSONB       NOT NULL,
  payload_digest     TEXT        NOT NULL,
  applied_ledger_txn_id TEXT,
  PRIMARY KEY (workspace_id, pool_id, observation_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  CONSTRAINT raw_observations_id_shape
    CHECK (observation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT raw_observations_source_known CHECK (source IN ('rest', 'stream', 'operator')),
  CONSTRAINT raw_observations_source_unique
    UNIQUE (workspace_id, pool_id, epoch, source, kind, source_ref),
  -- Referenced by venue_fills through the complete tuple, so a fill in one epoch cannot cite
  -- evidence recorded in another.
  CONSTRAINT raw_observations_scope_tuple UNIQUE (workspace_id, pool_id, epoch, observation_id),
  -- An applied observation names a real ledger transaction in its own scope. Without this the
  -- column accepted any string, so a row could claim an effect that was never posted.
  FOREIGN KEY (workspace_id, pool_id, epoch, applied_ledger_txn_id)
    REFERENCES ledger_transactions (workspace_id, pool_id, epoch, ledger_txn_id)
);

CREATE OR REPLACE FUNCTION refuse_observation_change() RETURNS trigger AS $$
BEGIN
  -- The only permitted change: recording that the observation was applied, once.
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.source_event_time IS DISTINCT FROM OLD.source_event_time
     OR NEW.ingested_at IS DISTINCT FROM OLD.ingested_at
     OR NEW.epoch IS DISTINCT FROM OLD.epoch
     OR (OLD.applied_ledger_txn_id IS NOT NULL
         AND NEW.applied_ledger_txn_id IS DISTINCT FROM OLD.applied_ledger_txn_id) THEN
    RAISE EXCEPTION 'raw observation % is immutable evidence', OLD.observation_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER raw_observations_are_evidence
  BEFORE UPDATE ON raw_observations
  FOR EACH ROW EXECUTE FUNCTION refuse_observation_change();

CREATE TRIGGER raw_observations_are_never_deleted
  BEFORE DELETE ON raw_observations
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Venue orders and fills
-- --------------------------------------------------------------------------------------
--
-- Identity is (workspace, pool, epoch, symbol, venue order id) and, for a fill, plus the
-- venue trade id (TDD section 4). A venue id reused across symbols, accounts or epochs is a
-- different row and can never collide or cross-link (T-031).

CREATE TABLE venue_orders (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  symbol             TEXT        NOT NULL,
  venue_order_id     TEXT        NOT NULL,
  client_order_id    TEXT,
  status             TEXT        NOT NULL,
  first_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  version            INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, pool_id, epoch, symbol, venue_order_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  -- A venue order that correlates to one of our attempts names it through the complete scope
  -- tuple; a client id observed on the venue that we never marked is external activity, kept
  -- with a NULL reference rather than invented. NULL skips the check, as MATCH SIMPLE does.
  FOREIGN KEY (workspace_id, pool_id, epoch, client_order_id)
    REFERENCES dispatch_attempts (workspace_id, pool_id, epoch, client_order_id),
  CONSTRAINT venue_orders_symbol_shape CHECK (symbol ~ '^[A-Z0-9]{2,20}$'),
  CONSTRAINT venue_orders_status_known CHECK (status IN
    ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'PENDING_CANCEL', 'EXPIRED',
     'EXPIRED_IN_MATCH', 'REJECTED', 'UNSUPPORTED_OBSERVATION')),
  CONSTRAINT venue_orders_version_positive CHECK (version >= 1)
);

CREATE TRIGGER venue_orders_are_never_deleted
  BEFORE DELETE ON venue_orders
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE venue_fills (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  symbol             TEXT        NOT NULL,
  venue_order_id     TEXT        NOT NULL,
  venue_trade_id     TEXT        NOT NULL,
  observation_id     TEXT        NOT NULL,
  base_atoms         NUMERIC(78, 0) NOT NULL,
  quote_atoms        NUMERIC(78, 0) NOT NULL,
  commission_asset   TEXT        NOT NULL,
  commission_atoms   NUMERIC(78, 0) NOT NULL,
  traded_at          TIMESTAMPTZ NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, epoch, symbol, venue_order_id, venue_trade_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, symbol, venue_order_id)
    REFERENCES venue_orders (workspace_id, pool_id, epoch, symbol, venue_order_id),
  -- Including the epoch: an epoch-2 fill citing epoch-1 evidence is a cross-epoch link, and
  -- epochs exist precisely so that identities from before a reset cannot reach across.
  FOREIGN KEY (workspace_id, pool_id, epoch, observation_id)
    REFERENCES raw_observations (workspace_id, pool_id, epoch, observation_id),
  CONSTRAINT venue_fills_base_integral CHECK (base_atoms = trunc(base_atoms) AND base_atoms >= 0),
  CONSTRAINT venue_fills_quote_integral CHECK (quote_atoms = trunc(quote_atoms) AND quote_atoms >= 0),
  CONSTRAINT venue_fills_commission_integral
    CHECK (commission_atoms = trunc(commission_atoms) AND commission_atoms >= 0)
);

CREATE TRIGGER venue_fills_are_immutable
  BEFORE UPDATE OR DELETE ON venue_fills
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Claim balances: a projection, never a source
-- --------------------------------------------------------------------------------------
--
-- Derived from ledger_entries and nothing else. The application has no write path to this
-- table: the trigger below refuses any write unless the rebuild function has set the session
-- flag it clears on exit, so a balance can only ever be what the entries say (INV-16).

CREATE TABLE claim_balances (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  account_owner      TEXT        NOT NULL,
  asset_code         TEXT        NOT NULL,
  asset_scale        TEXT        NOT NULL,
  available_atoms    NUMERIC(78, 0) NOT NULL DEFAULT 0,
  reserved_atoms     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  quarantined_atoms  NUMERIC(78, 0) NOT NULL DEFAULT 0,
  -- The revision the projection was rebuilt at. Compared with pools.ledger_revision.
  ledger_revision    BIGINT      NOT NULL,
  rebuilt_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, account_owner, asset_code, asset_scale),
  FOREIGN KEY (workspace_id, pool_id) REFERENCES pools (workspace_id, pool_id),
  -- Claims are nonnegative (INV-03). A rebuild that would produce a negative claim is
  -- refused, which surfaces an unbalanced history instead of hiding it in a plug.
  CONSTRAINT claim_balances_nonnegative
    CHECK (available_atoms >= 0 AND reserved_atoms >= 0 AND quarantined_atoms >= 0),
  CONSTRAINT claim_balances_integral CHECK (
    available_atoms = trunc(available_atoms) AND reserved_atoms = trunc(reserved_atoms)
    AND quarantined_atoms = trunc(quarantined_atoms))
);

CREATE OR REPLACE FUNCTION refuse_direct_balance_write() RETURNS trigger AS $$
BEGIN
  IF current_setting('capitaldesk.projection_rebuild', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'claim_balances is a projection; write ledger entries and rebuild it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_balances_are_derived
  BEFORE INSERT OR UPDATE OR DELETE ON claim_balances
  FOR EACH ROW EXECUTE FUNCTION refuse_direct_balance_write();

-- Rebuild a pool's projection from its entries, and record the revision it reflects. The
-- session flag is set and cleared inside this function; it is LOCAL to the transaction so an
-- error cannot leave it on.
CREATE OR REPLACE FUNCTION rebuild_claim_balances(p_workspace_id TEXT, p_pool_id TEXT)
RETURNS BIGINT AS $$
DECLARE
  at_revision BIGINT;
BEGIN
  SELECT ledger_revision INTO at_revision FROM pools
   WHERE workspace_id = p_workspace_id AND pool_id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pool %/% does not exist', p_workspace_id, p_pool_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM set_config('capitaldesk.projection_rebuild', 'on', true);
  DELETE FROM claim_balances WHERE workspace_id = p_workspace_id AND pool_id = p_pool_id;
  INSERT INTO claim_balances
    (workspace_id, pool_id, account_owner, asset_code, asset_scale,
     available_atoms, reserved_atoms, quarantined_atoms, ledger_revision)
  SELECT e.workspace_id, e.pool_id, e.account_owner, e.asset_code, e.asset_scale,
         coalesce(sum(e.delta_atoms) FILTER (WHERE e.claim_state = 'AVAILABLE'), 0),
         coalesce(sum(e.delta_atoms) FILTER (WHERE e.claim_state = 'RESERVED'), 0),
         coalesce(sum(e.delta_atoms) FILTER (WHERE e.claim_state = 'QUARANTINED'), 0),
         at_revision
    FROM ledger_entries e
   WHERE e.workspace_id = p_workspace_id AND e.pool_id = p_pool_id
     AND e.account_kind <> 'ASSET_CONTROL'
   GROUP BY e.workspace_id, e.pool_id, e.account_owner, e.asset_code, e.asset_scale;
  PERFORM set_config('capitaldesk.projection_rebuild', 'off', true);
  RETURN at_revision;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------------------
-- Outbox and job leases
-- --------------------------------------------------------------------------------------
--
-- The outbox row is written in the same transaction as the economic change it announces, so
-- there is no committed change without its message and no message without its change. A
-- dispatch message is single-attempt by constraint: a blind retry of an order placement is
-- the one thing this system must never do (INV-09).

CREATE TABLE outbox (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  outbox_id          TEXT        NOT NULL,
  kind               TEXT        NOT NULL,
  payload            JSONB       NOT NULL,
  max_attempts       INTEGER     NOT NULL DEFAULT 5,
  attempts           INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Held by a consumer until this time; another consumer may claim it afterwards.
  leased_until       TIMESTAMPTZ,
  leased_by          TEXT,
  published_at       TIMESTAMPTZ,
  dead_lettered_at   TIMESTAMPTZ,
  dead_letter_reason TEXT,
  -- Set by the restore posture: a message from before a restore is never drained (T-035).
  quarantined_at     TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, pool_id, outbox_id),
  FOREIGN KEY (workspace_id, pool_id) REFERENCES pools (workspace_id, pool_id),
  CONSTRAINT outbox_id_shape CHECK (outbox_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT outbox_attempts_bounded CHECK (attempts >= 0 AND max_attempts >= 1),
  CONSTRAINT outbox_dispatch_is_single_attempt
    CHECK (kind NOT LIKE 'dispatch.%' OR max_attempts = 1),
  CONSTRAINT outbox_dead_letter_together
    CHECK ((dead_lettered_at IS NULL) = (dead_letter_reason IS NULL)),
  CONSTRAINT outbox_lease_together CHECK ((leased_until IS NULL) = (leased_by IS NULL))
);

CREATE INDEX outbox_pending
  ON outbox (workspace_id, pool_id, created_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL AND quarantined_at IS NULL;

-- Attempts never exceed the bound, whichever writer counts them. The claim path checks this
-- too; the constraint is what holds when something else does not.
ALTER TABLE outbox ADD CONSTRAINT outbox_attempts_within_bound CHECK (attempts <= max_attempts);

CREATE TRIGGER outbox_is_never_deleted
  BEFORE DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Worker leases with a fencing token. The token increases on every acquisition, so a holder
-- whose lease expired and was taken over presents a stale token and is refused on renew.
--
-- This fences the database only. It does not fence the venue: a sender that already holds a
-- marker may still complete its send after its lease expires, which is why lease expiry never
-- authorizes a resend (TDD section 9).
CREATE TABLE job_leases (
  lease_key          TEXT        NOT NULL PRIMARY KEY,
  holder_id          TEXT        NOT NULL,
  fencing_token      BIGINT      NOT NULL,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  CONSTRAINT job_leases_token_positive CHECK (fencing_token >= 1),
  CONSTRAINT job_leases_expiry_after_acquisition CHECK (expires_at > acquired_at)
);

-- --------------------------------------------------------------------------------------
-- Idempotency results and economic tombstones
-- --------------------------------------------------------------------------------------
--
-- One row per (scope, key), forever. The stored response may be discarded after its retention
-- period; the row - the tombstone - is never removed, so an expired response can never let
-- the same key perform a second economic action (INV-11, TDD section 11).

CREATE TABLE idempotency_results (
  scope_kind         TEXT        NOT NULL,
  scope_id           TEXT        NOT NULL,
  idempotency_key    TEXT        NOT NULL,
  request_digest     TEXT        NOT NULL,
  action             TEXT        NOT NULL,
  -- What the action produced, by reference: a plan id, a reservation id, a ledger txn.
  economic_ref       TEXT,
  response_status    INTEGER     NOT NULL,
  response_body      JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, idempotency_key),
  CONSTRAINT idempotency_scope_known
    CHECK (scope_kind IN ('pool', 'workspace', 'strategyTarget', 'credential')),
  CONSTRAINT idempotency_status_http CHECK (response_status BETWEEN 100 AND 599)
);

CREATE OR REPLACE FUNCTION refuse_tombstone_change() RETURNS trigger AS $$
BEGIN
  -- The only permitted change is discarding the response body once its retention lapses.
  IF NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.economic_ref IS DISTINCT FROM OLD.economic_ref
     OR NEW.response_status IS DISTINCT FROM OLD.response_status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.response_expires_at IS DISTINCT FROM OLD.response_expires_at
     OR (NEW.response_body IS NOT NULL AND NEW.response_body IS DISTINCT FROM OLD.response_body) THEN
    RAISE EXCEPTION 'idempotency record % is a permanent tombstone', OLD.idempotency_key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER idempotency_results_are_tombstones
  BEFORE UPDATE ON idempotency_results
  FOR EACH ROW EXECUTE FUNCTION refuse_tombstone_change();

CREATE TRIGGER idempotency_results_are_never_deleted
  BEFORE DELETE ON idempotency_results
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- --------------------------------------------------------------------------------------
-- Pools reference their lease
-- --------------------------------------------------------------------------------------

-- Strategies keep their economic records when archived: nothing above cascades, and no
-- delete path exists. strategies.archived_at is the only change archival makes.
