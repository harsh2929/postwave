#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "required environment variable is empty: ${name}"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

epoch_seconds() {
  date -u -d "$1" +%s
}

age_seconds() {
  local timestamp="$1"
  local then_epoch
  then_epoch="$(epoch_seconds "${timestamp}")"
  printf '%s\n' "$(( $(date -u +%s) - then_epoch ))"
}

put_metric() {
  local name="$1"
  local value="$2"
  local unit="${3:-None}"

  aws cloudwatch put-metric-data \
    --region "${AWS_REGION}" \
    --namespace "${BACKUP_METRIC_NAMESPACE:-Postwave/Backup}" \
    --metric-data \
      "MetricName=${name},Value=${value},Unit=${unit},Dimensions=[{Name=Environment,Value=${BACKUP_ENVIRONMENT}}]"
}

put_metric_best_effort() {
  put_metric "$@" >/dev/null 2>&1 || true
}

sign_file() {
  local input="$1"
  local output="$2"
  local digest_file
  local signature

  require_env BACKUP_EVIDENCE_SIGNING_KEY_ID
  digest_file="$(mktemp)"
  openssl dgst -sha256 -binary -out "${digest_file}" "${input}"
  signature="$(aws kms sign \
    --region "${AWS_REGION}" \
    --key-id "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" \
    --message-type DIGEST \
    --signing-algorithm RSASSA_PSS_SHA_256 \
    --message "fileb://${digest_file}" \
    --query Signature \
    --output text)"
  rm -f "${digest_file}"

  jq -n \
    --arg signed_at "$(date -u +%FT%TZ)" \
    --arg key_id "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" \
    --arg algorithm "RSASSA_PSS_SHA_256" \
    --arg sha256 "$(sha256_file "${input}")" \
    --arg signature_base64 "${signature}" \
    '{
      signature_version: 1,
      signed_at: $signed_at,
      key_id: $key_id,
      algorithm: $algorithm,
      message_type: "DIGEST",
      sha256: $sha256,
      signature_base64: $signature_base64
    }' >"${output}"
}

upload_evidence_file() {
  local path="$1"
  local key="$2"
  local kind="$3"
  local local_sha
  local stored_sha
  local head_json
  local object_lock_mode
  local object_lock_until

  local_sha="$(sha256_file "${path}")"
  if [[ "${key}" == "postgres/${BACKUP_ENVIRONMENT}/evidence/"* ]]; then
    object_lock_until="$(date -u -d '+2555 days' +%FT%TZ)"
    aws s3api put-object \
      --region "${AWS_REGION}" \
      --bucket "${BACKUP_BUCKET}" \
      --key "${key}" \
      --body "${path}" \
      --server-side-encryption aws:kms \
      --ssekms-key-id "${BACKUP_KMS_KEY_ID}" \
      --checksum-algorithm SHA256 \
      --object-lock-mode GOVERNANCE \
      --object-lock-retain-until-date "${object_lock_until}" \
      --metadata "environment=${BACKUP_ENVIRONMENT},kind=${kind},sha256=${local_sha}" >/dev/null
  else
    aws s3 cp "${path}" "s3://${BACKUP_BUCKET}/${key}" \
      --region "${AWS_REGION}" \
      --sse aws:kms \
      --sse-kms-key-id "${BACKUP_KMS_KEY_ID}" \
      --checksum-algorithm SHA256 \
      --metadata "environment=${BACKUP_ENVIRONMENT},kind=${kind},sha256=${local_sha}" \
      --only-show-errors
  fi

  local encryption
  local kms_key
  local checksum
  head_json="$(aws s3api head-object \
    --region "${AWS_REGION}" \
    --checksum-mode ENABLED \
    --bucket "${BACKUP_BUCKET}" \
    --key "${key}")"
  encryption="$(jq -r '.ServerSideEncryption // empty' <<<"${head_json}")"
  kms_key="$(jq -r '.SSEKMSKeyId // empty' <<<"${head_json}")"
  checksum="$(jq -r '.ChecksumSHA256 // empty' <<<"${head_json}")"
  stored_sha="$(jq -r '.Metadata.sha256 // empty' <<<"${head_json}")"
  [[ "${encryption}" == "aws:kms" ]] || fail "${key} was not stored with SSE-KMS"
  [[ "${kms_key}" == "${BACKUP_KMS_KEY_ID}" ]] || fail "${key} was not stored with the expected KMS key"
  [[ -n "${checksum}" ]] || fail "${key} has no S3 checksum"
  [[ "${stored_sha}" == "${local_sha}" ]] || fail "${key} is missing its expected full-object SHA-256 metadata"
  if [[ "${key}" == "postgres/${BACKUP_ENVIRONMENT}/evidence/"* ]]; then
    object_lock_mode="$(jq -r '.ObjectLockMode // empty' <<<"${head_json}")"
    object_lock_until="$(jq -r '.ObjectLockRetainUntilDate // empty' <<<"${head_json}")"
    [[ "${object_lock_mode}" == "GOVERNANCE" && -n "${object_lock_until}" ]] || fail "${key} is missing its evidence Object Lock retention"
  fi
}

latest_s3_timestamp() {
  local bucket="$1"
  local prefix="$2"
  local region="$3"

  aws s3api list-objects-v2 \
    --region "${region}" \
    --bucket "${bucket}" \
    --prefix "${prefix}" \
    --query 'reverse(sort_by(Contents,&LastModified))[0].LastModified' \
    --output text
}
