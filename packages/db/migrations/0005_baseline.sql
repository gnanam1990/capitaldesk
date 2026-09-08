-- Module 06: the account baseline and owner allocation records.
--
-- A forward migration. Nothing here alters a table from 0003 or 0004; the ledger primitives
-- those created — postings, entries, the claim projection — are what this builds on.
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
ALTER TABLE claim_balances ADD COLUMN epoch INTEGER;
UPDATE claim_balances SET epoch = 1 WHERE epoch IS NULL;
ALTER TABLE claim_balances ALTER COLUMN epoch SET NOT NULL;
ALTER TABLE claim_balances DROP CONSTRAINT claim_balances_pkey;
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
