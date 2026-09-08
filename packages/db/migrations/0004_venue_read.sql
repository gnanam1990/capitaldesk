-- Module 05: persisted read cursors, account snapshots and observation cuts.
--
-- A forward migration. Nothing here alters a table created by 0003, which is already merged;
-- the two new foreign keys point *into* the existing scope tuples rather than changing them.
--
-- The reader is stateless by design. What must survive a restart is the position it had
-- reached: ADR-0002 condition C3 establishes backfill completeness by contiguous cursor
-- pagination, and a cursor that is lost is a window that can no longer be proven. Losing it
-- does not corrupt anything, but it makes the affected window UNSUPPORTED, which stops
-- dispatch — so the cursor is durable state, not a cache.

-- Read state belongs to an open epoch.
--
-- A closed epoch is one a reset invalidated. Advancing its cursor or filing a snapshot under
-- it would attribute post-reset evidence to the account that existed before, which is the
-- crossing epochs exist to prevent.
CREATE OR REPLACE FUNCTION refuse_closed_epoch_read_state() RETURNS trigger AS $$
DECLARE
  closed TIMESTAMPTZ;
BEGIN
  SELECT closed_at INTO closed FROM baseline_epochs
    WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id AND epoch = NEW.epoch;
  IF closed IS NOT NULL THEN
    RAISE EXCEPTION 'epoch % of pool % was closed at %; read state cannot be written to it',
      NEW.epoch, NEW.pool_id, closed
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Per-symbol trade cursors.
--
-- Per symbol because `myTrades` requires a symbol and its ids are per-symbol: there is no
-- account-wide trade cursor to keep, and pretending otherwise is the mistake ADR-0002 exists
-- to prevent. Scoped by epoch so a reset cannot resume from a cursor belonging to the account
-- that existed before it.
CREATE TABLE venue_trade_cursors (
  workspace_id        TEXT        NOT NULL,
  pool_id             TEXT        NOT NULL,
  epoch               INTEGER     NOT NULL,
  symbol              TEXT        NOT NULL,
  -- The next `fromId` to request. A digit string, not a bigint column: venue ids can exceed
  -- what a caller's JSON number can hold, and every layer above keeps them as text so that a
  -- cursor is never rounded into a different one.
  next_from_id        TEXT        NOT NULL,
  -- The highest trade id actually observed, for evidence. Not the same as the cursor, which
  -- is one past it because `fromId` is inclusive.
  highest_trade_id    TEXT        NOT NULL,
  -- The digest of the response that advanced the cursor to here, so a later reader can say
  -- which exact evidence moved it.
  advanced_by_digest  TEXT        NOT NULL,
  advanced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  version             INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, pool_id, epoch, symbol),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  CONSTRAINT venue_trade_cursors_symbol_shape CHECK (symbol ~ '^[A-Z0-9]{2,20}$'),
  -- Canonical digits. '007' and '7' are one number and two strings, and a cursor compared as
  -- text must have exactly one spelling.
  CONSTRAINT venue_trade_cursors_from_shape CHECK (next_from_id ~ '^(0|[1-9][0-9]*)$'),
  CONSTRAINT venue_trade_cursors_highest_shape CHECK (highest_trade_id ~ '^(0|[1-9][0-9]*)$'),
  -- Bounded to the atom magnitude this system supports. An unbounded digit string flows
  -- through the ::NUMERIC comparison in the forward-only trigger, where an absurd value is a
  -- performance and correctness hazard rather than a cursor.
  CONSTRAINT venue_trade_cursors_from_bounded CHECK (length(next_from_id) <= 78),
  CONSTRAINT venue_trade_cursors_highest_bounded CHECK (length(highest_trade_id) <= 78),
  -- `fromId` is inclusive, so the next request must start exactly one past the highest id
  -- actually observed. Any other pair either re-reads a booked trade or skips one, and both
  -- read as a legitimate cursor afterwards.
  CONSTRAINT venue_trade_cursors_next_is_one_past_highest
    CHECK (next_from_id::NUMERIC = highest_trade_id::NUMERIC + 1),
  CONSTRAINT venue_trade_cursors_digest_shape
    CHECK (advanced_by_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT venue_trade_cursors_version_positive CHECK (version >= 1)
);

-- A cursor only ever moves forward.
--
-- A rollback would re-fetch history already booked, and — worse — a caller that believed the
-- lower value would report a window as backfilled when the evidence for its tail had been
-- discarded. Compared numerically, because '9' sorts after '10' as text.
CREATE OR REPLACE FUNCTION refuse_cursor_rollback() RETURNS trigger AS $$
BEGIN
  -- Strictly forward. An equal cursor that rewrote the digest, the highest id and the version
  -- recorded a new advance for a position that had not moved, so the evidence trail said a
  -- page was read when none was.
  IF NEW.next_from_id::NUMERIC <= OLD.next_from_id::NUMERIC THEN
    RAISE EXCEPTION 'trade cursor for % cannot move from % to %',
      OLD.symbol, OLD.next_from_id, NEW.next_from_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER venue_trade_cursors_move_forward_only
  BEFORE UPDATE ON venue_trade_cursors
  FOR EACH ROW EXECUTE FUNCTION refuse_cursor_rollback();

CREATE TRIGGER venue_trade_cursors_are_never_deleted
  BEFORE DELETE ON venue_trade_cursors
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER venue_trade_cursors_require_an_open_epoch
  BEFORE INSERT OR UPDATE ON venue_trade_cursors
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_epoch_read_state();

-- Account snapshots: the brackets of a cut.
--
-- ADR-0002 condition C4 requires bracketing snapshots that differ by exactly the booked
-- effects, and states plainly that this is necessary and never sufficient. The provenance
-- columns are what make a snapshot checkable at all: without the request interval and the
-- response digest, two equal balances are indistinguishable from one balance read twice.
CREATE TABLE venue_account_snapshots (
  workspace_id        TEXT        NOT NULL,
  pool_id             TEXT        NOT NULL,
  epoch               INTEGER     NOT NULL,
  snapshot_id         TEXT        NOT NULL,
  -- The venue's authenticated account id as proven by this very response, not a configured
  -- alias. A snapshot that cannot name its own account cannot be attributed to a pool.
  stable_account_id   TEXT        NOT NULL,
  requested_at        TIMESTAMPTZ NOT NULL,
  responded_at        TIMESTAMPTZ NOT NULL,
  -- The venue's own updateTime, which is not the same as when we asked.
  source_time         TIMESTAMPTZ,
  response_digest     TEXT        NOT NULL,
  -- Balances as observed: asset, free atoms, locked atoms. Stored whole so a later reader
  -- recomputes rather than trusting a projection.
  balances            JSONB       NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, snapshot_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  CONSTRAINT venue_account_snapshots_id_shape
    CHECK (snapshot_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT venue_account_snapshots_scope_tuple
    UNIQUE (workspace_id, pool_id, epoch, snapshot_id),
  CONSTRAINT venue_account_snapshots_digest_shape CHECK (response_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT venue_account_snapshots_balances_is_array CHECK (jsonb_typeof(balances) = 'array'),
  -- An interval that runs backwards is not a measurement, it is a fault.
  CONSTRAINT venue_account_snapshots_interval_ordered CHECK (responded_at >= requested_at)
);

-- A snapshot belongs to the account its pool governs.
--
-- Without this the column accepted any string, so a snapshot read from one account could be
-- filed against a pool governing another — which is the bracket a cut is later reconciled
-- against.
CREATE OR REPLACE FUNCTION refuse_foreign_account_snapshot() RETURNS trigger AS $$
DECLARE
  governed TEXT;
BEGIN
  SELECT stable_account_id INTO governed FROM pools
    WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id;
  IF governed IS NULL THEN
    RAISE EXCEPTION 'snapshot % names no known pool', NEW.snapshot_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF governed <> NEW.stable_account_id THEN
    RAISE EXCEPTION 'snapshot % is for account % but the pool governs %',
      NEW.snapshot_id, NEW.stable_account_id, governed
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER venue_account_snapshots_match_the_pool_account
  BEFORE INSERT ON venue_account_snapshots
  FOR EACH ROW EXECUTE FUNCTION refuse_foreign_account_snapshot();

CREATE TRIGGER venue_account_snapshots_require_an_open_epoch
  BEFORE INSERT ON venue_account_snapshots
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_epoch_read_state();

CREATE TRIGGER venue_account_snapshots_are_append_only
  BEFORE UPDATE OR DELETE ON venue_account_snapshots
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- An observation cut: one assessed window and its coverage verdict.
--
-- The verdict is stored with the reasons, not just the state, because the console, the
-- evidence exports and an owner adjudicating an UNSUPPORTED window all need to say which
-- condition was unmet. A state with no reasons is an assertion.
CREATE TABLE venue_observation_cuts (
  workspace_id        TEXT        NOT NULL,
  pool_id             TEXT        NOT NULL,
  epoch               INTEGER     NOT NULL,
  cut_id              TEXT        NOT NULL,
  window_from         TIMESTAMPTZ NOT NULL,
  window_to           TIMESTAMPTZ NOT NULL,
  -- The bracketing snapshots, in this pool and epoch.
  opening_snapshot_id TEXT        NOT NULL,
  closing_snapshot_id TEXT        NOT NULL,
  coverage_state      TEXT        NOT NULL,
  detection_scope     TEXT        NOT NULL,
  -- Every unmet condition, in the predicate's stable order.
  unmet               JSONB       NOT NULL,
  -- The symbols this cut claims to have enumerated. ADR-0002 condition U: one *tradable*
  -- symbol must not silently become one *observed* symbol, so the set is recorded rather
  -- than assumed from configuration at read time.
  observed_symbols    JSONB       NOT NULL,
  assessed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, cut_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  FOREIGN KEY (workspace_id, pool_id, epoch, opening_snapshot_id)
    REFERENCES venue_account_snapshots (workspace_id, pool_id, epoch, snapshot_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, closing_snapshot_id)
    REFERENCES venue_account_snapshots (workspace_id, pool_id, epoch, snapshot_id),
  CONSTRAINT venue_observation_cuts_id_shape
    CHECK (cut_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT venue_observation_cuts_window_ordered CHECK (window_to >= window_from),
  CONSTRAINT venue_observation_cuts_state_known CHECK (coverage_state IN
    ('COMPLETE', 'INCOMPLETE', 'GAP_OPEN', 'UNSUPPORTED')),
  CONSTRAINT venue_observation_cuts_scope_known CHECK (detection_scope IN
    ('FULL_WITHIN_PROVEN_UNIVERSE', 'NET_BALANCE_CHANGES_ONLY')),
  CONSTRAINT venue_observation_cuts_unmet_is_array CHECK (jsonb_typeof(unmet) = 'array'),
  CONSTRAINT venue_observation_cuts_symbols_is_array
    CHECK (jsonb_typeof(observed_symbols) = 'array'),
  -- A COMPLETE cut with unmet conditions is a contradiction, and it is the contradiction that
  -- would let a pool dispatch against a window nothing had proven.
  CONSTRAINT venue_observation_cuts_complete_has_no_unmet
    CHECK (coverage_state <> 'COMPLETE' OR jsonb_array_length(unmet) = 0),
  -- Only a fully proven universe may be recorded as COMPLETE.
  CONSTRAINT venue_observation_cuts_complete_is_fully_scoped
    CHECK (coverage_state <> 'COMPLETE' OR detection_scope = 'FULL_WITHIN_PROVEN_UNIVERSE')
);

CREATE TRIGGER venue_observation_cuts_are_append_only
  BEFORE UPDATE OR DELETE ON venue_observation_cuts
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER venue_observation_cuts_require_an_open_epoch
  BEFORE INSERT ON venue_observation_cuts
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_epoch_read_state();

-- A cut's window is the interval its own brackets actually describe.
--
-- The foreign keys prove the two snapshots exist in this scope; they say nothing about whether
-- the declared window matches them. Without this a caller could file a one-second window over
-- an hour-long pair of readings, name the same snapshot as both brackets, or put them in the
-- wrong order — and the cut would read afterwards as a properly bracketed assessment.
CREATE OR REPLACE FUNCTION refuse_incoherent_cut_window() RETURNS trigger AS $$
DECLARE
  opening venue_account_snapshots%ROWTYPE;
  closing venue_account_snapshots%ROWTYPE;
BEGIN
  IF NEW.opening_snapshot_id = NEW.closing_snapshot_id THEN
    RAISE EXCEPTION 'cut % uses one snapshot as both brackets', NEW.cut_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT * INTO opening FROM venue_account_snapshots
    WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
      AND epoch = NEW.epoch AND snapshot_id = NEW.opening_snapshot_id;
  SELECT * INTO closing FROM venue_account_snapshots
    WHERE workspace_id = NEW.workspace_id AND pool_id = NEW.pool_id
      AND epoch = NEW.epoch AND snapshot_id = NEW.closing_snapshot_id;

  IF opening.snapshot_id IS NULL OR closing.snapshot_id IS NULL THEN
    RAISE EXCEPTION 'cut % names a snapshot that does not exist in its scope', NEW.cut_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The brackets must be in the order the cut claims.
  IF closing.requested_at < opening.requested_at THEN
    RAISE EXCEPTION 'cut % closes with a snapshot taken before it opens', NEW.cut_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- And the window must be exactly what they span: from when the first was requested to when
  -- the last was answered.
  IF NEW.window_from <> opening.requested_at THEN
    RAISE EXCEPTION 'cut % declares window_from % but its opening bracket was requested at %',
      NEW.cut_id, NEW.window_from, opening.requested_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.window_to <> closing.responded_at THEN
    RAISE EXCEPTION 'cut % declares window_to % but its closing bracket answered at %',
      NEW.cut_id, NEW.window_to, closing.responded_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Both brackets must be readings of the same account, or they bracket nothing.
  IF opening.stable_account_id <> closing.stable_account_id THEN
    RAISE EXCEPTION 'cut % brackets two different accounts', NEW.cut_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER venue_observation_cuts_window_matches_its_brackets
  BEFORE INSERT ON venue_observation_cuts
  FOR EACH ROW EXECUTE FUNCTION refuse_incoherent_cut_window();
