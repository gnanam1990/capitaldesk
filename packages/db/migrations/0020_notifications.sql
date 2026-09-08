-- Modules 17-18: durable owner-facing events and retryable notification delivery.

CREATE TABLE domain_events (
  event_id      BIGSERIAL   NOT NULL PRIMARY KEY,
  workspace_id TEXT        NOT NULL,
  pool_id      TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  subject_ref  TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, event_id),
  FOREIGN KEY (workspace_id, pool_id) REFERENCES pools (workspace_id, pool_id),
  CONSTRAINT domain_events_type_shape CHECK (event_type ~ '^[a-z][a-z0-9.]{1,63}$'),
  CONSTRAINT domain_events_subject_nonempty CHECK (subject_ref <> ''),
  CONSTRAINT domain_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX domain_events_stream
  ON domain_events (workspace_id, pool_id, event_id);

CREATE TRIGGER domain_events_are_append_only
  BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE webhook_endpoints (
  workspace_id       TEXT        NOT NULL,
  endpoint_id        TEXT        NOT NULL,
  destination_url    TEXT        NOT NULL,
  signing_secret_ref TEXT        NOT NULL,
  enabled            BOOLEAN     NOT NULL DEFAULT true,
  version            INTEGER     NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at        TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, endpoint_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id),
  CONSTRAINT webhook_endpoint_id_shape
    CHECK (endpoint_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT webhook_destination_https CHECK (destination_url ~ '^https://'),
  CONSTRAINT webhook_secret_is_reference
    CHECK (signing_secret_ref ~ '^(file|secret|vault)://[^[:space:]]+$'),
  CONSTRAINT webhook_disabled_together CHECK (enabled = (disabled_at IS NULL))
);

CREATE TABLE webhook_deliveries (
  workspace_id   TEXT        NOT NULL,
  endpoint_id    TEXT        NOT NULL,
  delivery_id    TEXT        NOT NULL,
  event_id       BIGINT      NOT NULL,
  state          TEXT        NOT NULL DEFAULT 'PENDING',
  attempts       INTEGER     NOT NULL DEFAULT 0,
  max_attempts   INTEGER     NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  leased_by      TEXT,
  leased_until   TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, delivery_id),
  UNIQUE (workspace_id, endpoint_id, event_id),
  FOREIGN KEY (workspace_id, endpoint_id)
    REFERENCES webhook_endpoints (workspace_id, endpoint_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES domain_events (workspace_id, event_id),
  CONSTRAINT webhook_delivery_id_shape
    CHECK (delivery_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT webhook_delivery_state_known
    CHECK (state IN ('PENDING','LEASED','DELIVERED','DEAD_LETTER')),
  CONSTRAINT webhook_delivery_attempts_bounded
    CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 32 AND attempts <= max_attempts),
  CONSTRAINT webhook_delivery_lease_together
    CHECK ((leased_by IS NULL) = (leased_until IS NULL)),
  CONSTRAINT webhook_delivery_terminal_together
    CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL)
       AND (state = 'DEAD_LETTER') = (dead_lettered_at IS NOT NULL))
);

CREATE INDEX webhook_deliveries_ready
  ON webhook_deliveries (next_attempt_at, created_at)
  WHERE state = 'PENDING';

CREATE OR REPLACE FUNCTION refuse_webhook_delivery_identity_change() RETURNS trigger AS $$
BEGIN
  IF (NEW.workspace_id, NEW.endpoint_id, NEW.delivery_id, NEW.event_id, NEW.max_attempts,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.workspace_id, OLD.endpoint_id, OLD.delivery_id, OLD.event_id, OLD.max_attempts,
      OLD.created_at) THEN
    RAISE EXCEPTION 'webhook delivery % identity is immutable', OLD.delivery_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER webhook_delivery_identity_is_immutable
  BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION refuse_webhook_delivery_identity_change();

CREATE TRIGGER webhook_deliveries_are_never_deleted
  BEFORE DELETE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
