#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail
source /usr/local/lib/postwave-backup/common.sh

for name in DATABASE_URL BACKUP_BUCKET BACKUP_KMS_KEY_ID AWS_REGION BACKUP_ENVIRONMENT BACKUP_EVIDENCE_SIGNING_KEY_ID; do
  require_env "${name}"
done
for command_name in aws jq openssl pg_dump pg_restore psql; do
  require_command "${command_name}"
done

workdir="$(mktemp -d)"
backup_id="logical-$(date -u +%Y%m%dT%H%M%SZ)"
dump="${workdir}/${backup_id}.dump"
dump_checksum="${dump}.sha256"
manifest="${dump}.manifest.json"
manifest_checksum="${manifest}.sha256"
signature="${manifest}.sig.json"
key_prefix="postgres/${BACKUP_ENVIRONMENT}/logical/$(date -u +%Y/%m/%d)/${backup_id}"
started_at="$(date -u +%FT%TZ)"
start_epoch="$(date -u +%s)"

cleanup() {
  local status=$?
  rm -rf "${workdir}"
  if [[ "${status}" -ne 0 ]]; then
    put_metric_best_effort BackupJobFailures 1 Count
    put_metric_best_effort LogicalBackupHealthy 0 None
  fi
  exit "${status}"
}
trap cleanup EXIT

q() {
  psql "${DATABASE_URL}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1"
}

safe_count() {
  local table="$1"
  if [[ "$(q "SELECT to_regclass('public.${table}') IS NOT NULL")" == "t" ]]; then
    q "SELECT count(*) FROM public.${table}"
  else
    printf 'null\n'
  fi
}

log "creating logical backup ${backup_id}"
pg_dump \
  --dbname="${DATABASE_URL}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="${dump}"
head -c 5 "${dump}" | grep -qx 'PGDMP' || fail "pg_dump artifact has invalid magic bytes"
pg_restore --list "${dump}" >/dev/null

dump_sha="$(sha256_file "${dump}")"
dump_bytes="$(wc -c <"${dump}" | tr -d ' ')"
[[ "${dump_bytes}" -ge "${MIN_LOGICAL_BACKUP_BYTES:-1024}" ]] || fail "logical backup is unexpectedly small: ${dump_bytes} bytes"
printf '%s  %s\n' "${dump_sha}" "$(basename "${dump}")" >"${dump_checksum}"

completed_at="$(date -u +%FT%TZ)"
duration_seconds="$(( $(date -u +%s) - start_epoch ))"
latest_migration="$(q "SELECT COALESCE((SELECT version::text FROM public.schema_migrations ORDER BY version DESC LIMIT 1), '')")"
migration_count="$(q 'SELECT count(*) FROM public.schema_migrations')"

jq -n \
  --arg backup_id "${backup_id}" \
  --arg environment "${BACKUP_ENVIRONMENT}" \
  --arg started_at "${started_at}" \
  --arg completed_at "${completed_at}" \
  --arg file "$(basename "${dump}")" \
  --arg sha256 "${dump_sha}" \
  --arg postgres_version "$(q 'SHOW server_version')" \
  --arg database "$(q 'SELECT current_database()')" \
  --arg latest_migration "${latest_migration}" \
  --argjson bytes "${dump_bytes}" \
  --argjson duration_seconds "${duration_seconds}" \
  --argjson migration_count "${migration_count}" \
  --argjson tenants "$(safe_count tenants)" \
  --argjson users "$(safe_count users)" \
  --argjson subscribers "$(safe_count subscribers)" \
  --argjson campaigns "$(safe_count campaigns)" \
  --argjson audit_log "$(safe_count audit_log)" \
  '{
    manifest_version: 2,
    kind: "postgres_logical_backup",
    backup_id: $backup_id,
    environment: $environment,
    started_at: $started_at,
    completed_at: $completed_at,
    duration_seconds: $duration_seconds,
    artifact: {file:$file,bytes:$bytes,sha256:$sha256,format:"pg_dump_custom"},
    postgres: {version:$postgres_version,database:$database},
    schema: {latest_migration:$latest_migration,migration_count:$migration_count},
    diagnostic_row_counts_after_dump: {
      tenants:$tenants,users:$users,subscribers:$subscribers,campaigns:$campaigns,audit_log:$audit_log
    },
    row_counts_are_transactionally_bound_to_dump: false
  }' >"${manifest}"

printf '%s  %s\n' "$(sha256_file "${manifest}")" "$(basename "${manifest}")" >"${manifest_checksum}"
sign_file "${manifest}" "${signature}"

upload_evidence_file "${dump}" "${key_prefix}/$(basename "${dump}")" logical_dump
upload_evidence_file "${dump_checksum}" "${key_prefix}/$(basename "${dump_checksum}")" checksum
upload_evidence_file "${manifest}" "${key_prefix}/manifest.json" manifest
upload_evidence_file "${manifest_checksum}" "${key_prefix}/manifest.json.sha256" checksum
upload_evidence_file "${signature}" "${key_prefix}/manifest.json.sig.json" signature
upload_evidence_file "${manifest}" "postgres/${BACKUP_ENVIRONMENT}/health/logical-backup/latest.json" heartbeat

put_metric LogicalBackupAgeSeconds 0 Seconds
put_metric LogicalBackupDurationSeconds "${duration_seconds}" Seconds
put_metric LogicalBackupHealthy 1 None
log "completed signed logical backup ${backup_id} in ${duration_seconds}s"

