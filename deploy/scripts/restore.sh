#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'usage: %s BACKUP.dump BACKUP.dump.manifest.json\n' "$0" >&2
  exit 2
fi
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${CAPITALDESK_RESTORE_REASON:?CAPITALDESK_RESTORE_REASON is required}"
if [[ "${CAPITALDESK_RESTORE_ACK:-}" != 'HALT_AND_RECONCILE' ]]; then
  printf 'CAPITALDESK_RESTORE_ACK must equal HALT_AND_RECONCILE\n' >&2
  exit 2
fi

backup_path="$1"
manifest_path="$2"
[[ -f "$backup_path" ]] || { printf 'backup not found: %s\n' "$backup_path" >&2; exit 2; }
[[ -f "$manifest_path" ]] || { printf 'manifest not found: %s\n' "$manifest_path" >&2; exit 2; }
command -v pg_restore >/dev/null || { printf 'pg_restore is required\n' >&2; exit 2; }
command -v psql >/dev/null || { printf 'psql is required\n' >&2; exit 2; }
command -v node >/dev/null || { printf 'node is required\n' >&2; exit 2; }

expected_sha256="$(MANIFEST_PATH="$manifest_path" node --input-type=module <<'NODE'
import fs from 'node:fs';
const value = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, 'utf8'));
if (value.formatVersion !== 1 || typeof value.backupSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.backupSha256)) {
  throw new Error('unsupported or malformed backup manifest');
}
process.stdout.write(value.backupSha256);
NODE
)"
if command -v sha256sum >/dev/null; then
  actual_sha256="$(sha256sum "$backup_path" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$backup_path" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  printf 'backup checksum mismatch\n' >&2
  exit 1
fi

# A restore into a populated database can combine two economic histories. Refuse even if
# pg_restore could technically overwrite or merge objects.
object_count="$(psql "$RESTORE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p','v','m','S');")"
if [[ "$object_count" != '0' ]]; then
  printf 'restore target is not empty (%s user objects); refusing merge\n' "$object_count" >&2
  exit 1
fi

pg_restore \
  --dbname="$RESTORE_DATABASE_URL" \
  --single-transaction \
  --exit-on-error \
  --no-owner \
  --no-acl \
  "$backup_path"

# The restored database remains unusable for dispatch until this transaction halts every
# pool, quarantines old outbox work and preserves marked liabilities for reconciliation.
DATABASE_URL="$RESTORE_DATABASE_URL" pnpm db:restore-posture

printf '{"state":"HALTED_RECONCILING","backupSha256":"%s","dispatchAllowed":false}\n' "$actual_sha256"
