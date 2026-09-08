-- Module 07: strategy lifecycle and versioned absolute targets.
--
-- This is forward-only. Existing pools remain unconfigured and therefore cannot accept an
-- intent until an owner binds the selected market and active policy revision explicitly.

ALTER TABLE pools
  ADD COLUMN selected_symbol TEXT,
  ADD COLUMN base_asset_code TEXT,
  ADD COLUMN base_asset_scale TEXT,
  ADD COLUMN quote_asset_code TEXT,
  ADD COLUMN quote_asset_scale TEXT,
  ADD COLUMN max_target_base_atoms NUMERIC(78, 0),
  ADD COLUMN active_policy_version NUMERIC(78, 0),
  ADD CONSTRAINT pools_market_configuration_complete CHECK (
    (selected_symbol IS NULL
      AND base_asset_code IS NULL AND base_asset_scale IS NULL
      AND quote_asset_code IS NULL AND quote_asset_scale IS NULL
      AND max_target_base_atoms IS NULL AND active_policy_version IS NULL)
    OR
    (selected_symbol IS NOT NULL
      AND base_asset_code IS NOT NULL AND base_asset_scale IS NOT NULL
      AND quote_asset_code IS NOT NULL AND quote_asset_scale IS NOT NULL
      AND max_target_base_atoms IS NOT NULL AND active_policy_version IS NOT NULL)
  ),
  ADD CONSTRAINT pools_selected_symbol_shape
    CHECK (selected_symbol IS NULL OR selected_symbol ~ '^[A-Z0-9]{2,32}$'),
  ADD CONSTRAINT pools_market_assets_distinct
    CHECK (base_asset_code IS NULL OR base_asset_code <> quote_asset_code
           OR base_asset_scale <> quote_asset_scale),
  ADD CONSTRAINT pools_market_atoms_integral
    CHECK (max_target_base_atoms IS NULL OR max_target_base_atoms = trunc(max_target_base_atoms)),
  ADD CONSTRAINT pools_market_atoms_positive
    CHECK (max_target_base_atoms IS NULL OR max_target_base_atoms > 0),
  ADD CONSTRAINT pools_policy_version_integral
    CHECK (active_policy_version IS NULL OR active_policy_version = trunc(active_policy_version)),
  ADD CONSTRAINT pools_policy_version_positive
    CHECK (active_policy_version IS NULL OR active_policy_version > 0);

CREATE SEQUENCE strategy_intent_accepted_sequence AS BIGINT START WITH 1;

CREATE TABLE strategy_intents (
  workspace_id          TEXT           NOT NULL,
  pool_id               TEXT           NOT NULL,
  epoch                 INTEGER        NOT NULL,
  intent_id             TEXT           NOT NULL,
  strategy_id           TEXT           NOT NULL,
  symbol                TEXT           NOT NULL,
  base_asset_code       TEXT           NOT NULL,
  base_asset_scale      TEXT           NOT NULL,
  quote_asset_code      TEXT           NOT NULL,
  quote_asset_scale     TEXT           NOT NULL,
  target_base_atoms     NUMERIC(78, 0) NOT NULL,
  max_buy_price         TEXT,
  min_sell_price        TEXT,
  max_quote_debit_atoms NUMERIC(78, 0) NOT NULL,
  expires_at            TIMESTAMPTZ    NOT NULL,
  strategy_revision     NUMERIC(78, 0) NOT NULL,
  policy_version        NUMERIC(78, 0) NOT NULL,
  idempotency_key       TEXT           NOT NULL,
  request_digest        TEXT           NOT NULL,
  accepted_sequence     BIGINT         NOT NULL DEFAULT nextval('strategy_intent_accepted_sequence'),
  state                 TEXT           NOT NULL,
  is_current            BOOLEAN        NOT NULL DEFAULT false,
  is_next_cohort        BOOLEAN        NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, intent_id),
  FOREIGN KEY (workspace_id, pool_id, epoch)
    REFERENCES baseline_epochs (workspace_id, pool_id, epoch),
  FOREIGN KEY (workspace_id, pool_id, strategy_id)
    REFERENCES strategies (workspace_id, pool_id, strategy_id),
  CONSTRAINT strategy_intents_scope_tuple
    UNIQUE (workspace_id, pool_id, epoch, intent_id),
  CONSTRAINT strategy_intents_revision_unique
    UNIQUE (workspace_id, pool_id, strategy_id, symbol, strategy_revision),
  CONSTRAINT strategy_intents_id_shape
    CHECK (intent_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT strategy_intents_symbol_shape CHECK (symbol ~ '^[A-Z0-9]{2,32}$'),
  CONSTRAINT strategy_intents_target_integral CHECK (target_base_atoms = trunc(target_base_atoms)),
  CONSTRAINT strategy_intents_target_nonnegative CHECK (target_base_atoms >= 0),
  CONSTRAINT strategy_intents_debit_integral
    CHECK (max_quote_debit_atoms = trunc(max_quote_debit_atoms)),
  CONSTRAINT strategy_intents_debit_nonnegative CHECK (max_quote_debit_atoms >= 0),
  CONSTRAINT strategy_intents_revision_positive
    CHECK (strategy_revision = trunc(strategy_revision) AND strategy_revision > 0),
  CONSTRAINT strategy_intents_policy_positive
    CHECK (policy_version = trunc(policy_version) AND policy_version > 0),
  CONSTRAINT strategy_intents_limit_present CHECK (max_buy_price IS NOT NULL OR min_sell_price IS NOT NULL),
  CONSTRAINT strategy_intents_digest_shape CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT strategy_intents_state_known CHECK (state IN
    ('VALIDATED', 'QUEUED_NEXT_COHORT', 'PLANNED', 'SATISFIED', 'PARTIAL', 'UNFILLED',
     'SUPERSEDED', 'EXPIRED', 'DEFERRED', 'CONFLICT', 'REJECTED')),
  CONSTRAINT strategy_intents_current_shape CHECK (
    NOT is_current OR (state IN ('VALIDATED', 'DEFERRED') AND NOT is_next_cohort)),
  CONSTRAINT strategy_intents_next_shape CHECK (
    NOT is_next_cohort OR (state IN ('QUEUED_NEXT_COHORT', 'DEFERRED') AND NOT is_current))
);

-- Exactly one actionable target and one queued replacement for a strategy/symbol.
CREATE UNIQUE INDEX strategy_intents_one_current
  ON strategy_intents (workspace_id, pool_id, strategy_id, symbol)
  WHERE is_current;
CREATE UNIQUE INDEX strategy_intents_one_next_cohort
  ON strategy_intents (workspace_id, pool_id, strategy_id, symbol)
  WHERE is_next_cohort;
CREATE INDEX strategy_intents_fifo
  ON strategy_intents (workspace_id, pool_id, accepted_sequence, strategy_id, intent_id);

CREATE OR REPLACE FUNCTION refuse_strategy_intent_content_change() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.pool_id IS DISTINCT FROM OLD.pool_id
     OR NEW.epoch IS DISTINCT FROM OLD.epoch
     OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.base_asset_code IS DISTINCT FROM OLD.base_asset_code
     OR NEW.base_asset_scale IS DISTINCT FROM OLD.base_asset_scale
     OR NEW.quote_asset_code IS DISTINCT FROM OLD.quote_asset_code
     OR NEW.quote_asset_scale IS DISTINCT FROM OLD.quote_asset_scale
     OR NEW.target_base_atoms IS DISTINCT FROM OLD.target_base_atoms
     OR NEW.max_buy_price IS DISTINCT FROM OLD.max_buy_price
     OR NEW.min_sell_price IS DISTINCT FROM OLD.min_sell_price
     OR NEW.max_quote_debit_atoms IS DISTINCT FROM OLD.max_quote_debit_atoms
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.strategy_revision IS DISTINCT FROM OLD.strategy_revision
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.accepted_sequence IS DISTINCT FROM OLD.accepted_sequence
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'intent % economic content is immutable', OLD.intent_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state IN ('SATISFIED','PARTIAL','UNFILLED','SUPERSEDED','EXPIRED','CONFLICT','REJECTED')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'terminal intent % cannot leave state %', OLD.intent_id, OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_intent_content_is_immutable
  BEFORE UPDATE ON strategy_intents
  FOR EACH ROW EXECUTE FUNCTION refuse_strategy_intent_content_change();
CREATE TRIGGER strategy_intents_are_never_deleted
  BEFORE DELETE ON strategy_intents
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Planner-owned binding. The immutable row is sufficient for module 07 to refuse unsafe
-- replacement; module 09 writes these rows atomically while sealing a plan.
CREATE TABLE intent_plan_bindings (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  epoch              INTEGER     NOT NULL,
  intent_id          TEXT        NOT NULL,
  plan_id            TEXT        NOT NULL,
  base_direction     TEXT        NOT NULL,
  base_atoms         NUMERIC(78, 0) NOT NULL,
  bound_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, intent_id, plan_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, intent_id)
    REFERENCES strategy_intents (workspace_id, pool_id, epoch, intent_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, plan_id)
    REFERENCES plans (workspace_id, pool_id, epoch, plan_id),
  CONSTRAINT intent_plan_bindings_direction_known CHECK (base_direction IN ('BUY','SELL')),
  CONSTRAINT intent_plan_bindings_atoms_integral CHECK (base_atoms = trunc(base_atoms)),
  CONSTRAINT intent_plan_bindings_atoms_positive CHECK (base_atoms > 0)
);
CREATE TRIGGER intent_plan_bindings_are_append_only
  BEFORE UPDATE OR DELETE ON intent_plan_bindings
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Current owner control plus append-only history. The control binds a target key, not an
-- intent revision, so a new proposal cannot evade it.
CREATE TABLE strategy_target_controls (
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  strategy_id        TEXT        NOT NULL,
  symbol             TEXT        NOT NULL,
  deferred_at        TIMESTAMPTZ,
  until_at            TIMESTAMPTZ,
  reinstated_at      TIMESTAMPTZ,
  version            INTEGER     NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, strategy_id, symbol),
  FOREIGN KEY (workspace_id, pool_id, strategy_id)
    REFERENCES strategies (workspace_id, pool_id, strategy_id),
  CONSTRAINT strategy_target_controls_version_positive CHECK (version >= 1),
  CONSTRAINT strategy_target_controls_time_shape CHECK (
    (deferred_at IS NULL AND until_at IS NULL AND reinstated_at IS NULL)
    OR deferred_at IS NOT NULL)
);

CREATE TABLE strategy_target_control_events (
  event_sequence     BIGSERIAL   NOT NULL PRIMARY KEY,
  workspace_id       TEXT        NOT NULL,
  pool_id            TEXT        NOT NULL,
  strategy_id        TEXT        NOT NULL,
  symbol             TEXT        NOT NULL,
  action             TEXT        NOT NULL,
  actor_subject_id   TEXT        NOT NULL,
  expected_version   INTEGER     NOT NULL,
  resulting_version  INTEGER     NOT NULL,
  until_at            TIMESTAMPTZ,
  idempotency_key    TEXT        NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, pool_id, strategy_id, symbol)
    REFERENCES strategy_target_controls (workspace_id, pool_id, strategy_id, symbol),
  CONSTRAINT strategy_target_control_action_known CHECK (action IN ('INTENT_DEFER','INTENT_REINSTATE')),
  CONSTRAINT strategy_target_control_event_unique
    UNIQUE (workspace_id, pool_id, strategy_id, symbol, idempotency_key)
);
CREATE TRIGGER strategy_target_control_events_are_append_only
  BEFORE UPDATE OR DELETE ON strategy_target_control_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- A control row is mutable because it is the current projection, but every committed version
-- must have the append-only event that authorised it. Deferred checking lets the repository
-- write the projection first and its event second in one transaction.
CREATE OR REPLACE FUNCTION assert_target_control_has_event() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM strategy_target_control_events e
     WHERE e.workspace_id = NEW.workspace_id AND e.pool_id = NEW.pool_id
       AND e.strategy_id = NEW.strategy_id AND e.symbol = NEW.symbol
       AND e.resulting_version = NEW.version
  ) THEN
    RAISE EXCEPTION 'target control %/%/%/% version % has no lifecycle event',
      NEW.workspace_id, NEW.pool_id, NEW.strategy_id, NEW.symbol, NEW.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER strategy_target_control_requires_event
  AFTER INSERT OR UPDATE ON strategy_target_controls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_target_control_has_event();
