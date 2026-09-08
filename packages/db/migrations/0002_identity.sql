-- 0002 — identity, membership, sessions and agent credentials.
--
-- Module 03's reserved migration number. Module 04 owns 0003_journal.sql; the numbers do not
-- overlap and neither file is renumbered once applied.
--
-- Two rules shape this schema:
--
--  1. Every scoped row carries its workspace, and composite foreign keys carry it too, so a
--     child cannot belong to a different workspace than its parent. A valid identifier from
--     another tenant then resolves to nothing at the database level rather than relying on
--     every query remembering to filter.
--  2. No secret is stored. Passwords and agent credentials are Argon2id digests; a session is
--     a hash of its identifier. Reading this schema yields nothing that can authenticate.

-- --------------------------------------------------------------------------------------
-- Workspaces and people
-- --------------------------------------------------------------------------------------

CREATE TABLE workspaces (
  workspace_id  TEXT        NOT NULL PRIMARY KEY,
  display_name  TEXT        NOT NULL,
  version       INTEGER     NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_id_shape CHECK (workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT workspaces_version_positive CHECK (version >= 1)
);

CREATE TABLE users (
  user_id        TEXT        NOT NULL PRIMARY KEY,
  -- A local login name, not an email address: this release has no mail dependency, and
  -- storing an address we never use would be data we cannot justify holding.
  login_name     TEXT        NOT NULL UNIQUE,
  -- Argon2id encoded digest, or NULL until enrollment completes. Never a password.
  password_hash  TEXT,
  disabled_at    TIMESTAMPTZ,
  version        INTEGER     NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_id_shape CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT users_login_shape CHECK (login_name ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  -- Argon2id only. A digest in any other format is a downgrade and is refused here rather
  -- than trusted because the application intended to write argon2.
  CONSTRAINT users_password_is_argon2id CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%'),
  CONSTRAINT users_version_positive CHECK (version >= 1)
);

CREATE TABLE memberships (
  workspace_id TEXT        NOT NULL REFERENCES workspaces (workspace_id),
  user_id      TEXT        NOT NULL REFERENCES users (user_id),
  role         TEXT        NOT NULL,
  version      INTEGER     NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT memberships_role_known CHECK (role IN ('owner', 'operator', 'viewer')),
  CONSTRAINT memberships_version_positive CHECK (version >= 1)
);

-- One owner per workspace in this release. The PRD scopes the product to a single beneficial
-- owner, and a second owner is a trust-model change rather than a configuration one.
CREATE UNIQUE INDEX memberships_single_owner
  ON memberships (workspace_id)
  WHERE role = 'owner';

CREATE INDEX memberships_by_user ON memberships (user_id);

-- --------------------------------------------------------------------------------------
-- Strategies
-- --------------------------------------------------------------------------------------
--
-- Pools arrive with module 04. `pool_id` is carried here as a scoping column now so agent
-- credentials can be bound to one pool from the outset; 0003 adds the referencing constraint
-- rather than this migration reaching forward into a table that does not exist.

CREATE TABLE strategies (
  workspace_id TEXT        NOT NULL REFERENCES workspaces (workspace_id),
  strategy_id  TEXT        NOT NULL,
  pool_id      TEXT        NOT NULL,
  display_name TEXT        NOT NULL,
  archived_at  TIMESTAMPTZ,
  version      INTEGER     NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, strategy_id),
  -- The full scope tuple, so children can reference it as a unit. Without this a child could
  -- name a pool its parent strategy does not belong to, and the composite claim would be
  -- decoration rather than enforcement.
  CONSTRAINT strategies_scope_tuple UNIQUE (workspace_id, pool_id, strategy_id),
  CONSTRAINT strategies_id_shape CHECK (strategy_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT strategies_version_positive CHECK (version >= 1)
);

CREATE INDEX strategies_by_pool ON strategies (workspace_id, pool_id);

-- A strategy's pool is fixed at creation.
--
-- Reparenting would move every credential, claim and intent bound to that strategy into a
-- different pool in one UPDATE, silently relocating authority that was granted against the
-- original scope. Moving a strategy between pools is a new strategy and an explicit
-- reallocation, not an edit, so the database refuses the edit rather than trusting that no
-- caller will attempt it.
CREATE OR REPLACE FUNCTION refuse_strategy_reparent() RETURNS trigger AS $$
BEGIN
  IF NEW.pool_id IS DISTINCT FROM OLD.pool_id THEN
    RAISE EXCEPTION 'strategy % cannot be moved from pool % to pool %',
      OLD.strategy_id, OLD.pool_id, NEW.pool_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'strategy % cannot be moved between workspaces', OLD.strategy_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategies_scope_is_immutable
  BEFORE UPDATE ON strategies
  FOR EACH ROW EXECUTE FUNCTION refuse_strategy_reparent();

-- --------------------------------------------------------------------------------------
-- Owner sessions
-- --------------------------------------------------------------------------------------
--
-- Server-side, so revocation is a state change the next request observes rather than a claim
-- baked into a cookie that stays valid until it expires. Revoking sets revoked_at and a
-- reason; the row is retained, so the trail still shows that the session existed, when it was
-- last seen and when its authority ended.

CREATE TABLE owner_sessions (
  -- SHA-256 of the session identifier. The identifier itself lives only in the cookie, so a
  -- database read cannot resume a session.
  session_id_hash TEXT        NOT NULL PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Absolute expiry, fixed at creation. Activity never extends it.
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  -- Idle expiry, recomputed from last_seen_at on each authenticated request.
  idle_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships (workspace_id, user_id),
  CONSTRAINT owner_sessions_hash_shape CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT owner_sessions_absolute_after_creation CHECK (absolute_expires_at > created_at),
  CONSTRAINT owner_sessions_idle_within_absolute CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX owner_sessions_by_member ON owner_sessions (workspace_id, user_id);
CREATE INDEX owner_sessions_expiry ON owner_sessions (absolute_expires_at);

-- --------------------------------------------------------------------------------------
-- Agent credentials
-- --------------------------------------------------------------------------------------

CREATE TABLE agent_credentials (
  credential_id  TEXT        NOT NULL PRIMARY KEY,
  workspace_id   TEXT        NOT NULL,
  pool_id        TEXT        NOT NULL,
  strategy_id    TEXT        NOT NULL,
  -- Argon2id digest of the secret half. The secret is displayed once at issuance and is not
  -- recoverable from this row.
  secret_hash    TEXT        NOT NULL,
  label          TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  -- Set when this credential replaced another, so a rotation is an auditable chain rather
  -- than an unexplained new row beside a revoked one. Scoped: a rotation must name a
  -- predecessor from the same workspace, pool and strategy, so a chain cannot be used to
  -- inherit provenance from a credential for different authority.
  rotated_from   TEXT,
  -- When the server *sent* the secret in a response. It records that the single display was
  -- attempted, so a second attempt is refused; it is not evidence the holder received it. A
  -- response can be lost after COMMIT, and nothing in the database can tell the difference.
  -- Recovery from a lost display is rotation or reissue, never re-reading this row.
  revealed_at    TIMESTAMPTZ,
  -- The complete scope tuple. Binding only (workspace_id, strategy_id) let a credential name
  -- pool B while its strategy belonged to pool A: both identifiers valid, the pair incoherent.
  FOREIGN KEY (workspace_id, pool_id, strategy_id)
    REFERENCES strategies (workspace_id, pool_id, strategy_id),
  FOREIGN KEY (rotated_from, workspace_id, pool_id, strategy_id)
    REFERENCES agent_credentials (credential_id, workspace_id, pool_id, strategy_id),
  -- Referenced by the scoped rotation key above.
  CONSTRAINT agent_credentials_scope_tuple
    UNIQUE (credential_id, workspace_id, pool_id, strategy_id),
  CONSTRAINT agent_credentials_id_shape CHECK (credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT agent_credentials_secret_is_argon2id CHECK (secret_hash LIKE '$argon2id$%'),
  CONSTRAINT agent_credentials_rotation_is_not_self CHECK (rotated_from IS NULL OR rotated_from <> credential_id)
);

CREATE INDEX agent_credentials_by_strategy
  ON agent_credentials (workspace_id, pool_id, strategy_id);

-- One live credential per strategy. A second active credential is an unnoticed second key to
-- the same authority; rotation revokes before it issues.
CREATE UNIQUE INDEX agent_credentials_single_active
  ON agent_credentials (workspace_id, strategy_id)
  WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------------------
-- One-time owner enrollment
-- --------------------------------------------------------------------------------------
--
-- There is no default owner and no default password. An operator runs a CLI command that
-- prints a single-use code; only its hash is stored.

CREATE TABLE owner_enrollments (
  enrollment_id      TEXT        NOT NULL PRIMARY KEY,
  workspace_id       TEXT        NOT NULL REFERENCES workspaces (workspace_id),
  login_name         TEXT        NOT NULL,
  code_hash          TEXT        NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at        TIMESTAMPTZ,
  consumed_by        TEXT REFERENCES users (user_id),
  -- Withdrawal is an explicit recorded act, not an implicit lapse. See the index below.
  invalidated_at     TIMESTAMPTZ,
  invalidated_reason TEXT,
  CONSTRAINT owner_enrollments_id_shape
    CHECK (enrollment_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT owner_enrollments_login_shape
    CHECK (login_name ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT owner_enrollments_code_is_argon2id CHECK (code_hash LIKE '$argon2id$%'),
  CONSTRAINT owner_enrollments_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT owner_enrollments_consumed_together
    CHECK ((consumed_at IS NULL) = (consumed_by IS NULL)),
  CONSTRAINT owner_enrollments_invalidated_together
    CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL)),
  CONSTRAINT owner_enrollments_invalidation_reason_known
    CHECK (invalidated_reason IS NULL OR invalidated_reason IN ('expired', 'rotated')),
  -- Redeemed and withdrawn are mutually exclusive terminal states, so the surviving record
  -- says exactly what became of the code rather than leaving two readings of the same row.
  CONSTRAINT owner_enrollments_single_terminal_state
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

-- At most one *live* enrollment per workspace.
--
-- Liveness cannot be `expires_at > now()` here: an index predicate must be immutable, and a
-- lapsed code that still occupied the slot would make reissue impossible without deleting
-- history. So expiry is discovered and then recorded: the issuing or redeeming transaction
-- locks the workspace, marks the lapsed row invalidated ('expired') and continues. The same
-- mechanism serves a deliberate operator rotation ('rotated'). Either way the superseded row
-- survives with the reason it stopped being usable.
CREATE UNIQUE INDEX owner_enrollments_single_live
  ON owner_enrollments (workspace_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX owner_enrollments_by_workspace ON owner_enrollments (workspace_id, created_at DESC);

-- --------------------------------------------------------------------------------------
-- Audit
-- --------------------------------------------------------------------------------------
--
-- Append-only. Module 04 adds the role-level revocation of UPDATE and DELETE across every
-- append-only table; the trigger here makes the intent enforced from this migration rather
-- than left to convention in between.

CREATE TABLE audit_events (
  audit_id      BIGSERIAL   NOT NULL PRIMARY KEY,
  workspace_id  TEXT        NOT NULL REFERENCES workspaces (workspace_id),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind    TEXT        NOT NULL,
  actor_id      TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  pool_id       TEXT,
  strategy_id   TEXT,
  outcome       TEXT        NOT NULL,
  -- Non-secret structured context. A CHECK cannot prove the absence of a secret, so the
  -- redaction boundary is enforced in code and tested at the sink; this comment records that
  -- the column is deliberately not a general-purpose payload.
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_actor_kind_known
    CHECK (actor_kind IN ('owner-session', 'agent-credential', 'operator-cli', 'system')),
  CONSTRAINT audit_events_outcome_known CHECK (outcome IN ('allowed', 'denied', 'failed'))
);

CREATE INDEX audit_events_by_workspace ON audit_events (workspace_id, occurred_at DESC);
CREATE INDEX audit_events_by_actor ON audit_events (actor_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
