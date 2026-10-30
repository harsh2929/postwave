#!/usr/bin/env bash
# create-postgres-backup.sh
#
# Create an auditable Moosewave Postgres logical backup:
#   - pg_dump custom-format artifact
#   - sha256 checksum
#   - JSON manifest with DB/server/schema metadata and core row counts
#
# This script is intended for local/self-host/pre-update safety snapshots.
# Cloud CronJobs use the same manifest shape in infra/backup/.

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"
OUTPUT_DIR="${OUTPUT_DIR:-./backups/postgres}"
ENVIRONMENT="${ENVIRONMENT:-local}"
LABEL="${LABEL:-manual}"
MIN_BACKUP_BYTES="${MIN_BACKUP_BYTES:-1024}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url)
      DATABASE_URL="$2"; shift 2 ;;
    --output-dir)
      OUTPUT_DIR="$2"; shift 2 ;;
    --env)
      ENVIRONMENT="$2"; shift 2 ;;
    --label)
      LABEL="$2"; shift 2 ;;
    --min-bytes)
      MIN_BACKUP_BYTES="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,34p' "$0"; exit 0 ;;
    *)
      echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${DATABASE_URL}" ]]; then
  echo "DATABASE_URL is required (or pass --database-url)" >&2
  exit 64
fi
[[ "${ENVIRONMENT}" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || {
  echo "--env must contain only lowercase letters, digits, and hyphens" >&2
  exit 64
}
[[ "${LABEL}" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || {
  echo "--label must contain only lowercase letters, digits, and hyphens" >&2
  exit 64
}
[[ "${MIN_BACKUP_BYTES}" =~ ^[1-9][0-9]*$ ]] || {
  echo "--min-bytes must be a positive integer" >&2
  exit 64
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command not found: $1" >&2
    exit 69
  fi
}

need pg_dump
need pg_restore
need psql
need jq

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

q() {
  psql "${DATABASE_URL}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1"
}

safe_count() {
  local table="$1"
  local exists
  exists="$(q "SELECT to_regclass('public.${table}') IS NOT NULL")"
  if [[ "${exists}" != "t" ]]; then
    printf 'null'
    return
  fi
  q "SELECT count(*) FROM public.${table}"
}

table_exists() {
  local table="$1"
  q "SELECT to_regclass('public.${table}') IS NOT NULL"
}

umask 077
mkdir -p "${OUTPUT_DIR}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="postwave-${ENVIRONMENT}-${LABEL}-${TS}"
DUMP_PATH="${OUTPUT_DIR}/${BASE}.dump"
SHA_PATH="${DUMP_PATH}.sha256"
MANIFEST_PATH="${DUMP_PATH}.manifest.json"

for path in "${DUMP_PATH}" "${SHA_PATH}" "${MANIFEST_PATH}"; do
  [[ ! -e "${path}" && ! -L "${path}" ]] || {
    echo "refusing to overwrite existing backup artifact: ${path}" >&2
    exit 1
  }
done

echo "==> creating ${DUMP_PATH}"
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="${DUMP_PATH}" \
  "${DATABASE_URL}"

if ! head -c 5 "${DUMP_PATH}" | grep -q "PGDMP"; then
  echo "backup sanity failed: ${DUMP_PATH} is not a custom-format pg_dump" >&2
  exit 1
fi

BYTES="$(wc -c <"${DUMP_PATH}" | tr -d ' ')"
if [[ "${BYTES}" -lt "${MIN_BACKUP_BYTES}" ]]; then
  echo "backup sanity failed: ${DUMP_PATH} is only ${BYTES} bytes" >&2
  exit 1
fi

pg_restore --list "${DUMP_PATH}" >/dev/null
SHA="$(checksum "${DUMP_PATH}")"
printf '%s  %s\n' "${SHA}" "$(basename "${DUMP_PATH}")" >"${SHA_PATH}"

SERVER_VERSION="$(q "SHOW server_version")"
DATABASE_NAME="$(q "SELECT current_database()")"
CURRENT_USER_NAME="$(q "SELECT current_user")"
if [[ "$(table_exists schema_migrations)" == "t" ]]; then
  LATEST_MIGRATION="$(q "SELECT COALESCE((SELECT version FROM public.schema_migrations ORDER BY version DESC LIMIT 1), '')")"
  MIGRATION_COUNT="$(q "SELECT count(*) FROM public.schema_migrations")"
else
  LATEST_MIGRATION=""
  MIGRATION_COUNT="0"
fi

TENANTS="$(safe_count tenants)"
USERS="$(safe_count users)"
SUBSCRIBERS="$(safe_count subscribers)"
CAMPAIGNS="$(safe_count campaigns)"
AUDIT_LOG="$(safe_count audit_log)"
OUTBOX="$(safe_count outbox_events)"
MIGRATION_JOBS="$(safe_count migration_jobs)"

jq -n \
  --arg created_at "$(date -u +%FT%TZ)" \
  --arg env "${ENVIRONMENT}" \
  --arg label "${LABEL}" \
  --arg dump_file "$(basename "${DUMP_PATH}")" \
  --arg sha256 "${SHA}" \
  --arg server_version "${SERVER_VERSION}" \
  --arg database "${DATABASE_NAME}" \
  --arg db_user "${CURRENT_USER_NAME}" \
  --arg latest_migration "${LATEST_MIGRATION}" \
  --argjson bytes "${BYTES}" \
  --argjson migration_count "${MIGRATION_COUNT}" \
  --argjson tenants "${TENANTS}" \
  --argjson users "${USERS}" \
  --argjson subscribers "${SUBSCRIBERS}" \
  --argjson campaigns "${CAMPAIGNS}" \
  --argjson audit_log "${AUDIT_LOG}" \
  --argjson outbox_events "${OUTBOX}" \
  --argjson migration_jobs "${MIGRATION_JOBS}" \
  '{
    manifest_version: 2,
    kind: "postgres_logical_backup",
    created_at: $created_at,
    environment: $env,
    label: $label,
    artifact: {
      file: $dump_file,
      bytes: $bytes,
      sha256: $sha256,
      format: "pg_dump_custom"
    },
    postgres: {
      server_version: $server_version,
      database: $database,
      user: $db_user
    },
    schema: {
      latest_migration: $latest_migration,
      migration_count: $migration_count
    },
    diagnostic_row_counts_after_dump: {
      tenants: $tenants,
      users: $users,
      subscribers: $subscribers,
      campaigns: $campaigns,
      audit_log: $audit_log,
      outbox_events: $outbox_events,
      migration_jobs: $migration_jobs
    },
    row_counts_are_transactionally_bound_to_dump: false
  }' >"${MANIFEST_PATH}"

echo "BACKUP_DUMP=${DUMP_PATH}"
echo "BACKUP_SHA256=${SHA_PATH}"
echo "BACKUP_MANIFEST=${MANIFEST_PATH}"
