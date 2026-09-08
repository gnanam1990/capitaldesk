-- Module 06: the account baseline and owner allocation records.
--
-- A forward migration. It does alter tables from 0003 and 0004, and says so plainly: the
-- epoch isolation below adds a column to `ledger_entries`, replaces the primary key of
-- `claim_balances`, redefines `rebuild_claim_balances` and `assert_claims_nonnegative`, and
-- adds a unique tuple to `venue_observation_cuts`. What it does not do is edit those
-- migrations' own files, which are already applied wherever this product runs.
--
-- Two records exist that the ledger alone cannot express. A *baseline* is the statement that
-- one pool's opening position was established once, from one named observation cut, under one
-- epoch and one authenticated account: the ledger holds the postings, but nothing in it says
-- "this is the opening, and there is only one". An *allocation* is an owner's internal
-- decision, which must be distinguishable from a venue movement forever after — the postings
-- it produces look like any other claim transfer, and only this record says who authorised it
-- and under what revision.

-- `venue_observation_cuts` from 0004 is keyed by (workspace, pool, cut). A baseline references
-- the cut *within its epoch*, so the four-column tuple needs its own unique constraint before
-- a foreign key can name it. Added here rather than by editing 0004, which is already applied
-- wherever this product runs.
ALTER TABLE venue_observation_cuts
  ADD CONSTRAINT venue_observation_cuts_scope_tuple
  UNIQUE (workspace_id, pool_id, epoch, cut_id);

CREATE TABLE account_baselines (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  baseline_id        TEXT        NOT NULL,
  -- The account this baseline speaks for, as the venue authenticated it. Not a credential
  -- alias: two aliases can name one account and one alias can be rotated onto another.
  stable_account_id  TEXT        NOT NULL,
  environment        TEXT        NOT NULL,
  -- The observation cut this opening was taken from. A baseline with no cut is an assertion.
  cut_id             TEXT        NOT NULL,
  -- The ledger transaction that posted the opening balances, so the two are inseparable.
  -- Null only when the opening had no balances at all: an empty opening posts nothing, and
  -- naming an empty transaction would be worse than saying so.
  ledger_txn_id      TEXT,
  -- Every asset this pool was configured to account for when the baseline was taken. Recorded
  -- rather than re-derived later: the configuration can change, and a baseline's coverage
  -- claim is about the set that applied at the time.
  supported_assets   JSONB       NOT NULL,
  -- Assets deliberately excluded, and history that predates this opening. Kept because
  -- T-042 requires the exclusions stay visible: an incomplete starting cost basis cannot
  -- later be presented as a complete one.
  excluded_assets    JSONB       NOT NULL,
  -- Whether cost basis before this opening is known. It is not, for a baseline taken from a
  -- balance snapshot, and saying so is the whole point.
  cost_basis_known   BOOLEAN     NOT NULL,
  established_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, baseline_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  FOREIGN KEY (workspace_id, pool_id, epoch, cut_id)
    REFERENCES venue_observation_cuts (workspace_id, pool_id, epoch, cut_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, ledger_txn_id)
    REFERENCES ledger_transactions (workspace_id, pool_id, epoch, ledger_txn_id),
  CONSTRAINT account_baselines_id_shape
    CHECK (baseline_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT account_baselines_environment_known
    CHECK (environment IN ('local', 'testnet', 'production')),
  CONSTRAINT account_baselines_supported_is_array CHECK (jsonb_typeof(supported_assets) = 'array'),
  CONSTRAINT account_baselines_excluded_is_array CHECK (jsonb_typeof(excluded_assets) = 'array'),
  -- One opening per pool and epoch. A second bootstrap would give the same units two owners
  -- (T-056), and a reset that opens a new epoch is the supported way to take a new one.
  CONSTRAINT account_baselines_one_per_epoch UNIQUE (workspace_id, pool_id, epoch)
);

CREATE TRIGGER account_baselines_are_append_only
  BEFORE UPDATE OR DELETE ON account_baselines
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- A baseline belongs to the account its pool governs, in the environment its pool runs in.
--
-- Without this the columns accepted any string, so a baseline read from one account could be
-- filed against a pool governing another — which is the opening every later claim descends
-- from.
CREATE OR REPLACE FUNCTION refuse_foreign_account_baseline() RETURNS trigger AS $$
DECLARE
  governed TEXT;
  pool_environment TEXT;
BEGIN
  SELECT stable_account_id, environment INTO governed, pool_environment FROM pools
    WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id;
  IF governed IS NULL THEN
    RAISE EXCEPTION 'baseline % names no known pool', NEW.baseline_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF governed <> NEW.stable_account_id THEN
    RAISE EXCEPTION 'baseline % is for account % but the pool governs %',
      NEW.baseline_id, NEW.stable_account_id, governed
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF pool_environment <> NEW.environment THEN
    RAISE EXCEPTION 'baseline % is for environment % but the pool runs in %',
      NEW.baseline_id, NEW.environment, pool_environment
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_baselines_match_the_pool
  BEFORE INSERT ON account_baselines
  FOR EACH ROW EXECUTE FUNCTION refuse_foreign_account_baseline();

CREATE TRIGGER account_baselines_require_an_open_epoch
  BEFORE INSERT ON account_baselines
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_epoch_read_state();

-- An owner's internal allocation.
--
-- The postings it produces look like any other AVAILABLE claim transfer. This record is what
-- says an owner authorised it, under which revision, and that it moved nothing at the venue —
-- a distinction the TDD requires to survive into every later report.
CREATE TABLE owner_allocations (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  allocation_id      TEXT        NOT NULL,
  -- Monotonic per pool and epoch, so replays and orderings are decidable without timestamps.
  revision           INTEGER     NOT NULL,
  from_owner         TEXT        NOT NULL,
  to_owner           TEXT        NOT NULL,
  asset_code         TEXT        NOT NULL,
  asset_scale        TEXT        NOT NULL,
  atoms              NUMERIC(78, 0) NOT NULL,
  -- The owner session that authorised it. Provenance, not a route parameter.
  authorized_by      TEXT        NOT NULL,
  ledger_txn_id      TEXT        NOT NULL,
  allocated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, allocation_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  FOREIGN KEY (workspace_id, pool_id, epoch, ledger_txn_id)
    REFERENCES ledger_transactions (workspace_id, pool_id, epoch, ledger_txn_id),
  CONSTRAINT owner_allocations_id_shape
    CHECK (allocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT owner_allocations_revision_positive CHECK (revision >= 1),
  CONSTRAINT owner_allocations_revision_unique UNIQUE (workspace_id, pool_id, epoch, revision),
  CONSTRAINT owner_allocations_positive CHECK (atoms > 0 AND atoms = trunc(atoms)),
  -- Exactly one leg is HOUSE, and neither is ASSET_CONTROL. A strategy-to-strategy move would
  -- look like a sale that never happened, and a leg on control is how units lose their owner.
  CONSTRAINT owner_allocations_one_house_leg CHECK (
    (from_owner = 'HOUSE') <> (to_owner = 'HOUSE')),
  CONSTRAINT owner_allocations_never_control CHECK (
    from_owner <> 'ASSET_CONTROL' AND to_owner <> 'ASSET_CONTROL'),
  CONSTRAINT owner_allocations_distinct_parties CHECK (from_owner <> to_owner)
);

CREATE TRIGGER owner_allocations_are_append_only
  BEFORE UPDATE OR DELETE ON owner_allocations
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER owner_allocations_require_an_open_epoch
  BEFORE INSERT ON owner_allocations
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_epoch_read_state();

-- The strategy leg of an allocation names a real strategy in this pool.
--
-- A composite foreign key cannot express "whichever of these two columns is not HOUSE", so it
-- is a trigger. Without it an allocation could credit a strategy id that does not exist, and
-- the claim would have an owner nothing else in the system knows.
CREATE OR REPLACE FUNCTION refuse_unknown_allocation_strategy() RETURNS trigger AS $$
DECLARE
  strategy TEXT;
  found INTEGER;
BEGIN
  strategy := CASE WHEN NEW.from_owner = 'HOUSE' THEN NEW.to_owner ELSE NEW.from_owner END;
  SELECT count(*) INTO found FROM strategies
    WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id AND strategy_id = strategy
      AND archived_at IS NULL;
  IF found <> 1 THEN
    RAISE EXCEPTION 'allocation % names strategy %, which is not an active strategy of this pool',
      NEW.allocation_id, strategy
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER owner_allocations_name_a_real_strategy
  BEFORE INSERT ON owner_allocations
  FOR EACH ROW EXECUTE FUNCTION refuse_unknown_allocation_strategy();

-- --------------------------------------------------------------------------------------
-- Epoch isolation for the claim model (T-032)
--
-- An epoch exists so that a venue reset cannot let old funds become current authority. The
-- ledger recorded the epoch on each transaction but not on its entries, and every economic
-- read summed entries across the whole pool — so after a rotation a closed epoch's opening
-- was still spendable, still counted in the projection, and still satisfied conservation.
-- History must be preserved and queryable; what must not survive is its authority.
--
-- The entry gains the epoch of the transaction that created it. Denormalised deliberately:
-- every economic sum then scopes naturally, and the constraints that guard them can be local
-- rather than joining on each evaluation.

ALTER TABLE ledger_entries ADD COLUMN epoch INTEGER;

UPDATE ledger_entries e
   SET epoch = t.epoch
  FROM ledger_transactions t
 WHERE t.workspace_id = e.workspace_id AND t.pool_id = e.pool_id
   AND t.ledger_txn_id = e.ledger_txn_id;

ALTER TABLE ledger_entries ALTER COLUMN epoch SET NOT NULL;

-- The entry's epoch is its transaction's epoch, not an independent claim. A row asserting
-- otherwise would move a posting between epochs and take its authority with it.
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_transaction_scope
  FOREIGN KEY (workspace_id, pool_id, epoch, ledger_txn_id)
  REFERENCES ledger_transactions (workspace_id, pool_id, epoch, ledger_txn_id);

CREATE INDEX ledger_entries_by_epoch_owner_asset
  ON ledger_entries (workspace_id, pool_id, epoch, account_owner, asset_code, asset_scale);

-- The projection is per epoch, so a rotation starts a fresh view without deleting the old.
--
-- Two things make this awkward on a populated database, and both were wrong in the first
-- draft. `claim_balances` already carries the guard that refuses any write outside a
-- derived rebuild, so a plain UPDATE here fails on a database that has rows; and hard-coding
-- the existing rows to epoch 1 would invent an epoch for every pool that had already rotated,
-- silently attributing an old epoch's balances to a new one.
--
-- The projection is derived state, so it is not migrated at all: the rows are discarded under
-- the guard's own flag and rebuilt from the immutable entries, which now carry their true
-- epoch. History is preserved because the entries are, and every epoch reappears with its own
-- figures rather than one guessed value.
ALTER TABLE claim_balances ADD COLUMN epoch INTEGER;
ALTER TABLE claim_balances DROP CONSTRAINT claim_balances_pkey;

SELECT set_config('capitaldesk.projection_rebuild', 'on', false);
DELETE FROM claim_balances;
SELECT set_config('capitaldesk.projection_rebuild', 'off', false);

ALTER TABLE claim_balances ALTER COLUMN epoch SET NOT NULL;
ALTER TABLE claim_balances
  ADD CONSTRAINT claim_balances_pkey
  PRIMARY KEY (workspace_id, pool_id, epoch, account_owner, asset_code, asset_scale);

-- Rebuild, per epoch. Every epoch is rebuilt, so the old view stays queryable and the new
-- one starts from its own postings alone.
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
    (workspace_id, pool_id, epoch, account_owner, asset_code, asset_scale,
     available_atoms, reserved_atoms, quarantined_atoms, ledger_revision)
  SELECT e.workspace_id, e.pool_id, e.epoch, e.account_owner, e.asset_code, e.asset_scale,
         coalesce(sum(e.delta_atoms) FILTER (WHERE e.claim_state = 'AVAILABLE'), 0),
         coalesce(sum(e.delta_atoms) FILTER (WHERE e.claim_state = 'RESERVED'), 0),
         coalesce(sum(e.delta_atoms) FILTER (WHERE e.claim_state = 'QUARANTINED'), 0),
         at_revision
    FROM ledger_entries e
   WHERE e.workspace_id = p_workspace_id AND e.pool_id = p_pool_id
     AND e.account_kind <> 'ASSET_CONTROL'
   GROUP BY e.workspace_id, e.pool_id, e.epoch, e.account_owner, e.asset_code, e.asset_scale;

  RETURN at_revision;
END;
$$ LANGUAGE plpgsql;

-- Claims are non-negative within their own epoch. Summing across epochs let a closed epoch's
-- surplus cover a current shortfall, which is precisely the authority a reset removes.
CREATE OR REPLACE FUNCTION assert_claims_nonnegative() RETURNS trigger AS $$
DECLARE
  total NUMERIC;
BEGIN
  IF NEW.account_kind = 'ASSET_CONTROL' THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(delta_atoms), 0) INTO total FROM ledger_entries
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id AND epoch = NEW.epoch
     AND account_owner = NEW.account_owner AND asset_code = NEW.asset_code
     AND asset_scale = NEW.asset_scale AND claim_state = NEW.claim_state;
  IF total < 0 THEN
    RAISE EXCEPTION '% claim for %:% held by % would be negative (%) in epoch %',
      NEW.claim_state, NEW.asset_code, NEW.asset_scale, NEW.account_owner, total, NEW.epoch
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.reservation_id IS NOT NULL THEN
    -- Within the epoch as well. A reservation id is unique per pool, not per epoch, so an
    -- unscoped subtotal let a closed epoch's remainder cover an over-consumption in the
    -- current one — the same cross-subsidy the claim check above exists to prevent.
    SELECT coalesce(sum(delta_atoms), 0) INTO total FROM ledger_entries
     WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id AND epoch = NEW.epoch
       AND reservation_id = NEW.reservation_id;
    IF total < 0 THEN
      RAISE EXCEPTION 'reservation % would be over-consumed (%) in epoch %',
        NEW.reservation_id, total, NEW.epoch
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------------------
-- Database backstops
--
-- Everything above is enforced by the service that writes it. A direct writer bypasses that
-- service, and these records are the ones every later claim descends from — so the rules that
-- matter economically are stated here too, where nothing can go around them.

-- An unproven cost basis cannot be declared proven.
--
-- Every baseline in this build is taken from a balance snapshot: it records what is held, not
-- what it cost. A direct writer setting this true would make unknown history look tax- and
-- P&L-ready. The constraint is removed by the migration that introduces a proven basis, and
-- not before.
ALTER TABLE account_baselines
  ADD CONSTRAINT account_baselines_cost_basis_unproven CHECK (cost_basis_known = FALSE);

-- A baseline cites a cut that was actually complete, and postings that match it.
--
-- The foreign key proves the cut exists; it says nothing about the cut's verdict, about the
-- transaction the baseline names, or about whether "no postings" is consistent with what the
-- closing snapshot held.
CREATE OR REPLACE FUNCTION refuse_unsupported_baseline() RETURNS trigger AS $$
DECLARE
  cut          venue_observation_cuts%ROWTYPE;
  closing      venue_account_snapshots%ROWTYPE;
  snapshot_total NUMERIC;
  txn          ledger_transactions%ROWTYPE;
  control_total NUMERIC;
  house_total  NUMERIC;
  entry_count  INTEGER;
BEGIN
  SELECT * INTO cut FROM venue_observation_cuts
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND epoch = NEW.epoch AND cut_id = NEW.cut_id;
  IF cut.cut_id IS NULL THEN
    RAISE EXCEPTION 'baseline % names no cut in its scope', NEW.baseline_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF cut.coverage_state <> 'COMPLETE'
     OR cut.detection_scope <> 'FULL_WITHIN_PROVEN_UNIVERSE' THEN
    RAISE EXCEPTION 'baseline % cites cut % whose coverage is %/%',
      NEW.baseline_id, NEW.cut_id, cut.coverage_state, cut.detection_scope
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT * INTO closing FROM venue_account_snapshots
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND epoch = NEW.epoch AND snapshot_id = cut.closing_snapshot_id;

  -- Total units the closing snapshot says the account holds, free plus locked.
  SELECT coalesce(sum((b->>'freeAtoms')::NUMERIC + (b->>'lockedAtoms')::NUMERIC), 0)
    INTO snapshot_total
    FROM jsonb_array_elements(closing.balances) AS b;

  IF NEW.ledger_txn_id IS NULL THEN
    -- "No postings" is only consistent with an account that held nothing.
    IF snapshot_total <> 0 THEN
      RAISE EXCEPTION 'baseline % claims no postings but its closing snapshot holds %',
        NEW.baseline_id, snapshot_total
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO txn FROM ledger_transactions
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND epoch = NEW.epoch AND ledger_txn_id = NEW.ledger_txn_id;
  IF txn.ledger_txn_id IS NULL THEN
    RAISE EXCEPTION 'baseline % names no transaction in its scope', NEW.baseline_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The transaction must be this baseline's own opening, not some other posting.
  IF txn.source_kind <> 'baseline' OR txn.source_ref <> NEW.baseline_id THEN
    RAISE EXCEPTION 'baseline % cites transaction % sourced from %/%',
      NEW.baseline_id, NEW.ledger_txn_id, txn.source_kind, txn.source_ref
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT
    coalesce(sum(delta_atoms) FILTER (WHERE account_kind = 'ASSET_CONTROL'), 0),
    coalesce(sum(delta_atoms) FILTER (WHERE account_kind = 'HOUSE' AND claim_state = 'AVAILABLE'), 0),
    count(*)
    INTO control_total, house_total, entry_count
    FROM ledger_entries
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND ledger_txn_id = NEW.ledger_txn_id;

  -- An opening credits control and HOUSE by the same amount, and by exactly what the snapshot
  -- says the account holds. Anything else is an opening that does not match its evidence.
  IF control_total <> snapshot_total OR house_total <> snapshot_total THEN
    RAISE EXCEPTION 'baseline % posts control % and HOUSE % against a snapshot holding %',
      NEW.baseline_id, control_total, house_total, snapshot_total
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF entry_count = 0 THEN
    RAISE EXCEPTION 'baseline % names a transaction with no entries', NEW.baseline_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER account_baselines_match_their_evidence
  AFTER INSERT ON account_baselines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refuse_unsupported_baseline();

-- An allocation cites its own transaction, and exactly the two entries it describes.
--
-- Without this a row could name another allocation's transaction — which is a second
-- authorisation record pointing at one movement, and reads afterwards as two movements.
CREATE OR REPLACE FUNCTION refuse_unsupported_allocation() RETURNS trigger AS $$
DECLARE
  baseline_rows INTEGER;
  txn           ledger_transactions%ROWTYPE;
  entry_count   INTEGER;
  debit_total   NUMERIC;
  credit_total  NUMERIC;
BEGIN
  -- Claims cannot be moved before an opening establishes them.
  SELECT count(*) INTO baseline_rows FROM account_baselines
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id AND epoch = NEW.epoch;
  IF baseline_rows <> 1 THEN
    RAISE EXCEPTION 'allocation % has no account baseline for epoch %',
      NEW.allocation_id, NEW.epoch
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT * INTO txn FROM ledger_transactions
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND epoch = NEW.epoch AND ledger_txn_id = NEW.ledger_txn_id;
  IF txn.ledger_txn_id IS NULL THEN
    RAISE EXCEPTION 'allocation % names no transaction in its scope', NEW.allocation_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF txn.source_kind <> 'owner-allocation' OR txn.source_ref <> NEW.allocation_id THEN
    RAISE EXCEPTION 'allocation % cites transaction % sourced from %/%',
      NEW.allocation_id, NEW.ledger_txn_id, txn.source_kind, txn.source_ref
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO entry_count FROM ledger_entries
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND ledger_txn_id = NEW.ledger_txn_id;
  IF entry_count <> 2 THEN
    RAISE EXCEPTION 'allocation % posts % entries, not two', NEW.allocation_id, entry_count
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Exactly the movement the record describes: this asset, this amount, out of one party and
  -- into the other, as AVAILABLE claims. ASSET_CONTROL is untouched, which is what makes an
  -- internal allocation distinguishable from a venue movement.
  SELECT
    coalesce(sum(delta_atoms) FILTER (WHERE account_owner = NEW.from_owner), 0),
    coalesce(sum(delta_atoms) FILTER (WHERE account_owner = NEW.to_owner), 0)
    INTO debit_total, credit_total
    FROM ledger_entries
   WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
     AND ledger_txn_id = NEW.ledger_txn_id
     AND claim_state = 'AVAILABLE'
     AND asset_code = NEW.asset_code AND asset_scale = NEW.asset_scale;

  IF debit_total <> -NEW.atoms OR credit_total <> NEW.atoms THEN
    RAISE EXCEPTION 'allocation % describes % from % to % but its entries move %/%',
      NEW.allocation_id, NEW.atoms, NEW.from_owner, NEW.to_owner, debit_total, credit_total
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER owner_allocations_match_their_entries
  AFTER INSERT ON owner_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refuse_unsupported_allocation();

-- An allocation names the owner session that authorised it.
--
-- A foreign key, so the column cannot hold a string nobody issued. Whether that session was
-- live, in this workspace and held by an owner is decided by the service under the same lock
-- as the availability it spent; what the database guarantees is that the session is real and
-- stays referenced.
ALTER TABLE owner_allocations
  ADD CONSTRAINT owner_allocations_authorized_by_session
  FOREIGN KEY (authorized_by) REFERENCES owner_sessions (session_id_hash);
