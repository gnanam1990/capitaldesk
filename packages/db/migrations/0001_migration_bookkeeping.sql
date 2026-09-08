-- 0001 — migration bookkeeping only.
--
-- This migration deliberately creates no economic table. Economic schema (journal, ledger,
-- reservations, dispatch attempts, raw observations) is owned by module 04 and must arrive
-- with its constraints, not as an empty shell that later looks implemented.
--
-- Migrations are forward-only and additive. There is no down migration: dropping an
-- economic table is prohibited (TDD section 10, "economic deletion is prohibited").

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      TEXT        NOT NULL PRIMARY KEY,
  checksum     TEXT        NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by   TEXT        NOT NULL,
  build_id     TEXT        NOT NULL
);

COMMENT ON TABLE schema_migrations IS
  'Applied migration ledger. The checksum pins the exact SQL text that was applied; a '
  'changed file for an already-applied version is refused rather than reapplied.';
