#!/usr/bin/env bash
set -euo pipefail
umask 077

required=(DATABASE_URL BACKUP_DIR CAPITALDESK_BUILD_ID CAPITALDESK_ENV)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf '%s is required\n' "$name" >&2
    exit 2
  fi
done

case "$CAPITALDESK_ENV" in
  local|testnet|production-read-only) ;;
  *) printf 'refusing unknown CAPITALDESK_ENV=%s\n' "$CAPITALDESK_ENV" >&2; exit 2 ;;
esac

command -v pg_dump >/dev/null || { printf 'pg_dump is required\n' >&2; exit 2; }
command -v node >/dev/null || { printf 'node is required\n' >&2; exit 2; }

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
stem="capitaldesk-${CAPITALDESK_ENV}-${timestamp}-${CAPITALDESK_BUILD_ID//[^a-zA-Z0-9._-]/_}"
backup_path="$BACKUP_DIR/$stem.dump"
manifest_path="$backup_path.manifest.json"
temporary_path="$backup_path.partial"
trap 'rm -f "$temporary_path" "$manifest_path.partial"' EXIT

pg_dump "$DATABASE_URL" \
  --format=custom \
  --serializable-deferrable \
  --no-owner \
  --no-acl \
  --file="$temporary_path"

if command -v sha256sum >/dev/null; then
  backup_sha256="$(sha256sum "$temporary_path" | awk '{print $1}')"
  migration_sha256="$(find "$repo_root/packages/db/migrations" -type f -name '*.sql' -print0 | sort -z | xargs -0 cat | sha256sum | awk '{print $1}')"
else
  backup_sha256="$(shasum -a 256 "$temporary_path" | awk '{print $1}')"
  migration_sha256="$(find "$repo_root/packages/db/migrations" -type f -name '*.sql' -print0 | sort -z | xargs -0 cat | shasum -a 256 | awk '{print $1}')"
fi

# This fingerprint intentionally excludes URLs and credential references. It binds the
# economic posture without copying secrets or infrastructure coordinates into the manifest.
config_material="CAPITALDESK_ENV=$CAPITALDESK_ENV
CAPITALDESK_BUILD_ID=$CAPITALDESK_BUILD_ID
CAPITALDESK_ACCOUNT_ALIAS=${CAPITALDESK_ACCOUNT_ALIAS:-unset}
CAPITALDESK_BASELINE_EPOCH=${CAPITALDESK_BASELINE_EPOCH:-unset}
CAPITALDESK_AUTHORIZATION_DURABILITY=${CAPITALDESK_AUTHORIZATION_DURABILITY:-unset}"
if command -v sha256sum >/dev/null; then
  config_sha256="$(printf '%s' "$config_material" | sha256sum | awk '{print $1}')"
else
  config_sha256="$(printf '%s' "$config_material" | shasum -a 256 | awk '{print $1}')"
fi

export BACKUP_FILE_NAME="$(basename "$backup_path")" BACKUP_SHA256="$backup_sha256"
export MIGRATION_SHA256="$migration_sha256" CONFIG_SHA256="$config_sha256" BACKUP_TIMESTAMP="$timestamp"
node --input-type=module >"$manifest_path.partial" <<'NODE'
const manifest = {
  formatVersion: 1,
  createdAt: process.env.BACKUP_TIMESTAMP,
  backupFile: process.env.BACKUP_FILE_NAME,
  backupSha256: process.env.BACKUP_SHA256,
  buildId: process.env.CAPITALDESK_BUILD_ID,
  deploymentEnvironment: process.env.CAPITALDESK_ENV,
  migrationSetSha256: process.env.MIGRATION_SHA256,
  nonSecretConfigSha256: process.env.CONFIG_SHA256,
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
NODE

mv "$temporary_path" "$backup_path"
mv "$manifest_path.partial" "$manifest_path"
printf '%s  %s\n' "$backup_sha256" "$(basename "$backup_path")" >"$backup_path.sha256"
trap - EXIT
printf '{"backup":"%s","manifest":"%s","sha256":"%s"}\n' "$backup_path" "$manifest_path" "$backup_sha256"
