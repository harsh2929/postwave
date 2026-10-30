#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail
source /usr/local/lib/postwave-backup/common.sh

for name in BACKUP_BUCKET BACKUP_REPLICA_BUCKET BACKUP_KMS_KEY_ID AWS_REGION BACKUP_REPLICA_REGION BACKUP_ENVIRONMENT BACKUP_EVIDENCE_SIGNING_KEY_ID; do
  require_env "${name}"
done
for command_name in aws jq openssl psql; do
  require_command "${command_name}"
done

missing_age="2147483647"
monitor_workdir="$(mktemp -d)"
cleanup() { rm -rf "${monitor_workdir}"; }
trap cleanup EXIT

metric_for_latest() {
  local metric="$1"
  local bucket="$2"
  local prefix="$3"
  local region="$4"
  local latest
  local age

  latest="$(latest_s3_timestamp "${bucket}" "${prefix}" "${region}")"
  if [[ -z "${latest}" || "${latest}" == "None" ]]; then
    age="${missing_age}"
  else
    age="$(age_seconds "${latest}")"
    [[ "${age}" -ge 0 ]] || age=0
  fi
  put_metric "${metric}" "${age}" Seconds
  printf '%s\n' "${age}"
}

metric_for_latest_signed_base() {
  local key="postgres/${BACKUP_ENVIRONMENT}/health/base-backup-signed/latest.json"
  local manifest="${monitor_workdir}/base-backup-signed.json"
  local completed_at age
  age="${missing_age}"
  if aws s3api get-object \
      --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${key}" \
      "${manifest}" >/dev/null 2>&1 &&
     jq -e --arg environment "${BACKUP_ENVIRONMENT}" '
       .manifest_version == 2 and
       .kind == "postgres_walg_base_backup" and
       .environment == $environment and
       .page_checksums_verified == true and
       .wal_integrity.integrity.status == "OK" and
       .wal_integrity.timeline.status == "OK" and
       (.completed_at | type == "string" and length > 0)
     ' "${manifest}" >/dev/null 2>&1; then
    completed_at="$(jq -r '.completed_at' "${manifest}")"
    if age="$(age_seconds "${completed_at}" 2>/dev/null)"; then
      [[ "${age}" -ge 0 ]] || age=0
    else
      age="${missing_age}"
    fi
  fi
  put_metric BaseBackupAgeSeconds "${age}" Seconds
  printf '%s\n' "${age}"
}

metric_for_latest_signed_restore_success() {
  local prefix="postgres/${BACKUP_ENVIRONMENT}/evidence/restore-drills/passed/"
  local catalog="${monitor_workdir}/restore-catalog.json"
  local evidence="${monitor_workdir}/restore-evidence.json"
  local signature_json="${monitor_workdir}/restore-evidence.sig.json"
  local commit="${monitor_workdir}/restore-complete.json"
  local digest="${monitor_workdir}/restore-evidence.digest"
  local signature="${monitor_workdir}/restore-evidence.signature"
  local key=""
  local commit_key=""
  local signature_key
  local actual_sha expected_sha signature_key_id signature_base64 completed_at candidate_age
  local age="${missing_age}"

  if aws s3api list-objects-v2 \
      --region "${AWS_REGION}" \
      --bucket "${BACKUP_BUCKET}" \
      --prefix "${prefix}" \
      --output json >"${catalog}"; then
    key="$(jq -r '[.Contents[]? | select(.Key | endswith("/complete.json"))] | sort_by(.LastModified) | last | .Key // empty' "${catalog}")"
  fi

  if [[ -n "${key}" ]]; then
    commit_key="${key}"
    key="${commit_key%/complete.json}/evidence.json"
    signature_key="${key}.sig.json"
    if aws s3api get-object --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${commit_key}" "${commit}" >/dev/null 2>&1 &&
       aws s3api get-object --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${key}" "${evidence}" >/dev/null 2>&1 &&
       aws s3api get-object --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${signature_key}" "${signature_json}" >/dev/null 2>&1 &&
       jq -e --arg environment "${BACKUP_ENVIRONMENT}" '.kind == "postgres_restore_drill" and .result == "passed" and .environment == $environment' "${evidence}" >/dev/null 2>&1 &&
       jq -e --arg evidence_sha256 "$(sha256_file "${evidence}")" --arg signature_sha256 "$(sha256_file "${signature_json}")" \
         '.result == "passed" and .evidence_sha256 == $evidence_sha256 and .signature_sha256 == $signature_sha256' "${commit}" >/dev/null 2>&1; then
      actual_sha="$(sha256_file "${evidence}")"
      expected_sha="$(jq -r '.sha256 // empty' "${signature_json}")"
      signature_key_id="$(jq -r '.key_id // empty' "${signature_json}")"
      signature_base64="$(jq -r '.signature_base64 // empty' "${signature_json}")"
      if [[ "${expected_sha}" == "${actual_sha}" && "${signature_key_id}" == "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" ]] &&
         jq -e '.algorithm == "RSASSA_PSS_SHA_256" and .message_type == "DIGEST"' "${signature_json}" >/dev/null 2>&1 &&
         openssl dgst -sha256 -binary -out "${digest}" "${evidence}" &&
         printf '%s' "${signature_base64}" | openssl base64 -d -A -out "${signature}" &&
         aws kms verify \
           --region "${AWS_REGION}" \
           --key-id "${signature_key_id}" \
           --message-type DIGEST \
           --signing-algorithm RSASSA_PSS_SHA_256 \
           --message "fileb://${digest}" \
           --signature "fileb://${signature}" \
           --query SignatureValid --output text | grep -qx 'True'; then
        completed_at="$(jq -r '.completed_at // empty' "${evidence}")"
        if candidate_age="$(age_seconds "${completed_at}" 2>/dev/null)"; then
          [[ "${candidate_age}" -ge 0 ]] || candidate_age=0
          age="${candidate_age}"
        fi
      fi
    fi
  fi

  put_metric RestoreVerificationAgeSeconds "${age}" Seconds
  printf '%s\n' "${age}"
}

metric_for_postgres_archiver() {
  local archived_at
  local age="${missing_age}"
  archived_at="$(psql --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -c "SELECT COALESCE(to_char(last_archived_time AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),'') FROM pg_stat_archiver")"
  if [[ -n "${archived_at}" ]]; then
    age="$(age_seconds "${archived_at}")"
    [[ "${age}" -ge 0 ]] || age=0
  fi
  put_metric WalArchiveAgeSeconds "${age}" Seconds
  printf '%s\n' "${age}"
}

metric_for_replication_canary() {
  local key="postgres/${BACKUP_ENVIRONMENT}/health/replication-canary/latest.json"
  local source="${monitor_workdir}/replication-canary-source.json"
  local replica="${monitor_workdir}/replication-canary-replica.json"
  local next="${monitor_workdir}/replication-canary-next.json"
  local source_id=""
  local replica_id=""
  local generated_at=""
  local lag="${missing_age}"
  local publish_next=0

  if aws s3api get-object --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${key}" "${source}" >/dev/null 2>&1; then
    source_id="$(jq -r '.canary_id // empty' "${source}")"
    generated_at="$(jq -r '.generated_at // empty' "${source}")"
    if aws s3api get-object --region "${BACKUP_REPLICA_REGION}" --bucket "${BACKUP_REPLICA_BUCKET}" --key "${key}" "${replica}" >/dev/null 2>&1; then
      replica_id="$(jq -r '.canary_id // empty' "${replica}")"
    fi
    if [[ -n "${source_id}" && "${source_id}" == "${replica_id}" ]]; then
      lag=0
      publish_next=1
    elif [[ -n "${source_id}" ]] && lag="$(age_seconds "${generated_at}" 2>/dev/null)"; then
      [[ "${lag}" -ge 0 ]] || lag=0
    fi
  else
    publish_next=1
  fi

  if [[ "${publish_next}" -eq 1 ]]; then
    jq -n \
      --arg canary_id "$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM" \
      --arg generated_at "$(date -u +%FT%TZ)" \
      --arg environment "${BACKUP_ENVIRONMENT}" \
      '{canary_version:1,canary_id:$canary_id,generated_at:$generated_at,environment:$environment}' >"${next}"
    upload_evidence_file "${next}" "${key}" replication-canary
  fi

  put_metric BackupReplicationLagSeconds "${lag}" Seconds
  printf '%s\n' "${lag}"
}

base_age="$(metric_for_latest_signed_base)"
logical_age="$(metric_for_latest LogicalBackupAgeSeconds "${BACKUP_BUCKET}" "postgres/${BACKUP_ENVIRONMENT}/health/logical-backup/" "${AWS_REGION}")"
wal_age="$(metric_for_postgres_archiver)"
restore_age="$(metric_for_latest_signed_restore_success)"
replication_lag="$(metric_for_replication_canary)"
put_metric BackupMonitorSuccess 1 None

log "backup ages: base=${base_age}s logical=${logical_age}s wal=${wal_age}s restore-verification=${restore_age}s replication=${replication_lag}s"
