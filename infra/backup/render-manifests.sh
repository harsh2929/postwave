#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR=""
BACKUP_IMAGE=""
BACKUP_BUCKET=""
BACKUP_REPLICA_BUCKET=""
BACKUP_KMS_KEY_ID=""
BACKUP_EVIDENCE_SIGNING_KEY_ID=""
BACKUP_WRITER_ROLE_ARN=""
BACKUP_SIGNER_ROLE_ARN=""
AWS_REGION=""
BACKUP_REPLICA_REGION=""
BACKUP_ENVIRONMENT=""
BACKUP_CLUSTER_ID=""
POSTGRES_SYSTEM_IDENTIFIER=""

usage() {
  sed -n '2,45p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --image) BACKUP_IMAGE="$2"; shift 2 ;;
    --bucket) BACKUP_BUCKET="$2"; shift 2 ;;
    --replica-bucket) BACKUP_REPLICA_BUCKET="$2"; shift 2 ;;
    --kms-key-id) BACKUP_KMS_KEY_ID="$2"; shift 2 ;;
    --evidence-signing-key-id) BACKUP_EVIDENCE_SIGNING_KEY_ID="$2"; shift 2 ;;
    --writer-role-arn) BACKUP_WRITER_ROLE_ARN="$2"; shift 2 ;;
    --signer-role-arn) BACKUP_SIGNER_ROLE_ARN="$2"; shift 2 ;;
    --region) AWS_REGION="$2"; shift 2 ;;
    --replica-region) BACKUP_REPLICA_REGION="$2"; shift 2 ;;
    --environment) BACKUP_ENVIRONMENT="$2"; shift 2 ;;
    --cluster-id) BACKUP_CLUSTER_ID="$2"; shift 2 ;;
    --system-identifier) POSTGRES_SYSTEM_IDENTIFIER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

for name in OUTPUT_DIR BACKUP_IMAGE BACKUP_BUCKET BACKUP_REPLICA_BUCKET BACKUP_KMS_KEY_ID BACKUP_EVIDENCE_SIGNING_KEY_ID BACKUP_WRITER_ROLE_ARN BACKUP_SIGNER_ROLE_ARN AWS_REGION BACKUP_REPLICA_REGION BACKUP_ENVIRONMENT BACKUP_CLUSTER_ID POSTGRES_SYSTEM_IDENTIFIER; do
  [[ -n "${!name}" ]] || { echo "missing required option for ${name}" >&2; exit 64; }
done
[[ "${BACKUP_BUCKET}" != "${BACKUP_REPLICA_BUCKET}" ]] || { echo "primary and replica buckets must be different" >&2; exit 64; }
[[ "${AWS_REGION}" != "${BACKUP_REPLICA_REGION}" ]] || { echo "primary and replica regions must be different" >&2; exit 64; }

[[ "${BACKUP_IMAGE}" =~ ^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || {
  echo "--image must be a lowercase OCI reference pinned by sha256 digest" >&2
  exit 64
}
for bucket in "${BACKUP_BUCKET}" "${BACKUP_REPLICA_BUCKET}"; do
  [[ "${bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
    echo "invalid S3 bucket name: ${bucket}" >&2
    exit 64
  }
done
for region in "${AWS_REGION}" "${BACKUP_REPLICA_REGION}"; do
  [[ "${region}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || {
    echo "invalid AWS region: ${region}" >&2
    exit 64
  }
done
[[ "${BACKUP_ENVIRONMENT}" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || {
  echo "invalid backup environment" >&2
  exit 64
}
[[ "${BACKUP_CLUSTER_ID}" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || { echo "invalid immutable backup cluster id" >&2; exit 64; }
[[ "${POSTGRES_SYSTEM_IDENTIFIER}" =~ ^[0-9]{10,20}$ ]] || { echo "invalid PostgreSQL system identifier" >&2; exit 64; }
PARTITION='aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b'
[[ "${BACKUP_KMS_KEY_ID}" =~ ^arn:(${PARTITION}):kms:[a-z0-9-]+:[0-9]{12}:key/(mrk-)?[A-Za-z0-9-]+$ ]] || { echo "--kms-key-id must be a KMS key ARN" >&2; exit 64; }
[[ "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" =~ ^arn:(${PARTITION}):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$ ]] || { echo "--evidence-signing-key-id must be a KMS key ARN" >&2; exit 64; }
[[ "${BACKUP_WRITER_ROLE_ARN}" =~ ^arn:(${PARTITION}):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$ && "${#BACKUP_WRITER_ROLE_ARN}" -le 600 ]] || { echo "--writer-role-arn must be an IAM role ARN" >&2; exit 64; }
[[ "${BACKUP_SIGNER_ROLE_ARN}" =~ ^arn:(${PARTITION}):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$ && "${#BACKUP_SIGNER_ROLE_ARN}" -le 600 ]] || { echo "--signer-role-arn must be an IAM role ARN" >&2; exit 64; }
[[ "${BACKUP_WRITER_ROLE_ARN}" != "${BACKUP_SIGNER_ROLE_ARN}" ]] || { echo "writer and evidence-signer roles must be different" >&2; exit 64; }
[[ "$(cut -d: -f4 <<<"${BACKUP_KMS_KEY_ID}")" == "${AWS_REGION}" ]] || { echo "backup KMS key must be in the primary region" >&2; exit 64; }
[[ "$(cut -d: -f4 <<<"${BACKUP_EVIDENCE_SIGNING_KEY_ID}")" == "${AWS_REGION}" ]] || { echo "evidence signing key must be in the primary region" >&2; exit 64; }
BACKUP_ACCOUNT_ID="$(cut -d: -f5 <<<"${BACKUP_KMS_KEY_ID}")"
for arn in "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" "${BACKUP_WRITER_ROLE_ARN}" "${BACKUP_SIGNER_ROLE_ARN}"; do
  [[ "$(cut -d: -f5 <<<"${arn}")" == "${BACKUP_ACCOUNT_ID}" ]] || { echo "backup keys and workload roles must belong to the same AWS account" >&2; exit 64; }
done

umask 077
[[ ! -L "${OUTPUT_DIR}" && ( ! -e "${OUTPUT_DIR}" || -d "${OUTPUT_DIR}" ) ]] || { echo "output directory must not be a symlink or non-directory" >&2; exit 64; }
mkdir -p "${OUTPUT_DIR}"
for file in postgres-pitr-config.yaml postgres-backup-cronjob.yaml postgres-statefulset-patch.yaml; do
  sed \
    -e "s|__BACKUP_IMAGE__|${BACKUP_IMAGE}|g" \
    -e "s|__BACKUP_BUCKET__|${BACKUP_BUCKET}|g" \
    -e "s|__BACKUP_REPLICA_BUCKET__|${BACKUP_REPLICA_BUCKET}|g" \
    -e "s|__BACKUP_KMS_KEY_ID__|${BACKUP_KMS_KEY_ID}|g" \
    -e "s|__BACKUP_EVIDENCE_SIGNING_KEY_ID__|${BACKUP_EVIDENCE_SIGNING_KEY_ID}|g" \
    -e "s|__BACKUP_WRITER_ROLE_ARN__|${BACKUP_WRITER_ROLE_ARN}|g" \
    -e "s|__BACKUP_SIGNER_ROLE_ARN__|${BACKUP_SIGNER_ROLE_ARN}|g" \
    -e "s|__AWS_REGION__|${AWS_REGION}|g" \
    -e "s|__BACKUP_REPLICA_REGION__|${BACKUP_REPLICA_REGION}|g" \
    -e "s|__BACKUP_ENVIRONMENT__|${BACKUP_ENVIRONMENT}|g" \
    -e "s|__BACKUP_CLUSTER_ID__|${BACKUP_CLUSTER_ID}|g" \
    -e "s|__POSTGRES_SYSTEM_IDENTIFIER__|${POSTGRES_SYSTEM_IDENTIFIER}|g" \
    "${SCRIPT_DIR}/${file}" >"${OUTPUT_DIR}/${file}"
done

if grep -R -n '__[A-Z0-9_]\+__' "${OUTPUT_DIR}"; then
  echo "unresolved deployment token in rendered manifests" >&2
  exit 1
fi

printf 'Rendered digest-pinned backup manifests to %s\n' "${OUTPUT_DIR}"
printf 'Apply resources, then patch the existing StatefulSet:\n'
printf '  kubectl apply -f %q -f %q\n' \
  "${OUTPUT_DIR}/postgres-pitr-config.yaml" \
  "${OUTPUT_DIR}/postgres-backup-cronjob.yaml"
printf '  kubectl patch statefulset postwave-postgres -n postwave --type=strategic --patch-file %q\n' \
  "${OUTPUT_DIR}/postgres-statefulset-patch.yaml"
