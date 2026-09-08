-- Module 11: immutable owner decisions and independent native-host confirmation.

CREATE TABLE plan_approval_decisions (
  workspace_id                 TEXT          NOT NULL,
  pool_id                      TEXT          NOT NULL,
  epoch                        INTEGER       NOT NULL,
  approval_id                  TEXT          NOT NULL,
  plan_id                      TEXT          NOT NULL,
  decision                     TEXT          NOT NULL,
  plan_digest                  TEXT          NOT NULL,
  actor_subject_id             TEXT          NOT NULL,
  actor_role                   TEXT          NOT NULL,
  execution_mode               TEXT          NOT NULL,
  policy_version               NUMERIC(78,0) NOT NULL,
  source_ledger_revision       BIGINT        NOT NULL,
  approval_ledger_revision     BIGINT        NOT NULL,
  allocation_algorithm_version TEXT          NOT NULL,
  fee_policy_version           TEXT          NOT NULL,
  intent_revisions             JSONB         NOT NULL,
  allocation                   JSONB         NOT NULL,
  strategy_caps                JSONB         NOT NULL,
  approval_expires_at          TIMESTAMPTZ   NOT NULL,
  submission_deadline_at       TIMESTAMPTZ   NOT NULL,
  decided_at                   TIMESTAMPTZ   NOT NULL DEFAULT clock_timestamp(),
  idempotency_key              TEXT          NOT NULL,
  PRIMARY KEY (workspace_id, pool_id, approval_id),
  UNIQUE (workspace_id, pool_id, plan_id),
  UNIQUE (workspace_id, pool_id, idempotency_key),
  UNIQUE (workspace_id, pool_id, approval_id, plan_id, plan_digest),
  FOREIGN KEY (workspace_id, pool_id, epoch, plan_id)
    REFERENCES plans (workspace_id, pool_id, epoch, plan_id),
  FOREIGN KEY (workspace_id, pool_id, policy_version)
    REFERENCES policy_versions (workspace_id, pool_id, policy_version),
  CONSTRAINT plan_approval_id_shape
    CHECK (approval_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT plan_approval_key_shape
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT plan_approval_digest_shape CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT plan_approval_decision_known CHECK (decision IN ('APPROVED','DECLINED')),
  CONSTRAINT plan_approval_actor_is_owner
    CHECK (actor_role = 'owner' AND actor_subject_id <> ''),
  CONSTRAINT plan_approval_execution_mode_known
    CHECK (execution_mode IN ('BROKER_KEY','APPROVED_HOST')),
  CONSTRAINT plan_approval_versions_nonnegative
    CHECK (source_ledger_revision >= 0 AND approval_ledger_revision >= source_ledger_revision),
  CONSTRAINT plan_approval_deadline_within_expiry
    CHECK (submission_deadline_at <= approval_expires_at),
  CONSTRAINT plan_approval_evidence_arrays
    CHECK (jsonb_typeof(intent_revisions) = 'array'
       AND jsonb_typeof(allocation) = 'array'
       AND jsonb_typeof(strategy_caps) = 'array')
);

CREATE TRIGGER plan_approval_decisions_are_append_only
  BEFORE UPDATE OR DELETE ON plan_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE plan_approval_revocations (
  workspace_id      TEXT        NOT NULL,
  pool_id           TEXT        NOT NULL,
  revocation_id     TEXT        NOT NULL,
  approval_id       TEXT        NOT NULL,
  plan_id           TEXT        NOT NULL,
  plan_digest       TEXT        NOT NULL,
  actor_subject_id  TEXT        NOT NULL,
  actor_role        TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  effect            TEXT        NOT NULL,
  revoked_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  idempotency_key   TEXT        NOT NULL,
  PRIMARY KEY (workspace_id, pool_id, revocation_id),
  UNIQUE (workspace_id, pool_id, approval_id),
  UNIQUE (workspace_id, pool_id, idempotency_key),
  FOREIGN KEY (workspace_id, pool_id, approval_id, plan_id, plan_digest)
    REFERENCES plan_approval_decisions
      (workspace_id, pool_id, approval_id, plan_id, plan_digest),
  CONSTRAINT plan_approval_revocation_id_shape
    CHECK (revocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT plan_approval_revocation_key_shape
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT plan_approval_revocation_digest_shape CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT plan_approval_revocation_actor_is_owner
    CHECK (actor_role = 'owner' AND actor_subject_id <> ''),
  CONSTRAINT plan_approval_revocation_reason_nonempty CHECK (reason <> ''),
  CONSTRAINT plan_approval_revocation_effect_known
    CHECK (effect IN ('INVALIDATED_UNMARKED','HALT_REQUESTED_IN_FLIGHT'))
);

CREATE TRIGGER plan_approval_revocations_are_append_only
  BEFORE UPDATE OR DELETE ON plan_approval_revocations
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE plan_native_confirmations (
  workspace_id             TEXT        NOT NULL,
  pool_id                  TEXT        NOT NULL,
  confirmation_id          TEXT        NOT NULL,
  approval_id              TEXT        NOT NULL,
  plan_id                  TEXT        NOT NULL,
  plan_digest              TEXT        NOT NULL,
  provider                 TEXT        NOT NULL,
  confirmation_ref         TEXT        NOT NULL,
  confirmed_payload_digest TEXT        NOT NULL,
  confirmed_at             TIMESTAMPTZ NOT NULL,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, pool_id, confirmation_id),
  UNIQUE (workspace_id, pool_id, approval_id),
  UNIQUE (provider, confirmation_ref),
  FOREIGN KEY (workspace_id, pool_id, approval_id, plan_id, plan_digest)
    REFERENCES plan_approval_decisions
      (workspace_id, pool_id, approval_id, plan_id, plan_digest),
  CONSTRAINT plan_native_confirmation_id_shape
    CHECK (confirmation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT plan_native_confirmation_provider_known CHECK (provider = 'BINANCE_AGENTIC_MCP'),
  CONSTRAINT plan_native_confirmation_digest_shape
    CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'
       AND confirmed_payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT plan_native_confirmation_ref_nonempty CHECK (confirmation_ref <> '')
);

CREATE TRIGGER plan_native_confirmations_are_append_only
  BEFORE UPDATE OR DELETE ON plan_native_confirmations
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Every last-moment decision is distinct from consent. A refusal remains inspectable after
-- the stale plan has been invalidated or its deadline has passed.
CREATE TABLE plan_dispatch_eligibility_checks (
  check_id         BIGSERIAL   NOT NULL PRIMARY KEY,
  workspace_id     TEXT        NOT NULL,
  pool_id          TEXT        NOT NULL,
  approval_id      TEXT        NOT NULL,
  plan_id          TEXT        NOT NULL,
  plan_digest      TEXT        NOT NULL,
  execution_mode   TEXT        NOT NULL,
  eligible         BOOLEAN     NOT NULL,
  reason           TEXT,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, pool_id, approval_id, plan_id, plan_digest)
    REFERENCES plan_approval_decisions
      (workspace_id, pool_id, approval_id, plan_id, plan_digest),
  CONSTRAINT plan_dispatch_check_digest_shape CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT plan_dispatch_check_mode_known
    CHECK (execution_mode IN ('BROKER_KEY','APPROVED_HOST')),
  CONSTRAINT plan_dispatch_check_reason_shape
    CHECK ((eligible AND reason IS NULL) OR (NOT eligible AND reason IS NOT NULL))
);

CREATE TRIGGER plan_dispatch_eligibility_checks_are_append_only
  BEFORE UPDATE OR DELETE ON plan_dispatch_eligibility_checks
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
