#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Create and verify an off-host PostgreSQL logical backup for self-hosted AWS S3.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -gt 0 ]]; then
  case "$1" in
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "this scheduled wrapper accepts no arguments; configure it with environment variables" >&2; exit 64 ;;
  esac
fi
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE must point to a one-line database URL secret}"
: "${SELF_HOST_BACKUP_BUCKET:?SELF_HOST_BACKUP_BUCKET must be set}"
: "${SELF_HOST_BACKUP_KMS_KEY_ID:?SELF_HOST_BACKUP_KMS_KEY_ID must be set}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
: "${AWS_REGION:?AWS_REGION or AWS_DEFAULT_REGION must be set}"

SELF_HOST_BACKUP_ENVIRONMENT="${SELF_HOST_BACKUP_ENVIRONMENT:-self-hosted}"
SELF_HOST_BACKUP_LOCAL_ROOT="${SELF_HOST_BACKUP_LOCAL_ROOT:-/var/backups/postwave}"
SELF_HOST_BACKUP_PREFIX="${SELF_HOST_BACKUP_PREFIX:-postgres/${SELF_HOST_BACKUP_ENVIRONMENT}}"
MIN_BACKUP_BYTES="${MIN_BACKUP_BYTES:-1024}"

fail() {
  printf '[%s] ERROR: %s\n' "$(date -u +%FT%TZ)" "$*" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

for command_name in aws jq openssl flock; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command not found: ${command_name}"
done
aws s3 cp "$0" s3://postwave-capability-check/object --checksum-algorithm SHA256 --dryrun >/dev/null 2>&1 || fail "AWS CLI is too old for checksum-aware uploads"
[[ -r "${DATABASE_URL_FILE}" && -f "${DATABASE_URL_FILE}" ]] || fail "DATABASE_URL_FILE is not a readable regular file"
[[ "${SELF_HOST_BACKUP_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ && "${SELF_HOST_BACKUP_BUCKET}" != *..* ]] || fail "invalid SELF_HOST_BACKUP_BUCKET"
[[ "${AWS_REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || fail "invalid AWS_REGION"
PARTITION='aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b'
[[ "${SELF_HOST_BACKUP_KMS_KEY_ID}" =~ ^arn:(${PARTITION}):kms:([a-z0-9-]+):[0-9]{12}:key/(mrk-)?[A-Za-z0-9-]+$ ]] || fail "SELF_HOST_BACKUP_KMS_KEY_ID must be a KMS key ARN"
[[ "${BASH_REMATCH[2]}" == "${AWS_REGION}" ]] || fail "SELF_HOST_BACKUP_KMS_KEY_ID must be in AWS_REGION"
[[ "${SELF_HOST_BACKUP_ENVIRONMENT}" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || fail "invalid SELF_HOST_BACKUP_ENVIRONMENT"
PREFIX_PATTERN="^[A-Za-z0-9!_.*'()/=-]+$"
[[ "${SELF_HOST_BACKUP_PREFIX}" =~ ${PREFIX_PATTERN} && "${SELF_HOST_BACKUP_PREFIX}" != /* && "${SELF_HOST_BACKUP_PREFIX}" != *..* ]] || fail "invalid SELF_HOST_BACKUP_PREFIX"
[[ "${MIN_BACKUP_BYTES}" =~ ^[1-9][0-9]*$ ]] || fail "MIN_BACKUP_BYTES must be a positive integer"

DATABASE_URL="$(<"${DATABASE_URL_FILE}")"
[[ -n "${DATABASE_URL}" && "${DATABASE_URL}" != *$'\n'* && "${DATABASE_URL}" != *$'\r'* ]] || fail "DATABASE_URL_FILE must contain exactly one non-empty line"

umask 077
[[ ! -L "${SELF_HOST_BACKUP_LOCAL_ROOT}" ]] || fail "SELF_HOST_BACKUP_LOCAL_ROOT must not be a symlink"
mkdir -p "${SELF_HOST_BACKUP_LOCAL_ROOT}"
chmod 0700 "${SELF_HOST_BACKUP_LOCAL_ROOT}"
LOCK_PATH="${SELF_HOST_BACKUP_LOCAL_ROOT}/.backup.lock"
[[ ! -L "${LOCK_PATH}" && ( ! -e "${LOCK_PATH}" || -f "${LOCK_PATH}" ) ]] || fail "backup lock path must be a regular file and not a symlink"
exec 9>"${LOCK_PATH}"
flock -n 9 || fail "another self-hosted backup is already running"

RUN_DATE="$(date -u +%Y/%m/%d)"
STAGING_ROOT="${SELF_HOST_BACKUP_LOCAL_ROOT}/staging"
[[ ! -L "${STAGING_ROOT}" && ( ! -e "${STAGING_ROOT}" || -d "${STAGING_ROOT}" ) ]] || fail "backup staging path must be a directory and not a symlink"
mkdir -p "${STAGING_ROOT}"
chmod 0700 "${STAGING_ROOT}"
OUTPUT_DIR="$(mktemp -d "${STAGING_ROOT}/run-${RUN_DATE//\//-}.XXXXXX")"
cleanup() {
  unset DATABASE_URL
  rm -rf -- "${OUTPUT_DIR}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

log "creating validated logical backup"
BACKUP_OUTPUT="$(DATABASE_URL="${DATABASE_URL}" \
  "${SCRIPT_DIR}/create-postgres-backup.sh" \
    --output-dir "${OUTPUT_DIR}" \
    --env "${SELF_HOST_BACKUP_ENVIRONMENT}" \
    --label scheduled \
    --min-bytes "${MIN_BACKUP_BYTES}")"
unset DATABASE_URL

DUMP_PATH="$(awk -F= '$1 == "BACKUP_DUMP" {print substr($0, index($0, "=") + 1)}' <<<"${BACKUP_OUTPUT}")"
SHA_PATH="$(awk -F= '$1 == "BACKUP_SHA256" {print substr($0, index($0, "=") + 1)}' <<<"${BACKUP_OUTPUT}")"
MANIFEST_PATH="$(awk -F= '$1 == "BACKUP_MANIFEST" {print substr($0, index($0, "=") + 1)}' <<<"${BACKUP_OUTPUT}")"

for path in "${DUMP_PATH}" "${SHA_PATH}" "${MANIFEST_PATH}"; do
  [[ -n "${path}" && -f "${path}" && "${path}" == "${OUTPUT_DIR}/"* ]] || fail "backup producer returned an invalid artifact path"
done

upload_and_verify() {
  local path="$1"
  local key
  local head_json encryption kms_key stored_checksum actual_sha stored_sha version_id

  key="${SELF_HOST_BACKUP_PREFIX}/${RUN_DATE}/$(basename "${path}")"

  actual_sha="$(openssl dgst -sha256 "${path}" | awk '{print $NF}')"
  aws s3 cp "${path}" "s3://${SELF_HOST_BACKUP_BUCKET}/${key}" \
    --region "${AWS_REGION}" \
    --sse aws:kms \
    --sse-kms-key-id "${SELF_HOST_BACKUP_KMS_KEY_ID}" \
    --checksum-algorithm SHA256 \
    --metadata "environment=${SELF_HOST_BACKUP_ENVIRONMENT},kind=self-hosted-logical-backup,sha256=${actual_sha}" \
    --only-show-errors

  head_json="$(aws s3api head-object \
    --region "${AWS_REGION}" \
    --bucket "${SELF_HOST_BACKUP_BUCKET}" \
    --key "${key}" \
    --checksum-mode ENABLED)"
  encryption="$(jq -r '.ServerSideEncryption // empty' <<<"${head_json}")"
  kms_key="$(jq -r '.SSEKMSKeyId // empty' <<<"${head_json}")"
  stored_checksum="$(jq -r '.ChecksumSHA256 // empty' <<<"${head_json}")"
  stored_sha="$(jq -r '.Metadata.sha256 // empty' <<<"${head_json}")"
  version_id="$(jq -r '.VersionId // "unversioned"' <<<"${head_json}")"

  [[ "${encryption}" == "aws:kms" ]] || fail "uploaded object is not protected with SSE-KMS: ${key}"
  [[ "${kms_key}" == "${SELF_HOST_BACKUP_KMS_KEY_ID}" ]] || fail "uploaded object uses an unexpected KMS key: ${key}"
  [[ -n "${stored_checksum}" ]] || fail "uploaded object has no S3 SHA-256 checksum: ${key}"
  [[ "${stored_sha}" == "${actual_sha}" ]] || fail "uploaded object full SHA-256 metadata mismatch: ${key}"
  [[ -n "${version_id}" && "${version_id}" != "null" && "${version_id}" != "unversioned" ]] || fail "backup bucket versioning is not enabled: ${key}"
  log "verified s3://${SELF_HOST_BACKUP_BUCKET}/${key} version=${version_id}"
}

upload_and_verify "${DUMP_PATH}"
upload_and_verify "${SHA_PATH}"
upload_and_verify "${MANIFEST_PATH}"

log "self-hosted PostgreSQL backup completed and plaintext staging artifacts will now be removed"
