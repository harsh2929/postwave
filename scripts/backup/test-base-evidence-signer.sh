#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${LOCAL_BACKUP_IMAGE:-postwave-backup:local-test}"
WORKDIR="$(mktemp -d -t postwave-base-signer.XXXXXX)"
trap 'rm -rf "${WORKDIR}"' EXIT

BACKUP_NAME="base_000000010000000000000001"
MANIFEST_KEY="postgres/test/evidence/base-backups/${BACKUP_NAME}/manifest.json"
KMS_KEY="arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111"
STORE="${WORKDIR}/store"
MANIFEST="${STORE}/${MANIFEST_KEY}"
mkdir -p "$(dirname "${MANIFEST}")"
jq -n \
  --arg backup_name "${BACKUP_NAME}" \
  '{manifest_version:2,kind:"postgres_walg_base_backup",environment:"test",completed_at:"2026-07-14T10:00:00Z",page_checksums_verified:true,postgres_system_identifier:"7412345678901234567",latest_backup:{backup_name:$backup_name},wal_integrity:{integrity:{status:"OK"},timeline:{status:"OK"}}}' \
  >"${MANIFEST}"
printf '%s  manifest.json\n' "$(openssl dgst -sha256 "${MANIFEST}" | awk '{print $2}')" \
  >"${MANIFEST}.sha256"
chmod -R a+rwX "${WORKDIR}"

run_signer() {
  docker run --rm --user 999:999 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,uid=999,gid=999 \
    --mount "type=bind,src=${WORKDIR},dst=/mock-store" \
    --mount "type=bind,src=${SCRIPT_DIR}/test-base-evidence-signer-aws.sh,dst=/mock/aws,readonly" \
    --env PATH=/mock:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --env MOCK_S3_ROOT=/mock-store/store \
    --env MOCK_AWS_LOG=/mock-store/aws.log \
    --env "MOCK_MANIFEST_KEY=${MANIFEST_KEY}" \
    --env "MOCK_KMS_KEY_ARN=${KMS_KEY}" \
    --env BACKUP_BUCKET=test-backup-bucket \
    --env "BACKUP_KMS_KEY_ID=${KMS_KEY}" \
    --env "BACKUP_EVIDENCE_SIGNING_KEY_ID=${KMS_KEY}" \
    --env AWS_REGION=us-west-2 \
    --env BACKUP_ENVIRONMENT=test \
    --entrypoint /bin/bash \
    "${IMAGE}" /usr/local/bin/postwave-sign-base-backup-evidence
}

run_signer >"${WORKDIR}/pass.out"
SIGNATURE="${MANIFEST}.sig.json"
SIGNED_HEALTH="${STORE}/postgres/test/health/base-backup-signed/latest.json"
[[ -s "${SIGNATURE}" && -s "${SIGNED_HEALTH}" ]]
cmp "${MANIFEST}" "${SIGNED_HEALTH}"
grep -q 'new base-backup signatures=1' "${WORKDIR}/pass.out"

# An existing malformed signature must fail closed and never refresh signed
# health, instead of being silently skipped as already complete.
health_sha="$(openssl dgst -sha256 "${SIGNED_HEALTH}" | awk '{print $2}')"
health_uploads_before="$(grep -c 'health/base-backup-signed/latest.json' "${WORKDIR}/aws.log")"
jq '.sha256 = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "${SIGNATURE}" >"${WORKDIR}/bad-signature.json"
mv "${WORKDIR}/bad-signature.json" "${SIGNATURE}"
if run_signer >"${WORKDIR}/invalid.out" 2>"${WORKDIR}/invalid.err"; then
  echo "base evidence signer accepted an invalid existing signature" >&2
  exit 1
fi
grep -q 'has no valid evidence signature' "${WORKDIR}/invalid.err"
[[ "$(openssl dgst -sha256 "${SIGNED_HEALTH}" | awk '{print $2}')" == "${health_sha}" ]]
[[ "$(grep -c 'health/base-backup-signed/latest.json' "${WORKDIR}/aws.log")" == "${health_uploads_before}" ]]

printf 'base-backup evidence signer tests passed\n'
