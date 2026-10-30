#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail
source /usr/local/lib/postwave-backup/common.sh

for name in BACKUP_BUCKET BACKUP_KMS_KEY_ID BACKUP_EVIDENCE_SIGNING_KEY_ID AWS_REGION BACKUP_ENVIRONMENT; do
  require_env "${name}"
done
for command_name in aws jq openssl; do
  require_command "${command_name}"
done

workdir="$(mktemp -d)"
catalog="${workdir}/catalog.json"
signed_count=0
max_backlog="${MAX_UNSIGNED_BASE_EVIDENCE_BACKLOG:-64}"
[[ "${max_backlog}" =~ ^[1-9][0-9]*$ && "${max_backlog}" -le 256 ]] || fail "MAX_UNSIGNED_BASE_EVIDENCE_BACKLOG must be an integer from 1 through 256"

cleanup() {
  local status=$?
  rm -rf "${workdir}"
  if [[ "${status}" -ne 0 ]]; then
    put_metric_best_effort EvidenceSignerSuccess 0 None
  fi
  exit "${status}"
}
trap cleanup EXIT

download_verified_object() {
  local key="$1"
  local output="$2"
  local head_json encryption kms_key checksum checksum_type actual_checksum metadata_sha
  head_json="$(aws s3api head-object \
    --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${key}" --checksum-mode ENABLED)"
  aws s3api get-object \
    --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${key}" --checksum-mode ENABLED \
    "${output}" >/dev/null
  encryption="$(jq -r '.ServerSideEncryption // empty' <<<"${head_json}")"
  kms_key="$(jq -r '.SSEKMSKeyId // empty' <<<"${head_json}")"
  checksum="$(jq -r '.ChecksumSHA256 // empty' <<<"${head_json}")"
  checksum_type="$(jq -r '.ChecksumType // "FULL_OBJECT"' <<<"${head_json}")"
  metadata_sha="$(jq -r '.Metadata.sha256 // empty' <<<"${head_json}")"
  actual_checksum="$(openssl dgst -sha256 -binary "${output}" | openssl base64 -A)"
  [[ "${encryption}" == "aws:kms" && "${kms_key}" == "${BACKUP_KMS_KEY_ID}" ]] || fail "${key} is not encrypted by the expected backup key"
  [[ "${checksum_type}" == "FULL_OBJECT" && "${checksum}" == "${actual_checksum}" ]] || fail "${key} lacks the expected full-object S3 checksum"
  [[ "${metadata_sha}" == "$(sha256_file "${output}")" ]] || fail "${key} full-object digest metadata does not match"
}

validate_manifest() {
  local path="$1"
  local backup_name="$2"
  jq -e --arg environment "${BACKUP_ENVIRONMENT}" --arg backup_name "${backup_name}" '
    .manifest_version == 2 and
    .kind == "postgres_walg_base_backup" and
    .environment == $environment and
    .page_checksums_verified == true and
    ((.latest_backup.backup_name // .latest_backup.BackupName // .latest_backup.name) == $backup_name) and
    (.postgres_system_identifier | type == "string" and test("^[0-9]{10,20}$")) and
    (.completed_at | type == "string" and length > 0) and
    .wal_integrity.integrity.status == "OK" and
    .wal_integrity.timeline.status == "OK"
  ' "${path}" >/dev/null
}

verify_manifest_signature() {
  local manifest_path="$1"
  local signature_path="$2"
  local digest="${workdir}/manifest.digest"
  local signature_binary="${workdir}/manifest.signature"
  local manifest_sha signature_sha signature_key algorithm message_type signature_base64
  manifest_sha="$(sha256_file "${manifest_path}")"
  signature_sha="$(jq -r '.sha256 // empty' "${signature_path}")"
  signature_key="$(jq -r '.key_id // empty' "${signature_path}")"
  algorithm="$(jq -r '.algorithm // empty' "${signature_path}")"
  message_type="$(jq -r '.message_type // empty' "${signature_path}")"
  signature_base64="$(jq -r '.signature_base64 // empty' "${signature_path}")"
  [[ "${signature_sha}" == "${manifest_sha}" ]] || return 1
  [[ "${signature_key}" == "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" ]] || return 1
  [[ "${algorithm}" == "RSASSA_PSS_SHA_256" && "${message_type}" == "DIGEST" ]] || return 1
  openssl dgst -sha256 -binary -out "${digest}" "${manifest_path}" || return 1
  printf '%s' "${signature_base64}" | openssl base64 -d -A -out "${signature_binary}" || return 1
  aws kms verify \
    --region "${AWS_REGION}" \
    --key-id "${signature_key}" \
    --message-type DIGEST \
    --signing-algorithm "${algorithm}" \
    --message "fileb://${digest}" \
    --signature "fileb://${signature_binary}" \
    --query SignatureValid --output text | grep -qx 'True'
}

prefix="postgres/${BACKUP_ENVIRONMENT}/evidence/base-backups/"
aws s3api list-objects-v2 --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --prefix "${prefix}" --output json >"${catalog}"
mapfile -t manifests < <(jq -r --argjson max "${max_backlog}" '
  [.Contents[]? | select(.Key | endswith("/manifest.json"))]
  | sort_by(.LastModified) | .[-$max:] | .[].Key
' "${catalog}")
[[ "${#manifests[@]}" -gt 0 ]] || fail "no base-backup evidence manifests exist to attest"

for key in "${manifests[@]}"; do
  signature_key="${key}.sig.json"
  if aws s3api head-object --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${signature_key}" >/dev/null 2>&1; then
    continue
  fi

  manifest="${workdir}/manifest.json"
  checksum_file="${workdir}/manifest.json.sha256"
  signature="${workdir}/manifest.json.sig.json"
  download_verified_object "${key}" "${manifest}"
  download_verified_object "${key}.sha256" "${checksum_file}"
  expected_sha="$(awk 'NR == 1 {print $1}' "${checksum_file}")"
  [[ "${expected_sha}" =~ ^[a-f0-9]{64}$ && "${expected_sha}" == "$(sha256_file "${manifest}")" ]] || fail "${key} checksum sidecar is invalid"
  backup_name="${key%/manifest.json}"
  backup_name="${backup_name##*/}"
  validate_manifest "${manifest}" "${backup_name}" || fail "${key} does not satisfy the base-backup evidence contract"

  sign_file "${manifest}" "${signature}"
  upload_evidence_file "${signature}" "${signature_key}" signature
  signed_count="$(( signed_count + 1 ))"
done

# Base-backup age is derived only from this signer-owned copy of the newest
# manifest. Validate the exact source checksum and KMS signature even when no
# new signature was needed during this run.
latest_key="${manifests[${#manifests[@]} - 1]}"
latest_backup_name="${latest_key%/manifest.json}"
latest_backup_name="${latest_backup_name##*/}"
manifest="${workdir}/manifest.json"
checksum_file="${workdir}/manifest.json.sha256"
signature="${workdir}/manifest.json.sig.json"
download_verified_object "${latest_key}" "${manifest}"
download_verified_object "${latest_key}.sha256" "${checksum_file}"
download_verified_object "${latest_key}.sig.json" "${signature}"
expected_sha="$(awk 'NR == 1 {print $1}' "${checksum_file}")"
[[ "${expected_sha}" =~ ^[a-f0-9]{64}$ && "${expected_sha}" == "$(sha256_file "${manifest}")" ]] || fail "${latest_key} checksum sidecar is invalid"
validate_manifest "${manifest}" "${latest_backup_name}" || fail "${latest_key} does not satisfy the base-backup evidence contract"
verify_manifest_signature "${manifest}" "${signature}" || fail "${latest_key} has no valid evidence signature"
upload_evidence_file "${manifest}" "postgres/${BACKUP_ENVIRONMENT}/health/base-backup-signed/latest.json" signed-heartbeat

put_metric EvidenceSignerSuccess 1 None
put_metric BaseBackupEvidenceSignatures "${signed_count}" Count
log "independent evidence signer completed; new base-backup signatures=${signed_count}"
