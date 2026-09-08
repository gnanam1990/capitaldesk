-- Modules 14-16: complete fill allocation, financial reconciliation and drift recovery.

ALTER TABLE venue_fills ADD COLUMN exchange_sequence NUMERIC(78,0);
ALTER TABLE venue_fills ADD CONSTRAINT venue_fills_exchange_sequence_positive CHECK (
  exchange_sequence IS NULL OR
  (exchange_sequence=trunc(exchange_sequence) AND exchange_sequence>=0));
CREATE UNIQUE INDEX venue_fills_exchange_order_unique
  ON venue_fills(workspace_id,pool_id,epoch,symbol,venue_order_id,exchange_sequence)
  WHERE exchange_sequence IS NOT NULL;

CREATE TABLE reconciliation_runs (
  workspace_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  reconciliation_id TEXT NOT NULL,
  attempt_id TEXT,
  symbol TEXT,
  venue_order_id TEXT,
  observed_stable_account_id TEXT NOT NULL,
  coverage TEXT NOT NULL,
  accounting_state TEXT NOT NULL DEFAULT 'INCOMPLETE',
  movement_universe_proven BOOLEAN NOT NULL,
  stream_or_gap_certificate BOOLEAN NOT NULL,
  open_orders_complete BOOLEAN NOT NULL,
  trade_backfill_complete BOOLEAN NOT NULL,
  balance_bracket_matches BOOLEAN NOT NULL,
  freshness_complete BOOLEAN NOT NULL,
  before_observation_id TEXT,
  after_observation_id TEXT,
  cursor_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_base_atoms NUMERIC(78,0),
  observed_quote_atoms NUMERIC(78,0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id,pool_id,reconciliation_id),
  FOREIGN KEY (workspace_id,pool_id,epoch) REFERENCES baseline_epochs(workspace_id,pool_id,epoch),
  FOREIGN KEY (workspace_id,pool_id,attempt_id) REFERENCES dispatch_attempts(workspace_id,pool_id,attempt_id),
  CONSTRAINT reconciliation_id_shape CHECK (reconciliation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT reconciliation_coverage_known CHECK (coverage IN ('COMPLETE','GAP_OPEN','BACKFILLING','INCOMPLETE','UNSUPPORTED')),
  CONSTRAINT reconciliation_accounting_known CHECK (accounting_state IN ('INCOMPLETE','PROVISIONAL','RECONCILED','CONFLICT')),
  CONSTRAINT reconciliation_complete_is_proven CHECK (
    coverage <> 'COMPLETE' OR
    (movement_universe_proven AND stream_or_gap_certificate AND open_orders_complete
     AND trade_backfill_complete AND balance_bracket_matches AND freshness_complete)),
  CONSTRAINT reconciliation_totals_nonnegative CHECK (
    (observed_base_atoms IS NULL OR observed_base_atoms >= 0) AND
    (observed_quote_atoms IS NULL OR observed_quote_atoms >= 0))
);

CREATE TRIGGER reconciliation_runs_are_never_deleted
  BEFORE DELETE ON reconciliation_runs FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE fill_allocations (
  workspace_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  venue_order_id TEXT NOT NULL,
  venue_trade_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  gross_base_atoms NUMERIC(78,0) NOT NULL,
  gross_quote_atoms NUMERIC(78,0) NOT NULL,
  commission_asset TEXT NOT NULL,
  commission_scale TEXT NOT NULL,
  commission_atoms NUMERIC(78,0) NOT NULL,
  algorithm_version TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,pool_id,epoch,symbol,venue_order_id,venue_trade_id,strategy_id),
  FOREIGN KEY (workspace_id,pool_id,epoch,symbol,venue_order_id,venue_trade_id)
    REFERENCES venue_fills(workspace_id,pool_id,epoch,symbol,venue_order_id,venue_trade_id),
  FOREIGN KEY (workspace_id,pool_id,strategy_id)
    REFERENCES strategies(workspace_id,pool_id,strategy_id),
  FOREIGN KEY (workspace_id,pool_id,reconciliation_id)
    REFERENCES reconciliation_runs(workspace_id,pool_id,reconciliation_id),
  CONSTRAINT fill_allocations_nonnegative CHECK (
    gross_base_atoms >= 0 AND gross_quote_atoms >= 0 AND commission_atoms >= 0),
  CONSTRAINT fill_allocations_algorithm_pinned CHECK (algorithm_version = 'fifo-circulation-v1')
);

CREATE TRIGGER fill_allocations_are_immutable
  BEFORE UPDATE OR DELETE ON fill_allocations FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE OR REPLACE FUNCTION assert_fill_allocation_conservation() RETURNS trigger AS $$
DECLARE mismatch INTEGER;
BEGIN
  SELECT count(*) INTO mismatch FROM venue_fills f
   WHERE f.workspace_id=NEW.workspace_id AND f.pool_id=NEW.pool_id AND f.epoch=NEW.epoch
     AND f.symbol=NEW.symbol AND f.venue_order_id=NEW.venue_order_id
     AND EXISTS (
       SELECT 1 FROM fill_allocations a
        WHERE a.workspace_id=f.workspace_id AND a.pool_id=f.pool_id AND a.epoch=f.epoch
          AND a.symbol=f.symbol AND a.venue_order_id=f.venue_order_id
          AND a.venue_trade_id=f.venue_trade_id
        GROUP BY a.workspace_id,a.pool_id,a.epoch,a.symbol,a.venue_order_id,a.venue_trade_id
       HAVING sum(a.gross_base_atoms)<>f.base_atoms OR sum(a.gross_quote_atoms)<>f.quote_atoms
          OR sum(a.commission_atoms)<>f.commission_atoms
          OR min(a.commission_asset || ':' || a.commission_scale)<>f.commission_asset
          OR max(a.commission_asset || ':' || a.commission_scale)<>f.commission_asset);
  IF mismatch > 0 THEN
    RAISE EXCEPTION 'fill allocation does not conserve authoritative rows'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER fill_allocations_conserve_source
  AFTER INSERT ON fill_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_fill_allocation_conservation();

CREATE TABLE incidents (
  workspace_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN',
  subject_ref TEXT NOT NULL,
  detail JSONB NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_evidence_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,pool_id,incident_id),
  FOREIGN KEY (workspace_id,pool_id,epoch) REFERENCES baseline_epochs(workspace_id,pool_id,epoch),
  CONSTRAINT incidents_kind_known CHECK (kind IN
    ('FILL_CONFLICT','FEE_DISCREPANCY','EXTERNAL_ACTIVITY','INCOMPLETE_HISTORY',
     'ACCOUNT_IDENTITY_MISMATCH','SCALE_CHANGE','EPOCH_RESET','BALANCE_DRIFT','UNKNOWN_ORDER')),
  CONSTRAINT incidents_state_known CHECK (state IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  CONSTRAINT incidents_ack_together CHECK ((acknowledged_at IS NULL)=(acknowledged_by IS NULL)),
  CONSTRAINT incidents_resolution_together CHECK (
    (resolved_at IS NULL)=(resolved_by IS NULL) AND
    (resolved_at IS NULL)=(resolution_evidence_ref IS NULL))
);

CREATE TRIGGER incidents_are_never_deleted
  BEFORE DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE recovery_corrections (
  workspace_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  correction_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  actor_subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_evidence_ref TEXT NOT NULL,
  ledger_txn_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,pool_id,correction_id),
  FOREIGN KEY (workspace_id,pool_id,incident_id) REFERENCES incidents(workspace_id,pool_id,incident_id),
  FOREIGN KEY (workspace_id,pool_id,ledger_txn_id) REFERENCES ledger_transactions(workspace_id,pool_id,ledger_txn_id)
);

CREATE TRIGGER recovery_corrections_are_immutable
  BEFORE UPDATE OR DELETE ON recovery_corrections FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE non_send_evidence (
  workspace_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sender_fenced BOOLEAN NOT NULL,
  no_send_attempt_recorded BOOLEAN NOT NULL,
  client_order_absent BOOLEAN NOT NULL,
  uncertainty_window_start TIMESTAMPTZ NOT NULL,
  uncertainty_window_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,pool_id,evidence_id),
  FOREIGN KEY (workspace_id,pool_id,reconciliation_id)
    REFERENCES reconciliation_runs(workspace_id,pool_id,reconciliation_id),
  FOREIGN KEY (workspace_id,pool_id,attempt_id)
    REFERENCES dispatch_attempts(workspace_id,pool_id,attempt_id),
  CONSTRAINT non_send_positive_proof CHECK (
    sender_fenced AND no_send_attempt_recorded AND client_order_absent
    AND uncertainty_window_end >= uncertainty_window_start)
);

CREATE TRIGGER non_send_evidence_is_immutable
  BEFORE UPDATE OR DELETE ON non_send_evidence FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

ALTER TABLE dispatch_attempts DROP CONSTRAINT dispatch_attempts_not_sent_unreachable;
ALTER TABLE dispatch_attempts ADD COLUMN non_send_evidence_id TEXT;
ALTER TABLE dispatch_attempts ADD CONSTRAINT dispatch_attempt_non_send_evidence
  FOREIGN KEY (workspace_id,pool_id,non_send_evidence_id)
  REFERENCES non_send_evidence(workspace_id,pool_id,evidence_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE dispatch_attempts ADD CONSTRAINT dispatch_attempt_not_sent_is_evidenced CHECK (
  state <> 'NOT_SENT_PROVEN' OR non_send_evidence_id IS NOT NULL);

DROP TRIGGER dispatch_attempts_move_forward_only ON dispatch_attempts;
CREATE OR REPLACE FUNCTION refuse_dispatch_regression() RETURNS trigger AS $$
DECLARE permitted BOOLEAN;
BEGIN
  IF NEW.client_order_id IS DISTINCT FROM OLD.client_order_id
     OR NEW.dispatch_token IS DISTINCT FROM OLD.dispatch_token
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.epoch IS DISTINCT FROM OLD.epoch
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR (OLD.marked_at IS NOT NULL AND NEW.marked_at IS DISTINCT FROM OLD.marked_at)
     OR (OLD.send_attempted_at IS NOT NULL AND NEW.send_attempted_at IS DISTINCT FROM OLD.send_attempted_at)
     OR (OLD.signed_request IS NOT NULL AND NEW.signed_request IS DISTINCT FROM OLD.signed_request) THEN
    RAISE EXCEPTION 'dispatch attempt % identity is immutable', OLD.attempt_id
      USING ERRCODE='restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.voided_at IS NULL) THEN
    RAISE EXCEPTION 'voided attempt % cannot change', OLD.attempt_id USING ERRCODE='restrict_violation';
  END IF;
  IF NEW.state=OLD.state THEN RETURN NEW; END IF;
  permitted := CASE OLD.state
    WHEN 'PREPARED' THEN NEW.state='DISPATCH_MARKED'
    WHEN 'DISPATCH_MARKED' THEN NEW.state IN ('SEND_ATTEMPTED','UNKNOWN','NOT_SENT_PROVEN')
    WHEN 'SEND_ATTEMPTED' THEN NEW.state IN ('ACKNOWLEDGED','REJECTED','UNKNOWN')
    WHEN 'UNKNOWN' THEN NEW.state IN ('ACKNOWLEDGED','REJECTED','NOT_SENT_PROVEN','IRRECOVERABLE_UNCERTAINTY')
    ELSE FALSE END;
  IF NOT permitted THEN
    RAISE EXCEPTION 'dispatch attempt % cannot move from % to %',OLD.attempt_id,OLD.state,NEW.state
      USING ERRCODE='restrict_violation';
  END IF;
  IF NEW.state='NOT_SENT_PROVEN' AND
     (OLD.state NOT IN ('DISPATCH_MARKED','UNKNOWN') OR OLD.send_attempted_at IS NOT NULL
      OR NEW.non_send_evidence_id IS NULL) THEN
    RAISE EXCEPTION 'NOT_SENT_PROVEN requires a never-sent marked attempt and durable evidence'
      USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dispatch_attempts_move_forward_only
  BEFORE UPDATE ON dispatch_attempts FOR EACH ROW EXECUTE FUNCTION refuse_dispatch_regression();

CREATE INDEX active_incidents_by_pool ON incidents(workspace_id,pool_id,created_at)
  WHERE state <> 'RESOLVED';
