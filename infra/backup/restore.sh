#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Restore a signed Moosewave logical PostgreSQL backup into a new, isolated DB.
#
# This is the independent logical-dump recovery path. It does not provide
# point-in-time replay; --target-time records the operator's selected backup
# point. Use the WAL-G or RDS procedure for physical PITR.
#
# Usage:
#   BACKUP_BUCKET=... AWS_REGION=... \
#   BACKUP_EVIDENCE_SIGNING_KEY_ID=arn:aws:kms:... \
#   PGHOST=... PGUSER=... PGPASSWORD=... \
#   ./restore.sh \
#     --backup-key postgres/prod/logical/2026/07/14/logical-.../logical-....dump \
#     --backup-version-id VERSION_ID \
#     --dump-checksum-version-id VERSION_ID \
#     --manifest-version-id VERSION_ID \
#     --manifest-checksum-version-id VERSION_ID \
#     --manifest-signature-version-id VERSION_ID \
#     --target-time 2026-07-14T07:30:00Z \
#     --expected-migration 0642 \
#     --db-name postwave_restore_20260714 \
#     --confirm-isolated-target
#
# Required environment:
#   BACKUP_BUCKET, AWS_REGION (or AWS_DEFAULT_REGION),
#   BACKUP_EVIDENCE_SIGNING_KEY_ID
#   PGHOST, PGUSER and target authentication accepted by libpq
# Optional environment:
#   RESTORE_OWNER_ROLE=postwave_app, RESTORE_JOBS=4
#   PRODUCTION_DB_HOST=<known production hostname> (restore is refused if equal)
#
# --allow-missing-sidecars exists only for staff-approved legacy artifacts. It
# requires a fixed risk acknowledgement plus an incident/change ticket,
# disables the signature/S3-checksum requirement, and must never be used as
# evidence that the production backup path is healthy.

set -euo pipefail

BACKUP_KEY=""
BACKUP_VERSION_ID=""
DUMP_CHECKSUM_VERSION_ID=""
MANIFEST_VERSION_ID=""
MANIFEST_CHECKSUM_VERSION_ID=""
MANIFEST_SIGNATURE_VERSION_ID=""
TARGET_TIME=""
DB_NAME=""
EXPECTED_MIGRATION=""
CONFIRM_ISOLATED_TARGET=0
ALLOW_MISSING_SIDECARS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-key) BACKUP_KEY="${2:-}"; shift 2 ;;
    --backup-version-id) BACKUP_VERSION_ID="${2:-}"; shift 2 ;;
    --dump-checksum-version-id) DUMP_CHECKSUM_VERSION_ID="${2:-}"; shift 2 ;;
    --manifest-version-id) MANIFEST_VERSION_ID="${2:-}"; shift 2 ;;
    --manifest-checksum-version-id) MANIFEST_CHECKSUM_VERSION_ID="${2:-}"; shift 2 ;;
    --manifest-signature-version-id) MANIFEST_SIGNATURE_VERSION_ID="${2:-}"; shift 2 ;;
    --target-time) TARGET_TIME="${2:-}"; shift 2 ;;
    --expected-migration) EXPECTED_MIGRATION="${2:-}"; shift 2 ;;
    --db-name) DB_NAME="${2:-}"; shift 2 ;;
    --confirm-isolated-target) CONFIRM_ISOLATED_TARGET=1; shift ;;
    --allow-missing-sidecars) ALLOW_MISSING_SIDECARS=1; shift ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

fail() {
  printf '[%s] ERROR: %s\n' "$(date -u +%FT%TZ)" "$*" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

for name in BACKUP_KEY TARGET_TIME DB_NAME EXPECTED_MIGRATION; do
  [[ -n "${!name}" ]] || { echo "missing required argument: ${name}" >&2; exit 64; }
done
: "${BACKUP_BUCKET:?BACKUP_BUCKET must be set}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
: "${AWS_REGION:?AWS_REGION or AWS_DEFAULT_REGION must be set}"
BACKUP_EVIDENCE_REGION="${BACKUP_EVIDENCE_REGION:-${AWS_REGION}}"
: "${BACKUP_SOURCE_KMS_KEY_ID:?BACKUP_SOURCE_KMS_KEY_ID must be set}"
BACKUP_EVIDENCE_PUBLIC_KEY_FILE="${BACKUP_EVIDENCE_PUBLIC_KEY_FILE:-}"
BACKUP_EVIDENCE_PUBLIC_KEY_SHA256="${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256:-}"
if [[ -n "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" || -n "${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256}" ]]; then
  [[ -f "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" ]] || { echo "BACKUP_EVIDENCE_PUBLIC_KEY_FILE is not readable" >&2; exit 64; }
  [[ "${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256}" =~ ^[a-f0-9]{64}$ ]] || { echo "BACKUP_EVIDENCE_PUBLIC_KEY_SHA256 must be the pinned DER fingerprint" >&2; exit 64; }
fi
: "${PGHOST:?PGHOST must be set}"
: "${PGUSER:?PGUSER must be set}"
: "${PRODUCTION_DB_HOST:?PRODUCTION_DB_HOST must be set to the reviewed production endpoint}"
: "${RESTORE_TARGET_MARKER:?RESTORE_TARGET_MARKER must be set to the pre-provisioned isolated-target marker}"
[[ "${RESTORE_TARGET_MARKER}" =~ ^[A-Za-z0-9._-]{8,128}$ ]] || { echo "RESTORE_TARGET_MARKER is invalid" >&2; exit 64; }

[[ "${CONFIRM_ISOLATED_TARGET}" == "1" ]] || {
  echo "--confirm-isolated-target is required; this script must never target the active database" >&2
  exit 64
}
[[ "${DB_NAME}" =~ ^postwave_(restore|dr)_[a-z0-9_]{1,43}$ ]] || {
  echo "--db-name must start postwave_restore_ or postwave_dr_ and contain only lowercase letters, digits, and underscores" >&2
  exit 64
}
[[ "${TARGET_TIME}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
  echo "--target-time must be UTC in YYYY-MM-DDTHH:MM:SSZ form" >&2
  exit 64
}
[[ "${EXPECTED_MIGRATION}" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || {
  echo "--expected-migration is invalid" >&2
  exit 64
}
[[ "${BACKUP_KEY}" =~ ^postgres/[a-z0-9-]+/logical/[0-9]{4}/[0-9]{2}/[0-9]{2}/logical-[0-9]{8}T[0-9]{6}Z/logical-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || {
  echo "--backup-key does not match the managed logical-backup object layout" >&2
  exit 64
}

if [[ "${ALLOW_MISSING_SIDECARS}" != "1" ]]; then
  for version_name in BACKUP_VERSION_ID DUMP_CHECKSUM_VERSION_ID MANIFEST_VERSION_ID MANIFEST_CHECKSUM_VERSION_ID MANIFEST_SIGNATURE_VERSION_ID; do
    [[ -n "${!version_name}" ]] || { echo "all dump and signed-sidecar version IDs are required for a normal restore (${version_name})" >&2; exit 64; }
  done
else
  [[ "${LEGACY_RESTORE_APPROVAL:-}" == "I_ACCEPT_UNSIGNED_LEGACY_ARTIFACT_RISK" ]] || {
    echo "legacy restore requires LEGACY_RESTORE_APPROVAL=I_ACCEPT_UNSIGNED_LEGACY_ARTIFACT_RISK" >&2
    exit 64
  }
  [[ "${LEGACY_RESTORE_TICKET:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._@+:/-]{2,127}$ ]] || {
    echo "legacy restore requires a safe 3-128 character LEGACY_RESTORE_TICKET" >&2
    exit 64
  }
  log "BREAK-GLASS: unsigned legacy artifact mode approved under ticket ${LEGACY_RESTORE_TICKET}; this run cannot qualify production backup controls"
fi
for version_name in BACKUP_VERSION_ID DUMP_CHECKSUM_VERSION_ID MANIFEST_VERSION_ID MANIFEST_CHECKSUM_VERSION_ID MANIFEST_SIGNATURE_VERSION_ID; do
  if [[ -n "${!version_name}" && ! "${!version_name}" =~ ^[A-Za-z0-9._~+/=:-]{1,1024}$ ]]; then
    echo "invalid S3 version id: ${version_name}" >&2
    exit 64
  fi
done

RESTORE_OWNER_ROLE="${RESTORE_OWNER_ROLE:-postwave_app}"
RESTORE_JOBS="${RESTORE_JOBS:-4}"
[[ "${RESTORE_OWNER_ROLE}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || {
  echo "RESTORE_OWNER_ROLE is not a safe PostgreSQL identifier" >&2
  exit 64
}
[[ "${RESTORE_JOBS}" =~ ^[1-9][0-9]?$ ]] || {
  echo "RESTORE_JOBS must be an integer from 1 to 99" >&2
  exit 64
}

normalise_host() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/\.$//'
}
if [[ "$(normalise_host "${PGHOST}")" == "$(normalise_host "${PRODUCTION_DB_HOST}")" ]]; then
  fail "PGHOST matches PRODUCTION_DB_HOST; refusing destructive restore"
fi

for command_name in aws jq openssl pg_restore psql createdb dropdb; do
  need "${command_name}"
done
aws s3api head-object --bucket postwave-capability-check --key object --checksum-mode ENABLED --generate-cli-skeleton output >/dev/null 2>&1 || fail "AWS CLI is too old for checksum-aware restore operations"
if [[ -z "${PGPASSWORD:-}" ]]; then
  log "warning: PGPASSWORD is unset; relying on IAM authentication, .pgpass, or another libpq mechanism"
fi
if [[ "${ALLOW_MISSING_SIDECARS}" != "1" ]]; then
  : "${BACKUP_EVIDENCE_SIGNING_KEY_ID:?BACKUP_EVIDENCE_SIGNING_KEY_ID must be set}"
fi

MAINTENANCE_DB="${PGDATABASE:-postgres}"
target_marker="$(psql --dbname="${MAINTENANCE_DB}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -c "SELECT marker FROM public.postwave_restore_target_control WHERE active IS TRUE ORDER BY created_at DESC LIMIT 1" 2>/dev/null)" || \
  fail "isolated target marker table is missing; refusing to rely on an operator assertion alone"
[[ "${target_marker}" == "${RESTORE_TARGET_MARKER}" ]] || fail "isolated target marker does not match RESTORE_TARGET_MARKER"

umask 077
WORKDIR="$(mktemp -d -t postwave-restore-XXXXXX)"
DUMP_FILE="${WORKDIR}/$(basename "${BACKUP_KEY}")"
SHA_FILE="${DUMP_FILE}.sha256"
MANIFEST_FILE="${WORKDIR}/manifest.json"
MANIFEST_SHA_FILE="${WORKDIR}/manifest.json.sha256"
SIGNATURE_FILE="${WORKDIR}/manifest.json.sig.json"
DB_CREATED=0

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "${status}" -ne 0 && "${DB_CREATED}" == "1" ]]; then
    log "restore failed; dropping incomplete isolated database ${DB_NAME}"
    dropdb --if-exists "${DB_NAME}" >/dev/null 2>&1 || log "warning: failed to drop incomplete database ${DB_NAME}"
  fi
  rm -rf "${WORKDIR}"
  exit "${status}"
}
trap cleanup EXIT

sha256_hex() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

sha256_base64() {
  openssl dgst -sha256 -binary "$1" | openssl base64 -A
}

# Download an exact S3 object, then independently verify its service-side
# checksum and encryption metadata. The dump and every signed sidecar are
# pinned to operator-reviewed version IDs.
download_object() {
  local key="$1"
  local output="$2"
  local version_id="${3:-}"
  local -a head_args get_args
  local head_json encryption kms_key s3_checksum checksum_type actual_checksum resolved_version

  head_args=(aws s3api head-object --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${key}" --checksum-mode ENABLED)
  get_args=(aws s3api get-object --region "${AWS_REGION}" --bucket "${BACKUP_BUCKET}" --key "${key}" --checksum-mode ENABLED)
  if [[ -n "${version_id}" ]]; then
    head_args+=(--version-id "${version_id}")
    get_args+=(--version-id "${version_id}")
  fi

  head_json="$("${head_args[@]}" 2>/dev/null)" || return 1
  "${get_args[@]}" "${output}" >/dev/null

  encryption="$(jq -r '.ServerSideEncryption // empty' <<<"${head_json}")"
  kms_key="$(jq -r '.SSEKMSKeyId // empty' <<<"${head_json}")"
  s3_checksum="$(jq -r '.ChecksumSHA256 // empty' <<<"${head_json}")"
  checksum_type="$(jq -r '.ChecksumType // "FULL_OBJECT"' <<<"${head_json}")"
  resolved_version="$(jq -r '.VersionId // "unversioned"' <<<"${head_json}")"
  if [[ "${ALLOW_MISSING_SIDECARS}" != "1" ]]; then
    [[ "${encryption}" == "aws:kms" ]] || fail "s3://${BACKUP_BUCKET}/${key} is not protected with SSE-KMS"
    [[ "${kms_key}" == "${BACKUP_SOURCE_KMS_KEY_ID}" ]] || fail "s3://${BACKUP_BUCKET}/${key} uses an unexpected KMS key"
    [[ -n "${s3_checksum}" ]] || fail "s3://${BACKUP_BUCKET}/${key} has no stored SHA-256 checksum"
  fi
  if [[ -n "${s3_checksum}" && "${checksum_type}" == "FULL_OBJECT" ]]; then
    actual_checksum="$(sha256_base64 "${output}")"
    [[ "${actual_checksum}" == "${s3_checksum}" ]] || fail "S3 checksum mismatch for ${key}"
  elif [[ -n "${s3_checksum}" && "${checksum_type}" == "COMPOSITE" ]]; then
    log "validated transport checksum metadata for multipart object ${key}; signed manifest verifies the full object digest"
  else
    log "warning: ${key} has no S3 checksum (legacy mode)"
  fi
  log "downloaded ${key} (version ${resolved_version})"
}

PREFIX="${BACKUP_KEY%/*}"
log "selected logical backup point ${TARGET_TIME}; logical dumps cannot replay between dump snapshots"
log "downloading exact dump version from s3://${BACKUP_BUCKET}/${BACKUP_KEY}"
download_object "${BACKUP_KEY}" "${DUMP_FILE}" "${BACKUP_VERSION_ID}" || fail "dump object/version is missing or unreadable"

download_object "${PREFIX}/$(basename "${BACKUP_KEY}").sha256" "${SHA_FILE}" "${DUMP_CHECKSUM_VERSION_ID}" || {
  [[ "${ALLOW_MISSING_SIDECARS}" == "1" ]] || fail "dump checksum sidecar is missing"
  log "warning: dump checksum sidecar missing (legacy mode)"
}
download_object "${PREFIX}/manifest.json" "${MANIFEST_FILE}" "${MANIFEST_VERSION_ID}" || {
  [[ "${ALLOW_MISSING_SIDECARS}" == "1" ]] || fail "signed manifest is missing"
  log "warning: manifest missing (legacy mode)"
}
if [[ -f "${MANIFEST_FILE}" ]]; then
  download_object "${PREFIX}/manifest.json.sha256" "${MANIFEST_SHA_FILE}" "${MANIFEST_CHECKSUM_VERSION_ID}" || {
    [[ "${ALLOW_MISSING_SIDECARS}" == "1" ]] || fail "manifest checksum is missing"
    log "warning: manifest checksum missing (legacy mode)"
  }
  download_object "${PREFIX}/manifest.json.sig.json" "${SIGNATURE_FILE}" "${MANIFEST_SIGNATURE_VERSION_ID}" || {
    [[ "${ALLOW_MISSING_SIDECARS}" == "1" ]] || fail "manifest signature is missing"
    log "warning: manifest signature missing (legacy mode)"
  }
fi

if ! head -c 5 "${DUMP_FILE}" | grep -qx 'PGDMP'; then
  fail "downloaded object is not a custom-format pg_dump"
fi
pg_restore --list "${DUMP_FILE}" >/dev/null

if [[ -f "${SHA_FILE}" ]]; then
  EXPECTED_DUMP_SHA="$(awk 'NR == 1 {print $1}' "${SHA_FILE}")"
  [[ "${EXPECTED_DUMP_SHA}" =~ ^[a-f0-9]{64}$ ]] || fail "dump checksum sidecar is malformed"
  [[ "$(sha256_hex "${DUMP_FILE}")" == "${EXPECTED_DUMP_SHA}" ]] || fail "dump checksum sidecar does not match"
fi

if [[ -f "${MANIFEST_FILE}" ]]; then
  if [[ "${ALLOW_MISSING_SIDECARS}" == "1" ]]; then
    jq -e 'type == "object" and (.manifest_version == 1 or .manifest_version == 2)' "${MANIFEST_FILE}" >/dev/null || fail "legacy manifest schema/version is invalid"
  else
    jq -e 'type == "object" and .manifest_version == 2 and .kind == "postgres_logical_backup" and .row_counts_are_transactionally_bound_to_dump == false' "${MANIFEST_FILE}" >/dev/null || fail "signed manifest does not satisfy the managed logical-backup contract"
  fi
  if [[ -f "${MANIFEST_SHA_FILE}" ]]; then
    EXPECTED_MANIFEST_SHA="$(awk 'NR == 1 {print $1}' "${MANIFEST_SHA_FILE}")"
    [[ "${EXPECTED_MANIFEST_SHA}" =~ ^[a-f0-9]{64}$ ]] || fail "manifest checksum sidecar is malformed"
    [[ "$(sha256_hex "${MANIFEST_FILE}")" == "${EXPECTED_MANIFEST_SHA}" ]] || fail "manifest checksum does not match"
  fi

  if [[ -f "${SIGNATURE_FILE}" ]]; then
    [[ -n "${BACKUP_EVIDENCE_SIGNING_KEY_ID:-}" ]] || fail "BACKUP_EVIDENCE_SIGNING_KEY_ID is required to verify the available signature"
    SIGNATURE_KEY="$(jq -er '.key_id' "${SIGNATURE_FILE}")"
    SIGNATURE_ALGORITHM="$(jq -er '.algorithm' "${SIGNATURE_FILE}")"
    SIGNATURE_MESSAGE_TYPE="$(jq -er '.message_type' "${SIGNATURE_FILE}")"
    SIGNATURE_SHA="$(jq -er '.sha256' "${SIGNATURE_FILE}")"
    SIGNATURE_BASE64="$(jq -er '.signature_base64' "${SIGNATURE_FILE}")"
    [[ "${SIGNATURE_KEY}" == "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" ]] || fail "manifest was signed by an unexpected KMS key"
    [[ "${SIGNATURE_ALGORITHM}" == "RSASSA_PSS_SHA_256" && "${SIGNATURE_MESSAGE_TYPE}" == "DIGEST" ]] || fail "manifest uses an unsupported signature contract"
    [[ "${SIGNATURE_SHA}" == "$(sha256_hex "${MANIFEST_FILE}")" ]] || fail "signature metadata does not match manifest digest"

    openssl dgst -sha256 -binary -out "${WORKDIR}/manifest.digest" "${MANIFEST_FILE}"
    printf '%s' "${SIGNATURE_BASE64}" | openssl base64 -d -A -out "${WORKDIR}/manifest.signature"
    if [[ -n "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" ]]; then
      PUBLIC_KEY_FINGERPRINT="$(openssl pkey -pubin -in "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $2}')"
      [[ "${PUBLIC_KEY_FINGERPRINT}" == "${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256}" ]] || fail "offline evidence public-key fingerprint does not match the reviewed value"
      openssl dgst -sha256 \
        -verify "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" \
        -signature "${WORKDIR}/manifest.signature" \
        -sigopt rsa_padding_mode:pss \
        -sigopt rsa_pss_saltlen:-1 \
        "${MANIFEST_FILE}" >/dev/null || fail "offline public key rejected the manifest signature"
      log "verified manifest signature with the pinned offline public key"
    else
      SIGNATURE_VALID="$(aws kms verify \
        --region "${BACKUP_EVIDENCE_REGION}" \
        --key-id "${SIGNATURE_KEY}" \
        --message-type DIGEST \
        --signing-algorithm "${SIGNATURE_ALGORITHM}" \
        --message "fileb://${WORKDIR}/manifest.digest" \
        --signature "fileb://${WORKDIR}/manifest.signature" \
        --query SignatureValid --output text)"
      [[ "${SIGNATURE_VALID}" == "True" || "${SIGNATURE_VALID}" == "true" ]] || fail "KMS rejected the manifest signature"
      log "verified manifest signature with ${SIGNATURE_KEY}"
    fi
  fi

  MANIFEST_FILE_NAME="$(jq -er '.artifact.file' "${MANIFEST_FILE}")"
  MANIFEST_FORMAT="$(jq -er '.artifact.format' "${MANIFEST_FILE}")"
  MANIFEST_DUMP_SHA="$(jq -er '.artifact.sha256' "${MANIFEST_FILE}")"
  MANIFEST_DUMP_BYTES="$(jq -er '.artifact.bytes' "${MANIFEST_FILE}")"
  [[ "${MANIFEST_FILE_NAME}" == "$(basename "${BACKUP_KEY}")" ]] || fail "manifest names a different dump artifact"
  [[ "${MANIFEST_FORMAT}" == "pg_dump_custom" ]] || fail "manifest artifact format is unsupported"
  [[ "${MANIFEST_DUMP_SHA}" == "$(sha256_hex "${DUMP_FILE}")" ]] || fail "manifest dump digest does not match"
  [[ "${MANIFEST_DUMP_BYTES}" =~ ^[0-9]+$ && "${MANIFEST_DUMP_BYTES}" -eq "$(wc -c <"${DUMP_FILE}" | tr -d ' ')" ]] || fail "manifest dump size does not match"
  MANIFEST_MIGRATION="$(jq -er '.schema.latest_migration' "${MANIFEST_FILE}")"
  [[ "${MANIFEST_MIGRATION}" == "${EXPECTED_MIGRATION}" ]] || fail "manifest migration ${MANIFEST_MIGRATION} does not match the selected application migration ${EXPECTED_MIGRATION}"
fi

db_exists="$(psql --dbname="${MAINTENANCE_DB}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname='${DB_NAME}')")"
[[ "${db_exists}" == "f" ]] || fail "target database already exists: ${DB_NAME}"
role_exists="$(psql --dbname="${MAINTENANCE_DB}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RESTORE_OWNER_ROLE}')")"
[[ "${role_exists}" == "t" ]] || fail "RESTORE_OWNER_ROLE does not exist; provision it securely before recovery"
role_is_safe="$(psql --dbname="${MAINTENANCE_DB}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='${RESTORE_OWNER_ROLE}'")"
[[ "${role_is_safe}" == "t" ]] || fail "RESTORE_OWNER_ROLE must not be SUPERUSER or BYPASSRLS"

log "creating new isolated database ${DB_NAME} owned by ${RESTORE_OWNER_ROLE}"
createdb --owner="${RESTORE_OWNER_ROLE}" --encoding=UTF8 --template=template0 "${DB_NAME}"
DB_CREATED=1

log "restoring ${BACKUP_KEY} into ${DB_NAME}"
pg_restore \
  --dbname="${DB_NAME}" \
  --jobs="${RESTORE_JOBS}" \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --role="${RESTORE_OWNER_ROLE}" \
  "${DUMP_FILE}"

q() {
  psql --dbname="${DB_NAME}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1"
}

for table in schema_migrations tenants users subscribers; do
  [[ "$(q "SELECT to_regclass('public.${table}') IS NOT NULL")" == "t" ]] || fail "required restored table is missing: ${table}"
done
MIGRATION_COUNT="$(q 'SELECT count(*) FROM public.schema_migrations')"
[[ "${MIGRATION_COUNT}" -gt 0 ]] || fail "restored schema_migrations is empty"

RLS_FAILURES="$(q "
  SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','p')
     AND NOT c.relispartition
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     )
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
")"
[[ "${RLS_FAILURES}" -eq 0 ]] || fail "${RLS_FAILURES} tenant-scoped tables lost enabled and forced RLS"

INVALID_FKS="$(q "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated")"
[[ "${INVALID_FKS}" -eq 0 ]] || fail "${INVALID_FKS} restored foreign keys are not validated"
INVALID_INDEXES="$(q 'SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready')"
[[ "${INVALID_INDEXES}" -eq 0 ]] || fail "${INVALID_INDEXES} restored indexes are invalid or not ready"

RLS_PROBE="$(q "SET ROLE \"${RESTORE_OWNER_ROLE}\"; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',false); SELECT count(*) FROM public.tenants")"
[[ "$(tail -n 1 <<<"${RLS_PROBE}")" -eq 0 ]] || fail "application-role RLS probe could see rows outside the synthetic tenant"

LATEST_MIGRATION="$(q 'SELECT version::text FROM public.schema_migrations ORDER BY version DESC LIMIT 1')"
[[ "${LATEST_MIGRATION}" == "${EXPECTED_MIGRATION}" ]] || fail "restored migration ${LATEST_MIGRATION} does not match the selected application migration ${EXPECTED_MIGRATION}"
if [[ -f "${MANIFEST_FILE}" ]]; then
  log "manifest row counts are diagnostic only and are not treated as transaction-bound parity"
fi
DATABASE_SIZE="$(q 'SELECT pg_database_size(current_database())')"
TENANT_COUNT="$(q 'SELECT count(*) FROM public.tenants')"
DB_CREATED=0

log "logical restore verification passed: database=${DB_NAME} migration=${LATEST_MIGRATION} size=${DATABASE_SIZE} tenants=${TENANT_COUNT}"
cat <<EOF

RESTORE COMPLETE: ${DB_NAME}

This database remains a recovery candidate, not a promoted primary. Before any
traffic decision, run an isolated exact-release application stack, /api/ready,
smoke tests, Listmonk/object/provider reconciliation, and the reviewed cutover
procedure in docs/runbooks/disaster-recovery.md.
EOF
