-- Module 08: immutable owner mandates and durable gross-BUY budget accounting.

CREATE TABLE policy_versions (
  workspace_id                      TEXT           NOT NULL,
  pool_id                           TEXT           NOT NULL,
  policy_version                    NUMERIC(78, 0) NOT NULL,
  payload                           JSONB          NOT NULL,
  payload_digest                    TEXT           NOT NULL,
  selected_symbol                   TEXT           NOT NULL,
  base_asset_code                   TEXT           NOT NULL,
  base_asset_scale                  TEXT           NOT NULL,
  quote_asset_code                  TEXT           NOT NULL,
  quote_asset_scale                 TEXT           NOT NULL,
  max_pool_plan_quote_debit_atoms   NUMERIC(78, 0) NOT NULL,
  max_daily_gross_buy_quote_atoms   NUMERIC(78, 0) NOT NULL,
  concentration_numerator           NUMERIC(78, 0) NOT NULL,
  concentration_denominator         NUMERIC(78, 0) NOT NULL,
  price_snapshot_max_age_ms         BIGINT         NOT NULL,
  account_snapshot_max_age_ms       BIGINT         NOT NULL,
  symbol_metadata_max_age_ms        BIGINT         NOT NULL,
  venue_clock_max_age_ms            BIGINT         NOT NULL,
  plan_lifetime_ms                  BIGINT         NOT NULL,
  buy_inhibit_until                 TIMESTAMPTZ,
  risk_increase_halted              BOOLEAN        NOT NULL,
  fee_policy_version                TEXT           NOT NULL,
  published_by_subject_id           TEXT           NOT NULL,
  idempotency_key                   TEXT           NOT NULL,
  published_at                      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, policy_version),
  FOREIGN KEY (workspace_id, pool_id) REFERENCES pools (workspace_id, pool_id),
  CONSTRAINT policy_versions_version_positive
    CHECK (policy_version = trunc(policy_version) AND policy_version > 0),
  CONSTRAINT policy_versions_symbol_shape CHECK (selected_symbol ~ '^[A-Z0-9]{2,32}$'),
  CONSTRAINT policy_versions_assets_distinct
    CHECK (base_asset_code <> quote_asset_code OR base_asset_scale <> quote_asset_scale),
  CONSTRAINT policy_versions_pool_debit_integral
    CHECK (max_pool_plan_quote_debit_atoms = trunc(max_pool_plan_quote_debit_atoms)
           AND max_pool_plan_quote_debit_atoms >= 0),
  CONSTRAINT policy_versions_daily_integral
    CHECK (max_daily_gross_buy_quote_atoms = trunc(max_daily_gross_buy_quote_atoms)
           AND max_daily_gross_buy_quote_atoms >= 0),
  CONSTRAINT policy_versions_ratio_valid
    CHECK (concentration_numerator = trunc(concentration_numerator)
           AND concentration_denominator = trunc(concentration_denominator)
           AND concentration_numerator >= 0
           AND concentration_denominator > 0
           AND concentration_numerator <= concentration_denominator),
  CONSTRAINT policy_versions_freshness_positive
    CHECK (price_snapshot_max_age_ms > 0 AND account_snapshot_max_age_ms > 0
           AND symbol_metadata_max_age_ms > 0 AND venue_clock_max_age_ms > 0),
  CONSTRAINT policy_versions_lifetime_positive CHECK (plan_lifetime_ms > 0),
  CONSTRAINT policy_versions_digest_shape CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT policy_versions_idempotency_unique
    UNIQUE (workspace_id, pool_id, idempotency_key)
);

CREATE TRIGGER policy_versions_are_immutable
  BEFORE UPDATE OR DELETE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE strategy_policy_limits (
  workspace_id                       TEXT           NOT NULL,
  pool_id                            TEXT           NOT NULL,
  policy_version                     NUMERIC(78, 0) NOT NULL,
  strategy_id                        TEXT           NOT NULL,
  max_target_base_atoms              NUMERIC(78, 0) NOT NULL,
  max_plan_quote_debit_atoms         NUMERIC(78, 0) NOT NULL,
  max_daily_gross_buy_quote_atoms    NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (workspace_id, pool_id, policy_version, strategy_id),
  FOREIGN KEY (workspace_id, pool_id, policy_version)
    REFERENCES policy_versions (workspace_id, pool_id, policy_version),
  FOREIGN KEY (workspace_id, pool_id, strategy_id)
    REFERENCES strategies (workspace_id, pool_id, strategy_id),
  CONSTRAINT strategy_policy_target_integral
    CHECK (max_target_base_atoms = trunc(max_target_base_atoms) AND max_target_base_atoms >= 0),
  CONSTRAINT strategy_policy_debit_integral
    CHECK (max_plan_quote_debit_atoms = trunc(max_plan_quote_debit_atoms)
           AND max_plan_quote_debit_atoms >= 0),
  CONSTRAINT strategy_policy_daily_integral
    CHECK (max_daily_gross_buy_quote_atoms = trunc(max_daily_gross_buy_quote_atoms)
           AND max_daily_gross_buy_quote_atoms >= 0)
);

CREATE TRIGGER strategy_policy_limits_are_immutable
  BEFORE UPDATE OR DELETE ON strategy_policy_limits
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- The current policy pointer is now backed by an immutable row. It is DEFERRABLE so a policy
-- and its activation can be committed together without exposing an intermediate version.
ALTER TABLE pools
  ADD CONSTRAINT pools_active_policy_exists
  FOREIGN KEY (workspace_id, pool_id, active_policy_version)
  REFERENCES policy_versions (workspace_id, pool_id, policy_version)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE policy_budget_holds (
  workspace_id             TEXT           NOT NULL,
  pool_id                  TEXT           NOT NULL,
  policy_version           NUMERIC(78, 0) NOT NULL,
  strategy_id              TEXT           NOT NULL,
  budget_ref               TEXT           NOT NULL,
  utc_bucket               DATE           NOT NULL,
  max_quote_debit_atoms    NUMERIC(78, 0) NOT NULL,
  consumed_quote_atoms     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  state                    TEXT           NOT NULL DEFAULT 'HELD',
  created_at               TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, budget_ref),
  FOREIGN KEY (workspace_id, pool_id, policy_version, strategy_id)
    REFERENCES strategy_policy_limits (workspace_id, pool_id, policy_version, strategy_id),
  CONSTRAINT policy_budget_ref_shape CHECK (budget_ref ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT policy_budget_max_integral
    CHECK (max_quote_debit_atoms = trunc(max_quote_debit_atoms) AND max_quote_debit_atoms > 0),
  CONSTRAINT policy_budget_consumed_integral
    CHECK (consumed_quote_atoms = trunc(consumed_quote_atoms)
           AND consumed_quote_atoms >= 0
           AND consumed_quote_atoms <= max_quote_debit_atoms),
  CONSTRAINT policy_budget_state_known CHECK (state IN ('HELD','CONSUMED','RELEASED')),
  CONSTRAINT policy_budget_state_amount CHECK (
    (state = 'HELD' AND consumed_quote_atoms = 0)
    OR (state = 'CONSUMED' AND consumed_quote_atoms > 0)
    OR (state = 'RELEASED' AND consumed_quote_atoms = 0))
);

CREATE INDEX policy_budget_usage
  ON policy_budget_holds (workspace_id, pool_id, strategy_id, utc_bucket, state);

CREATE OR REPLACE FUNCTION enforce_policy_budget_hold_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.pool_id IS DISTINCT FROM OLD.pool_id
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.budget_ref IS DISTINCT FROM OLD.budget_ref
     OR NEW.utc_bucket IS DISTINCT FROM OLD.utc_bucket
     OR NEW.max_quote_debit_atoms IS DISTINCT FROM OLD.max_quote_debit_atoms
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'budget hold % economic identity is immutable', OLD.budget_ref
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'HELD' OR NEW.state NOT IN ('CONSUMED','RELEASED') THEN
    RAISE EXCEPTION 'budget hold % cannot transition from % to %', OLD.budget_ref, OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER policy_budget_hold_transitions
  BEFORE UPDATE ON policy_budget_holds
  FOR EACH ROW EXECUTE FUNCTION enforce_policy_budget_hold_transition();
CREATE TRIGGER policy_budget_holds_are_never_deleted
  BEFORE DELETE ON policy_budget_holds
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
