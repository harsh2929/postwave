#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/verify-r2-backup.sh"
WORKDIR="$(mktemp -d -t postwave-r2-verifier.XXXXXX)"
trap 'rm -rf "${WORKDIR}"' EXIT

aws() {
  [[ "${AWS_ACCESS_KEY_ID:-}" == "r2-test-id" ]] || return 77
  [[ "${AWS_SECRET_ACCESS_KEY:-}" == "r2-test-secret" ]] || return 77
  [[ "${AWS_DEFAULT_REGION:-}" == "auto" ]] || return 77
  if [[ "$*" == *list-objects-v2* ]]; then
    printf '%s\n' "${AWS_MOCK_LIST}"
  elif [[ "$*" == *head-object* ]]; then
    [[ "${AWS_MOCK_FAIL_HEAD:-0}" != "1" ]]
  else
    return 70
  fi
}
export -f aws

export R2_ENDPOINT="https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com"
export R2_ACCESS_KEY_ID="r2-test-id"
export R2_SECRET_ACCESS_KEY="r2-test-secret"
export BASELINE_FILE="${WORKDIR}/baseline/count"

export AWS_MOCK_LIST='{"Contents":[{"Key":"one file"},{"Key":"two"}]}'
"${SUBJECT}" test-bucket >"${WORKDIR}/pass.out"
[[ "$(<"${BASELINE_FILE}")" == "2" ]]

# A failed reachability sample must not bless the new inventory count.
export AWS_MOCK_LIST='{"Contents":[{"Key":"one"},{"Key":"two"},{"Key":"three"}]}'
export AWS_MOCK_FAIL_HEAD=1
if "${SUBJECT}" test-bucket >"${WORKDIR}/head-fail.out" 2>"${WORKDIR}/head-fail.err"; then
  echo "R2 verifier accepted a failed HEAD sample" >&2
  exit 1
fi
[[ "$(<"${BASELINE_FILE}")" == "2" ]]

# Empty storage is a failed backup check and likewise must not move baseline.
export AWS_MOCK_LIST='{"Contents":[]}'
export AWS_MOCK_FAIL_HEAD=0
if "${SUBJECT}" test-bucket >"${WORKDIR}/empty.out" 2>"${WORKDIR}/empty.err"; then
  echo "R2 verifier accepted an empty inventory" >&2
  exit 1
fi
grep -q "inventory is empty or invalid" "${WORKDIR}/empty.err"
[[ "$(<"${BASELINE_FILE}")" == "2" ]]

# Do not send R2 credentials to an arbitrary S3-compatible endpoint.
if R2_ENDPOINT="https://attacker.example" "${SUBJECT}" test-bucket \
    >"${WORKDIR}/endpoint.out" 2>"${WORKDIR}/endpoint.err"; then
  echo "R2 verifier accepted an untrusted endpoint" >&2
  exit 1
fi
grep -q "HTTPS Cloudflare R2 S3 endpoint" "${WORKDIR}/endpoint.err"

# Never fall through to an ambient/default AWS credential chain.
if env -u R2_ACCESS_KEY_ID -u R2_SECRET_ACCESS_KEY -u R2_AWS_PROFILE \
    R2_ENDPOINT="${R2_ENDPOINT}" BASELINE_FILE="${BASELINE_FILE}" \
    "${SUBJECT}" test-bucket >"${WORKDIR}/ambient.out" 2>"${WORKDIR}/ambient.err"; then
  echo "R2 verifier accepted ambient AWS credentials" >&2
  exit 1
fi
grep -q "ambient AWS credentials are refused" "${WORKDIR}/ambient.err"

printf 'R2 backup verifier tests passed\n'
