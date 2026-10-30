#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail
source /usr/local/lib/postwave-backup/common.sh

for name in WALG_S3_PREFIX PGDATA BACKUP_BUCKET BACKUP_KMS_KEY_ID AWS_REGION BACKUP_ENVIRONMENT BACKUP_CLUSTER_ID POSTGRES_SYSTEM_IDENTIFIER; do
  require_env "${name}"
done
for command_name in aws jq pg_isready psql timeout wal-g; do
  require_command "${command_name}"
done
base_backup_timeout="${BASE_BACKUP_TIMEOUT_SECONDS:-21600}"
wal_verify_timeout="${WAL_VERIFY_TIMEOUT_SECONDS:-3600}"
[[ "${base_backup_timeout}" =~ ^[1-9][0-9]*$ ]] || fail "BASE_BACKUP_TIMEOUT_SECONDS must be a positive integer"
[[ "${wal_verify_timeout}" =~ ^[1-9][0-9]*$ ]] || fail "WAL_VERIFY_TIMEOUT_SECONDS must be a positive integer"

workdir="$(mktemp -d)"
backup_id="base-$(date -u +%Y%m%dT%H%M%SZ)"
manifest="${workdir}/${backup_id}.manifest.json"
checksum="${manifest}.sha256"
wal_verify="${workdir}/wal-verify.json"
backup_list="${workdir}/backup-list.json"

cleanup() {
  local status=$?
  rm -rf "${workdir}"
  if [[ "${status}" -ne 0 ]]; then
    put_metric_best_effort BackupJobFailures 1 Count
    put_metric_best_effort BaseBackupHealthy 0 None
  fi
  exit "${status}"
}
trap cleanup EXIT

pg_isready --timeout=5 >/dev/null || fail "PostgreSQL is not ready for a physical backup"
data_checksums="$(psql --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c 'SHOW data_checksums')"
[[ "${data_checksums}" == "on" ]] || fail "PostgreSQL data checksums are disabled; verified physical backups require checksums"
actual_system_identifier="$(psql --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c 'SELECT system_identifier FROM pg_control_system()')"
[[ "${actual_system_identifier}" == "${POSTGRES_SYSTEM_IDENTIFIER}" ]] || fail "PostgreSQL system identifier does not match the rendered immutable backup generation"
started_at="$(date -u +%FT%TZ)"
start_epoch="$(date -u +%s)"

export WALG_SENTINEL_USER_DATA
WALG_SENTINEL_USER_DATA="$(jq -nc \
  --arg backup_id "${backup_id}" \
  --arg environment "${BACKUP_ENVIRONMENT}" \
  --arg cluster_id "${BACKUP_CLUSTER_ID}" \
  --arg system_identifier "${actual_system_identifier}" \
  '{postwave_backup_id:$backup_id,environment:$environment,cluster_id:$cluster_id,system_identifier:$system_identifier,scheduled:true}')"

log "starting verified WAL-G base backup ${backup_id} from ${PGDATA}"
timeout --signal=TERM --kill-after=60 "${base_backup_timeout}" wal-g backup-push --verify "${PGDATA}"
wal-g backup-list --detail --json >"${backup_list}"
timeout --signal=TERM --kill-after=60 "${wal_verify_timeout}" wal-g wal-verify integrity timeline --json >"${wal_verify}"
jq -e '.integrity.status == "OK" and .timeline.status == "OK"' "${wal_verify}" >/dev/null || fail "WAL integrity/timeline verification did not report OK"

matching_backups="$(jq -c --arg backup_id "${backup_id}" '
  def user_data:
    (.user_data // .UserData // .userData // .userdata // {}) |
    if type == "string" then (try fromjson catch {}) else . end;
  [.[] | select((user_data.postwave_backup_id // "") == $backup_id)]
' "${backup_list}")"
[[ "$(jq 'length' <<<"${matching_backups}")" -eq 1 ]] || fail "WAL-G catalog did not contain exactly one completed backup with this job sentinel"
latest_backup="$(jq -c '.[0]' <<<"${matching_backups}")"
walg_backup_name="$(jq -r '.backup_name // .BackupName // .name // empty' <<<"${latest_backup}")"
[[ "${walg_backup_name}" =~ ^base_[A-Za-z0-9._-]+$ ]] || fail "WAL-G returned an unsafe or missing backup name"
evidence_prefix="postgres/${BACKUP_ENVIRONMENT}/evidence/base-backups/${walg_backup_name}"

completed_at="$(date -u +%FT%TZ)"
duration_seconds="$(( $(date -u +%s) - start_epoch ))"
current_lsn="$(psql --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c 'SELECT pg_current_wal_lsn()')"

jq -n \
  --arg backup_id "${backup_id}" \
  --arg environment "${BACKUP_ENVIRONMENT}" \
  --arg cluster_id "${BACKUP_CLUSTER_ID}" \
  --arg system_identifier "${actual_system_identifier}" \
  --arg started_at "${started_at}" \
  --arg completed_at "${completed_at}" \
  --arg walg_prefix "${WALG_S3_PREFIX}" \
  --arg current_lsn "${current_lsn}" \
  --argjson duration_seconds "${duration_seconds}" \
  --argjson latest_backup "${latest_backup}" \
  --slurpfile wal_integrity "${wal_verify}" \
  '{
    manifest_version: 2,
    kind: "postgres_walg_base_backup",
    backup_id: $backup_id,
    environment: $environment,
    cluster_id: $cluster_id,
    postgres_system_identifier: $system_identifier,
    started_at: $started_at,
    completed_at: $completed_at,
    duration_seconds: $duration_seconds,
    walg_prefix: $walg_prefix,
    postgres_lsn_after_backup: $current_lsn,
    page_checksums_verified: true,
    latest_backup: $latest_backup,
    wal_integrity: $wal_integrity[0]
  }' >"${manifest}"

printf '%s  %s\n' "$(sha256_file "${manifest}")" "$(basename "${manifest}")" >"${checksum}"
upload_evidence_file "${manifest}" "${evidence_prefix}/manifest.json" manifest
upload_evidence_file "${checksum}" "${evidence_prefix}/manifest.json.sha256" checksum
upload_evidence_file "${manifest}" "postgres/${BACKUP_ENVIRONMENT}/health/base-backup/latest.json" heartbeat

put_metric BaseBackupAgeSeconds 0 Seconds
put_metric BaseBackupDurationSeconds "${duration_seconds}" Seconds
put_metric BaseBackupHealthy 1 None
put_metric WalIntegrityHealthy 1 None

# The runtime role intentionally has no delete permission. Object Lock and the
# bucket lifecycle retain and expire WAL/base-backup objects; issuing a WAL-G
# delete here would turn every locked cleanup attempt into a false job failure.
log "completed WAL-G base backup ${backup_id} in ${duration_seconds}s; the separate evidence signer will attest it"
