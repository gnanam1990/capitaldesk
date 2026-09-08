-- Module 10: bind immutable preview evidence to the transaction that seals and reserves.

CREATE TABLE plan_seals (
  workspace_id               TEXT        NOT NULL,
  pool_id                    TEXT        NOT NULL,
  epoch                      INTEGER     NOT NULL,
  plan_id                    TEXT        NOT NULL,
  preview_digest             TEXT        NOT NULL,
  source_ledger_revision     BIGINT      NOT NULL,
  policy_version             NUMERIC(78, 0) NOT NULL,
  cohort_closed_at_sequence  BIGINT      NOT NULL,
  venue_capacity_evidence_id TEXT        NOT NULL,
  venue_capacity_payload     JSONB       NOT NULL,
  sealed_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pool_id, plan_id),
  FOREIGN KEY (workspace_id, pool_id, epoch, plan_id)
    REFERENCES plans (workspace_id, pool_id, epoch, plan_id),
  FOREIGN KEY (workspace_id, pool_id, policy_version)
    REFERENCES policy_versions (workspace_id, pool_id, policy_version),
  CONSTRAINT plan_seals_digest_shape CHECK (preview_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT plan_seals_revision_nonnegative CHECK (source_ledger_revision >= 0),
  CONSTRAINT plan_seals_cohort_nonnegative CHECK (cohort_closed_at_sequence >= 0),
  CONSTRAINT plan_seals_evidence_shape
    CHECK (venue_capacity_evidence_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);

CREATE TRIGGER plan_seals_are_append_only
  BEFORE UPDATE OR DELETE ON plan_seals
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Once an intent enters a sealed plan it cannot be reused in a later plan. Its eventual
-- residual is represented by a new target revision after reconciliation, never by replaying
-- the old authorization.
CREATE UNIQUE INDEX intent_plan_bindings_one_sealed_plan
  ON intent_plan_bindings (workspace_id, pool_id, intent_id);
