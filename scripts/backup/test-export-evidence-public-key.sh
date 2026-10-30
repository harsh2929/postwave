#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/export-evidence-public-key.sh"
WORKDIR="$(mktemp -d -t postwave-key-export.XXXXXX)"
trap 'rm -rf "${WORKDIR}"' EXIT

KEY_ARN="arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "${WORKDIR}/private.pem" >/dev/null 2>&1
openssl pkey -in "${WORKDIR}/private.pem" -pubout -outform DER \
  -out "${WORKDIR}/public.der"
MOCK_PUBLIC_KEY="$(openssl base64 -A -in "${WORKDIR}/public.der")"
export MOCK_PUBLIC_KEY
export MOCK_KEY_ARN="${KEY_ARN}"
export MOCK_KEY_SPEC="RSA_3072"

aws() {
  jq -n \
    --arg key "${MOCK_KEY_ARN}" \
    --arg public "${MOCK_PUBLIC_KEY}" \
    --arg key_spec "${MOCK_KEY_SPEC}" \
    '{KeyId:$key,KeyUsage:"SIGN_VERIFY",KeySpec:$key_spec,SigningAlgorithms:["RSASSA_PSS_SHA_256"],PublicKey:$public}'
}
export -f aws

"${SUBJECT}" --key-id "${KEY_ARN}" --region us-west-2 \
  --output "${WORKDIR}/export.pem" >"${WORKDIR}/result"
for path in "${WORKDIR}/export.pem" "${WORKDIR}/export.pem.der" "${WORKDIR}/export.pem.der.sha256"; do
  [[ -s "${path}" ]]
done
fingerprint="$(openssl dgst -sha256 "${WORKDIR}/export.pem.der" | awk '{print $2}')"
[[ "$(awk 'NR == 1 {print $1}' "${WORKDIR}/export.pem.der.sha256")" == "${fingerprint}" ]]
grep -q "BACKUP_EVIDENCE_PUBLIC_KEY_SHA256=${fingerprint}" "${WORKDIR}/result"
openssl pkey -pubin -in "${WORKDIR}/export.pem" -noout

# An invalid KMS contract must leave no plausible partial recovery kit behind.
export MOCK_KEY_SPEC="RSA_2048"
if "${SUBJECT}" --key-id "${KEY_ARN}" --region us-west-2 \
    --output "${WORKDIR}/invalid.pem" >"${WORKDIR}/invalid.out" 2>"${WORKDIR}/invalid.err"; then
  echo "evidence-key exporter accepted an invalid KMS key contract" >&2
  exit 1
fi
for path in "${WORKDIR}/invalid.pem" "${WORKDIR}/invalid.pem.der" "${WORKDIR}/invalid.pem.der.sha256"; do
  [[ ! -e "${path}" ]]
done

printf 'offline evidence public-key export tests passed\n'
