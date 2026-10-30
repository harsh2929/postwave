#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Minimal AWS CLI double used only by test-base-evidence-signer.sh.

set -euo pipefail
: "${MOCK_S3_ROOT:?}"
: "${MOCK_MANIFEST_KEY:?}"
: "${MOCK_KMS_KEY_ARN:?}"
if [[ -n "${MOCK_AWS_LOG:-}" ]]; then
  printf '%q ' "$@" >>"${MOCK_AWS_LOG}"
  printf '\n' >>"${MOCK_AWS_LOG}"
fi

option_value() {
  local wanted="$1"
  shift
  while [[ $# -gt 1 ]]; do
    if [[ "$1" == "${wanted}" ]]; then
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

object_path() {
  printf '%s/%s\n' "${MOCK_S3_ROOT}" "$1"
}

head_object() {
  local key="$1"
  local path sha checksum
  path="$(object_path "${key}")"
  [[ -f "${path}" ]] || return 255
  sha="$(openssl dgst -sha256 "${path}" | awk '{print $2}')"
  checksum="$(openssl dgst -sha256 -binary "${path}" | openssl base64 -A)"
  jq -n \
    --arg kms "${MOCK_KMS_KEY_ARN}" \
    --arg sha "${sha}" \
    --arg checksum "${checksum}" \
    '{ServerSideEncryption:"aws:kms",SSEKMSKeyId:$kms,ChecksumSHA256:$checksum,ChecksumType:"FULL_OBJECT",Metadata:{sha256:$sha},ObjectLockMode:"GOVERNANCE",ObjectLockRetainUntilDate:"2033-07-14T00:00:00Z",VersionId:"test-version"}'
}

case "${1:-} ${2:-}" in
  "s3api list-objects-v2")
    jq -n --arg key "${MOCK_MANIFEST_KEY}" \
      '{Contents:[{Key:$key,LastModified:"2026-07-14T10:00:00Z"}]}'
    ;;
  "s3api head-object")
    key="$(option_value --key "$@")"
    head_object "${key}"
    ;;
  "s3api get-object")
    key="$(option_value --key "$@")"
    output="${!#}"
    cp "$(object_path "${key}")" "${output}"
    jq -n '{VersionId:"test-version"}'
    ;;
  "s3api put-object")
    key="$(option_value --key "$@")"
    body="$(option_value --body "$@")"
    path="$(object_path "${key}")"
    mkdir -p "$(dirname "${path}")"
    cp "${body}" "${path}"
    jq -n '{VersionId:"test-version"}'
    ;;
  "s3 cp")
    source_path="$3"
    destination="$4"
    without_scheme="${destination#s3://}"
    key="${without_scheme#*/}"
    path="$(object_path "${key}")"
    mkdir -p "$(dirname "${path}")"
    cp "${source_path}" "${path}"
    ;;
  "kms sign")
    printf 'dGVzdC1zaWduYXR1cmU=\n'
    ;;
  "kms verify")
    printf 'True\n'
    ;;
  "cloudwatch put-metric-data")
    ;;
  *)
    printf 'unexpected mock AWS invocation: %q ' "$@" >&2
    printf '\n' >&2
    exit 70
    ;;
esac
