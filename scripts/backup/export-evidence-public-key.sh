#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Export the non-secret KMS evidence-verification public key for independently
# controlled, out-of-region/offline recovery verification.

set -euo pipefail

KEY_ID=""
REGION=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-id) KEY_ID="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "${KEY_ID}" =~ ^arn:aws[a-zA-Z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$ ]] || { echo "--key-id must be an asymmetric KMS key ARN" >&2; exit 64; }
[[ "${REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || { echo "--region is invalid" >&2; exit 64; }
[[ -n "${OUTPUT}" && "${OUTPUT}" != -* ]] || { echo "--output is required" >&2; exit 64; }
for output_path in "${OUTPUT}" "${OUTPUT}.der" "${OUTPUT}.der.sha256"; do
  [[ ! -e "${output_path}" && ! -L "${output_path}" ]] || { echo "refusing to overwrite evidence public-key material" >&2; exit 1; }
done
for command_name in aws jq openssl; do
  command -v "${command_name}" >/dev/null 2>&1 || { echo "required command not found: ${command_name}" >&2; exit 69; }
done

umask 077
workdir="$(mktemp -d -t postwave-evidence-key.XXXXXX)"
export_complete=0
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf "${workdir}"
  if [[ "${export_complete}" != "1" ]]; then
    rm -f "${OUTPUT}" "${OUTPUT}.der" "${OUTPUT}.der.sha256"
  fi
  exit "${status}"
}
trap cleanup EXIT

aws kms get-public-key --region "${REGION}" --key-id "${KEY_ID}" --output json >"${workdir}/key.json"
jq -e --arg key_id "${KEY_ID}" '
  .KeyId == $key_id and
  .KeyUsage == "SIGN_VERIFY" and
  .KeySpec == "RSA_3072" and
  (.SigningAlgorithms | index("RSASSA_PSS_SHA_256") != null)
' "${workdir}/key.json" >/dev/null || { echo "KMS key does not satisfy the evidence signing contract" >&2; exit 1; }
jq -r '.PublicKey' "${workdir}/key.json" | openssl base64 -d -A -out "${workdir}/key.der"
openssl pkey -pubin -inform DER -in "${workdir}/key.der" -out "${OUTPUT}"
fingerprint="$(openssl dgst -sha256 "${workdir}/key.der" | awk '{print $2}')"
cp "${workdir}/key.der" "${OUTPUT}.der"
printf '%s  %s\n' "${fingerprint}" "$(basename "${OUTPUT}.der")" >"${OUTPUT}.der.sha256"
(
  cd "$(dirname "${OUTPUT}")"
  openssl dgst -sha256 -r "$(basename "${OUTPUT}.der")" | awk '{print $1}' | grep -qx "${fingerprint}"
)
chmod 0444 "${OUTPUT}" "${OUTPUT}.der" "${OUTPUT}.der.sha256"
export_complete=1

printf 'BACKUP_EVIDENCE_PUBLIC_KEY_FILE=%s\n' "${OUTPUT}"
printf 'BACKUP_EVIDENCE_PUBLIC_KEY_SHA256=%s\n' "${fingerprint}"
printf 'Archive the PEM, DER, and DER checksum in an independently controlled out-of-region/offline recovery kit.\n'
