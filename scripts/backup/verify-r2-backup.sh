#!/usr/bin/env bash
# verify-r2-backup.sh
#
# Sanity-checks a Cloudflare R2 backup bucket:
#   * lists object count and compares to the prior baseline,
#   * HEADs 10 random objects to confirm reachability,
#   * reports pass/fail.
#
# Requires the AWS CLI configured against your R2 endpoint (R2 is
# S3-compatible). Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in
# the environment, or explicitly select a least-privilege profile with
# R2_AWS_PROFILE. Ambient/default AWS credentials are never used.
#
# Usage:
#   ./verify-r2-backup.sh <bucket>

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <bucket>" >&2
  exit 64
fi
BUCKET="$1"
ENDPOINT="${R2_ENDPOINT:?R2_ENDPOINT required (https://<account>.r2.cloudflarestorage.com)}"
BASELINE_FILE="${BASELINE_FILE:-/var/lib/postwave/backup-baselines/${BUCKET}.count}"

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { printf '[%s] FAIL: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

[[ "${BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ && "${BUCKET}" != *..* ]] || fail "invalid R2 bucket name"
ENDPOINT="${ENDPOINT%/}"
[[ "${ENDPOINT}" =~ ^https://[a-f0-9]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$ ]] || \
  fail "R2_ENDPOINT must be the account's HTTPS Cloudflare R2 S3 endpoint"
[[ "${BASELINE_FILE}" == /* ]] || fail "BASELINE_FILE must be an absolute path"

for command_name in aws jq openssl python3; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command not found: ${command_name}"
done
if [[ -n "${R2_ACCESS_KEY_ID:-}" || -n "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  [[ -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" ]] || fail "both R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required"
  unset AWS_PROFILE AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
  export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
  export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
elif [[ -n "${R2_AWS_PROFILE:-}" ]]; then
  [[ "${R2_AWS_PROFILE}" =~ ^[A-Za-z0-9_+=,.@-]{1,128}$ ]] || fail "invalid R2_AWS_PROFILE"
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
  export AWS_PROFILE="${R2_AWS_PROFILE}"
else
  fail "dedicated R2 credentials or R2_AWS_PROFILE are required; ambient AWS credentials are refused"
fi
export AWS_DEFAULT_REGION="${R2_REGION:-auto}"
export AWS_EC2_METADATA_DISABLED=true

s3api() { aws --endpoint-url "${ENDPOINT}" s3api "$@"; }

# Inventory. JSON/base64 keeps spaces and control characters in object keys
# from becoming shell syntax or ambiguous `aws s3 ls` columns.
log "listing bucket ${BUCKET}"
LIST_FILE="$(mktemp -t postwave-r2-list.XXXXXX)"
trap 'rm -f "${LIST_FILE}"' EXIT
s3api list-objects-v2 --bucket "${BUCKET}" --output json >"${LIST_FILE}"
COUNT="$(jq '[.Contents[]?] | length' "${LIST_FILE}")"
[[ "${COUNT}" =~ ^[0-9]+$ && "${COUNT}" -gt 0 ]] || fail "R2 backup inventory is empty or invalid"
log "objects: ${COUNT}"

# Compare against baseline (a flat file containing the previous count).
baseline_dir="$(dirname "${BASELINE_FILE}")"
[[ ! -L "${baseline_dir}" && ! -L "${BASELINE_FILE}" ]] || fail "baseline path must not contain a terminal symlink"
if [[ -f "${BASELINE_FILE}" ]]; then
  PREV="$(<"${BASELINE_FILE}")"
  [[ "${PREV}" =~ ^[0-9]+$ ]] || fail "baseline count is invalid"
  DELTA=$(( COUNT - PREV ))
  log "baseline: ${PREV}, delta: ${DELTA}"
  # Alert on >5% shrinkage; growth is expected.
  if (( COUNT * 100 < PREV * 95 )); then
    fail "object count dropped >5% (was ${PREV}, now ${COUNT})"
  fi
fi

# Random HEAD sample.
log "HEAD-checking 10 random objects"
SAMPLE_KEYS="$(python3 - "${LIST_FILE}" <<'PY'
import base64
import json
from pathlib import Path
import secrets
import sys

contents = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")).get("Contents", [])
for item in secrets.SystemRandom().sample(contents, min(10, len(contents))):
    print(base64.b64encode(item["Key"].encode("utf-8")).decode("ascii"))
PY
)"
FAILED=0
SAMPLED=0
while IFS= read -r encoded_key; do
  [[ -z "${encoded_key}" ]] && continue
  key="$(printf '%s' "${encoded_key}" | openssl base64 -d -A)" || fail "could not decode sampled R2 object key"
  SAMPLED=$((SAMPLED + 1))
  if ! s3api head-object --bucket "${BUCKET}" --key "${key}" >/dev/null 2>&1; then
    log "HEAD failed: ${key}"
    FAILED=$((FAILED + 1))
  fi
done <<<"${SAMPLE_KEYS}"

if (( FAILED > 0 )); then
  fail "${FAILED}/${SAMPLED} sample HEADs failed"
fi
[[ "${SAMPLED}" -gt 0 ]] || fail "no R2 objects were sampled"

# Advance the baseline only after the inventory and reachability checks pass.
[[ ! -e "${baseline_dir}" || -d "${baseline_dir}" ]] || fail "baseline parent is not a directory"
if [[ ! -e "${baseline_dir}" ]]; then
  mkdir -p "${baseline_dir}"
  chmod 0700 "${baseline_dir}"
fi
baseline_tmp="$(mktemp "${baseline_dir}/.count.XXXXXX")"
printf '%s\n' "${COUNT}" >"${baseline_tmp}"
chmod 0600 "${baseline_tmp}"
mv -f "${baseline_tmp}" "${BASELINE_FILE}"
log "OK: r2 backup ${BUCKET} verified"
