#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Destructively restore the committed WAL-G chain into a disposable Docker
# volume, replay to an explicit point in time, verify, sign evidence, and
# always destroy the recovered production data before exit.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_IMAGE="${BACKUP_IMAGE:-}"
WALG_S3_PREFIX="${WALG_S3_PREFIX:-}"
RESTORE_DATABASE_NAME="${RESTORE_DATABASE_NAME:-}"
RECOVERY_TARGET_TIME=""
DRILL_OPERATOR_ID="${DRILL_OPERATOR_ID:-}"
BACKUP_ENVIRONMENT="${BACKUP_ENVIRONMENT:-prod}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
BACKUP_EVIDENCE_BUCKET="${BACKUP_EVIDENCE_BUCKET:-}"
BACKUP_EVIDENCE_REGION="${BACKUP_EVIDENCE_REGION:-${AWS_REGION}}"
BACKUP_METRIC_REGION="${BACKUP_METRIC_REGION:-${BACKUP_EVIDENCE_REGION}}"
BACKUP_KMS_KEY_ID="${BACKUP_KMS_KEY_ID:-}"
BACKUP_SOURCE_KMS_KEY_ID="${BACKUP_SOURCE_KMS_KEY_ID:-}"
BACKUP_EVIDENCE_SIGNING_KEY_ID="${BACKUP_EVIDENCE_SIGNING_KEY_ID:-}"
BACKUP_EVIDENCE_PUBLIC_KEY_FILE="${BACKUP_EVIDENCE_PUBLIC_KEY_FILE:-}"
BACKUP_EVIDENCE_PUBLIC_KEY_SHA256="${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256:-}"
BACKUP_IMAGE_CERTIFICATE_IDENTITY="${BACKUP_IMAGE_CERTIFICATE_IDENTITY:-}"
BACKUP_IMAGE_CERTIFICATE_OIDC_ISSUER="${BACKUP_IMAGE_CERTIFICATE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-1800}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) BACKUP_IMAGE="$2"; shift 2 ;;
    --walg-prefix) WALG_S3_PREFIX="$2"; shift 2 ;;
    --database) RESTORE_DATABASE_NAME="$2"; shift 2 ;;
    --target-time) RECOVERY_TARGET_TIME="$2"; shift 2 ;;
    --operator-id) DRILL_OPERATOR_ID="$2"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }
for command_name in aws cosign docker jq openssl python3; do need "${command_name}"; done
aws s3 cp "$0" s3://postwave-capability-check/object --checksum-algorithm SHA256 --dryrun >/dev/null 2>&1 || fail "AWS CLI is too old for checksum-aware evidence operations"
aws s3api put-object --bucket postwave-capability-check --key object --body "$0" --checksum-algorithm SHA256 --object-lock-mode GOVERNANCE --object-lock-retain-until-date 2030-01-01T00:00:00Z --generate-cli-skeleton output >/dev/null 2>&1 || fail "AWS CLI lacks required Object Lock evidence support"

[[ "${BACKUP_IMAGE}" =~ ^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || fail "BACKUP_IMAGE must be a lowercase OCI reference pinned by sha256 digest"
[[ "${WALG_S3_PREFIX}" =~ ^s3://[a-z0-9][a-z0-9.-]+/.+ ]] || fail "WALG_S3_PREFIX must be a non-root s3:// URI"
s3_without_scheme="${WALG_S3_PREFIX#s3://}"
source_bucket="${s3_without_scheme%%/*}"
source_prefix="${s3_without_scheme#*/}"
[[ "${RESTORE_DATABASE_NAME}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || fail "--database is required and must be a safe lowercase PostgreSQL database name"
[[ "${RECOVERY_TARGET_TIME}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "--target-time must be explicit UTC RFC3339"
[[ "${DRILL_OPERATOR_ID}" =~ ^[A-Za-z0-9._@+-]{2,128}$ ]] || fail "--operator-id is required for signed evidence"
[[ -n "${AWS_REGION}" ]] || fail "AWS_REGION is required"
[[ -n "${BACKUP_EVIDENCE_BUCKET}" ]] || fail "BACKUP_EVIDENCE_BUCKET is required"
[[ -n "${BACKUP_EVIDENCE_REGION}" ]] || fail "BACKUP_EVIDENCE_REGION is required"
[[ -n "${BACKUP_METRIC_REGION}" ]] || fail "BACKUP_METRIC_REGION is required"
[[ -n "${BACKUP_KMS_KEY_ID}" ]] || fail "BACKUP_KMS_KEY_ID is required"
[[ -n "${BACKUP_SOURCE_KMS_KEY_ID}" ]] || fail "BACKUP_SOURCE_KMS_KEY_ID is required"
[[ -n "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" ]] || fail "BACKUP_EVIDENCE_SIGNING_KEY_ID is required"
for region in "${AWS_REGION}" "${BACKUP_EVIDENCE_REGION}" "${BACKUP_METRIC_REGION}"; do
  [[ "${region}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || fail "invalid AWS Region: ${region}"
done
for bucket in "${source_bucket}" "${BACKUP_EVIDENCE_BUCKET}"; do
  [[ "${bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ && "${bucket}" != *..* ]] || fail "invalid S3 bucket name: ${bucket}"
done
PARTITION='aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b'
for key_arn in "${BACKUP_KMS_KEY_ID}" "${BACKUP_SOURCE_KMS_KEY_ID}" "${BACKUP_EVIDENCE_SIGNING_KEY_ID}"; do
  [[ "${key_arn}" =~ ^arn:(${PARTITION}):kms:([a-z0-9-]+):([0-9]{12}):key/(mrk-)?[A-Za-z0-9-]+$ ]] || fail "backup KMS identifiers must be key ARNs"
done
[[ "$(cut -d: -f4 <<<"${BACKUP_SOURCE_KMS_KEY_ID}")" == "${AWS_REGION}" ]] || fail "BACKUP_SOURCE_KMS_KEY_ID must be in AWS_REGION"
[[ "$(cut -d: -f4 <<<"${BACKUP_KMS_KEY_ID}")" == "${BACKUP_EVIDENCE_REGION}" ]] || fail "BACKUP_KMS_KEY_ID must be in BACKUP_EVIDENCE_REGION"
[[ "$(cut -d: -f4 <<<"${BACKUP_EVIDENCE_SIGNING_KEY_ID}")" == "${BACKUP_EVIDENCE_REGION}" ]] || fail "BACKUP_EVIDENCE_SIGNING_KEY_ID must be in BACKUP_EVIDENCE_REGION"
key_account="$(cut -d: -f5 <<<"${BACKUP_KMS_KEY_ID}")"
[[ "$(cut -d: -f5 <<<"${BACKUP_SOURCE_KMS_KEY_ID}")" == "${key_account}" && "$(cut -d: -f5 <<<"${BACKUP_EVIDENCE_SIGNING_KEY_ID}")" == "${key_account}" ]] || fail "backup encryption and signing keys must belong to one reviewed account"
if [[ -n "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" || -n "${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256}" ]]; then
  [[ -f "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" ]] || fail "BACKUP_EVIDENCE_PUBLIC_KEY_FILE is not readable"
  [[ "${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256}" =~ ^[a-f0-9]{64}$ ]] || fail "BACKUP_EVIDENCE_PUBLIC_KEY_SHA256 must be the pinned DER public-key fingerprint"
fi
[[ "${BACKUP_IMAGE_CERTIFICATE_IDENTITY}" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/\.github/workflows/backup-dr\.yml@refs/heads/main$ ]] || fail "BACKUP_IMAGE_CERTIFICATE_IDENTITY must name the approved main-branch backup workflow"
[[ "${BACKUP_IMAGE_CERTIFICATE_OIDC_ISSUER}" == "https://token.actions.githubusercontent.com" ]] || fail "unsupported backup-image certificate issuer"

parse_epoch() {
  python3 - "$1" <<'PY'
from datetime import datetime
import sys

print(int(datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))
PY
}
target_epoch="$(parse_epoch "${RECOVERY_TARGET_TIME}")"
[[ "${target_epoch}" -lt "$(date -u +%s)" ]] || fail "recovery target must be in the past"
recovery_target_pg="$(python3 - "${RECOVERY_TARGET_TIME}" <<'PY'
from datetime import datetime, timezone
import sys

value = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).astimezone(timezone.utc)
print(value.strftime("%Y-%m-%d %H:%M:%S+00"))
PY
)"

drill_id="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
safe_drill_id="$(printf '%s' "${drill_id}" | tr '[:upper:]' '[:lower:]')"
container="postwave-dr-${safe_drill_id}"
volume="postwave-dr-${safe_drill_id}"
wal_volume="postwave-dr-wal-${safe_drill_id}"
workdir="$(mktemp -d -t postwave-dr.XXXXXX)"
verification="${workdir}/verification.json"
backup_list="${workdir}/backup-list.json"
evidence="${workdir}/evidence.json"
evidence_checksum="${evidence}.sha256"
evidence_signature="${evidence}.sig.json"
evidence_commit="${workdir}/complete.json"
cosign_verification="${workdir}/cosign-verification.json"
started_at="$(date -u +%FT%TZ)"
started_epoch="$(date -u +%s)"
current_stage="initializing"
teardown_state="not_started"

docker_env_args=()
for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION AWS_ROLE_ARN; do
  if [[ -n "${!name:-}" ]]; then
    docker_env_args+=(--env "${name}=${!name}")
  fi
done
if [[ -n "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ]]; then
  [[ -f "${AWS_WEB_IDENTITY_TOKEN_FILE}" ]] || fail "AWS_WEB_IDENTITY_TOKEN_FILE does not exist"
  docker_env_args+=(
    --env "AWS_WEB_IDENTITY_TOKEN_FILE=${AWS_WEB_IDENTITY_TOKEN_FILE}"
    --mount "type=bind,src=${AWS_WEB_IDENTITY_TOKEN_FILE},dst=${AWS_WEB_IDENTITY_TOKEN_FILE},readonly"
  )
fi
docker_env_args+=(--env "WALG_S3_PREFIX=${WALG_S3_PREFIX}")

verify_evidence_signature() {
  local input="$1"
  local signature_json="$2"
  local digest="${workdir}/verification.digest"
  local signature="${workdir}/verification.signature"
  local actual_sha key_id algorithm message_type signature_base64 fingerprint
  actual_sha="$(openssl dgst -sha256 "${input}" | awk '{print $2}')"
  key_id="$(jq -r '.key_id // empty' "${signature_json}")"
  algorithm="$(jq -r '.algorithm // empty' "${signature_json}")"
  message_type="$(jq -r '.message_type // empty' "${signature_json}")"
  signature_base64="$(jq -r '.signature_base64 // empty' "${signature_json}")"
  [[ "$(jq -r '.sha256 // empty' "${signature_json}")" == "${actual_sha}" ]] || return 1
  [[ "${key_id}" == "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" ]] || return 1
  [[ "${algorithm}" == "RSASSA_PSS_SHA_256" && "${message_type}" == "DIGEST" ]] || return 1
  openssl dgst -sha256 -binary -out "${digest}" "${input}" || return 1
  printf '%s' "${signature_base64}" | openssl base64 -d -A -out "${signature}" || return 1

  if [[ -n "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" ]]; then
    fingerprint="$(openssl pkey -pubin -in "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $2}')"
    [[ "${fingerprint}" == "${BACKUP_EVIDENCE_PUBLIC_KEY_SHA256}" ]] || return 1
    openssl dgst -sha256 \
      -verify "${BACKUP_EVIDENCE_PUBLIC_KEY_FILE}" \
      -signature "${signature}" \
      -sigopt rsa_padding_mode:pss \
      -sigopt rsa_pss_saltlen:-1 \
      "${input}" >/dev/null
  else
    aws kms verify \
      --region "${BACKUP_EVIDENCE_REGION}" \
      --key-id "${key_id}" \
      --message-type DIGEST \
      --signing-algorithm "${algorithm}" \
      --message "fileb://${digest}" \
      --signature "fileb://${signature}" \
      --query SignatureValid --output text | grep -qx 'True'
  fi
}

download_source_evidence() {
  local key="$1"
  local output="$2"
  local head_json encryption kms_key checksum checksum_type actual_checksum
  head_json="$(aws s3api head-object --region "${AWS_REGION}" --bucket "${source_bucket}" --key "${key}" --checksum-mode ENABLED)"
  aws s3api get-object --region "${AWS_REGION}" --bucket "${source_bucket}" --key "${key}" --checksum-mode ENABLED "${output}" >/dev/null
  encryption="$(jq -r '.ServerSideEncryption // empty' <<<"${head_json}")"
  kms_key="$(jq -r '.SSEKMSKeyId // empty' <<<"${head_json}")"
  checksum="$(jq -r '.ChecksumSHA256 // empty' <<<"${head_json}")"
  checksum_type="$(jq -r '.ChecksumType // "FULL_OBJECT"' <<<"${head_json}")"
  actual_checksum="$(openssl dgst -sha256 -binary "${output}" | openssl base64 -A)"
  [[ "${encryption}" == "aws:kms" && "${kms_key}" == "${BACKUP_SOURCE_KMS_KEY_ID}" ]] || return 1
  [[ "${checksum_type}" == "FULL_OBJECT" && "${checksum}" == "${actual_checksum}" ]] || return 1
}

sign_evidence() {
  local digest_file="${workdir}/evidence.digest"
  local signature_binary="${workdir}/evidence.signature"
  local signature_base64
  openssl dgst -sha256 -binary -out "${digest_file}" "${evidence}" || return 1
  signature_base64="$(aws kms sign \
    --region "${BACKUP_EVIDENCE_REGION}" \
    --key-id "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" \
    --message-type DIGEST \
    --signing-algorithm RSASSA_PSS_SHA_256 \
    --message "fileb://${digest_file}" \
    --query Signature --output text)" || return 1
  printf '%s' "${signature_base64}" | openssl base64 -d -A >"${signature_binary}" || return 1
  aws kms verify \
    --region "${BACKUP_EVIDENCE_REGION}" \
    --key-id "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" \
    --message-type DIGEST \
    --signing-algorithm RSASSA_PSS_SHA_256 \
    --message "fileb://${digest_file}" \
    --signature "fileb://${signature_binary}" \
    --query SignatureValid --output text | grep -qx 'True' || return 1
  jq -n \
    --arg signed_at "$(date -u +%FT%TZ)" \
    --arg key_id "${BACKUP_EVIDENCE_SIGNING_KEY_ID}" \
    --arg sha256 "$(openssl dgst -sha256 "${evidence}" | awk '{print $2}')" \
    --arg signature_base64 "${signature_base64}" \
    '{signature_version:1,signed_at:$signed_at,key_id:$key_id,algorithm:"RSASSA_PSS_SHA_256",message_type:"DIGEST",sha256:$sha256,signature_base64:$signature_base64}' \
    >"${evidence_signature}" || return 1
}

upload_evidence() {
  local result="$1"
  local prefix
  local spec path remainder key_name kind key
  local head_json encryption kms_key stored_checksum actual_checksum object_lock_mode object_lock_until version_id
  local retention_until
  prefix="postgres/${BACKUP_ENVIRONMENT}/evidence/restore-drills/${result}/$(date -u +%Y/%m)/${drill_id}"
  printf '%s  evidence.json\n' "$(openssl dgst -sha256 "${evidence}" | awk '{print $2}')" >"${evidence_checksum}" || return 1
  sign_evidence || return 1
  retention_until="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone

print((datetime.now(timezone.utc) + timedelta(days=2555)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)" || return 1
  for spec in "${evidence}:evidence.json:restore-drill" "${evidence_checksum}:evidence.json.sha256:checksum" "${evidence_signature}:evidence.json.sig.json:signature"; do
    path="${spec%%:*}"
    remainder="${spec#*:}"
    key_name="${remainder%%:*}"
    kind="${remainder##*:}"
    key="${prefix}/${key_name}"
    aws s3api put-object \
      --region "${BACKUP_EVIDENCE_REGION}" \
      --bucket "${BACKUP_EVIDENCE_BUCKET}" \
      --key "${key}" \
      --body "${path}" \
      --server-side-encryption aws:kms \
      --ssekms-key-id "${BACKUP_KMS_KEY_ID}" \
      --checksum-algorithm SHA256 \
      --object-lock-mode GOVERNANCE \
      --object-lock-retain-until-date "${retention_until}" \
      --metadata "environment=${BACKUP_ENVIRONMENT},kind=${kind},result=${result}" >/dev/null || return 1

    head_json="$(aws s3api head-object \
      --region "${BACKUP_EVIDENCE_REGION}" \
      --bucket "${BACKUP_EVIDENCE_BUCKET}" \
      --key "${key}" \
      --checksum-mode ENABLED)" || return 1
    encryption="$(jq -r '.ServerSideEncryption // empty' <<<"${head_json}")"
    kms_key="$(jq -r '.SSEKMSKeyId // empty' <<<"${head_json}")"
    stored_checksum="$(jq -r '.ChecksumSHA256 // empty' <<<"${head_json}")"
    object_lock_mode="$(jq -r '.ObjectLockMode // empty' <<<"${head_json}")"
    object_lock_until="$(jq -r '.ObjectLockRetainUntilDate // empty' <<<"${head_json}")"
    version_id="$(jq -r '.VersionId // empty' <<<"${head_json}")"
    actual_checksum="$(openssl dgst -sha256 -binary "${path}" | openssl base64 -A)"
    [[ "${encryption}" == "aws:kms" ]] || return 1
    [[ "${kms_key}" == "${BACKUP_KMS_KEY_ID}" ]] || return 1
    [[ "${stored_checksum}" == "${actual_checksum}" ]] || return 1
    [[ "${object_lock_mode}" == "GOVERNANCE" && -n "${object_lock_until}" ]] || return 1
    [[ -n "${version_id}" ]] || return 1
    log "verified evidence object s3://${BACKUP_EVIDENCE_BUCKET}/${key} version=${version_id}"
  done

  jq -n \
    --arg result "${result}" \
    --arg committed_at "$(date -u +%FT%TZ)" \
    --arg evidence_sha256 "$(openssl dgst -sha256 "${evidence}" | awk '{print $2}')" \
    --arg signature_sha256 "$(openssl dgst -sha256 "${evidence_signature}" | awk '{print $2}')" \
    '{commit_version:1,result:$result,committed_at:$committed_at,evidence_sha256:$evidence_sha256,signature_sha256:$signature_sha256}' \
    >"${evidence_commit}" || return 1
  aws s3api put-object \
    --region "${BACKUP_EVIDENCE_REGION}" \
    --bucket "${BACKUP_EVIDENCE_BUCKET}" \
    --key "${prefix}/complete.json" \
    --body "${evidence_commit}" \
    --server-side-encryption aws:kms \
    --ssekms-key-id "${BACKUP_KMS_KEY_ID}" \
    --checksum-algorithm SHA256 \
    --object-lock-mode GOVERNANCE \
    --object-lock-retain-until-date "${retention_until}" \
    --metadata "environment=${BACKUP_ENVIRONMENT},kind=restore-drill-commit,result=${result}" >/dev/null || return 1
  log "uploaded signed ${result} evidence to s3://${BACKUP_EVIDENCE_BUCKET}/${prefix}/"
}

destroy_recovered_data() {
  teardown_state="in_progress"
  docker rm --force "${container}" >/dev/null 2>&1 || true
  if docker container inspect "${container}" >/dev/null 2>&1; then
    teardown_state="failed"
    return 1
  fi

  docker volume rm --force "${volume}" "${wal_volume}" >/dev/null 2>&1 || true
  if docker volume inspect "${volume}" >/dev/null 2>&1 || docker volume inspect "${wal_volume}" >/dev/null 2>&1; then
    teardown_state="failed"
    return 1
  fi
  teardown_state="complete"
}

cleanup() {
  local status=$?
  local failed_stage="${current_stage}"
  local teardown_ok=false
  trap - EXIT INT TERM
  set +e

  if [[ "${status}" -ne 0 ]]; then
    docker logs "${container}" >"${workdir}/postgres.log" 2>&1 || true
  fi
  if [[ "${teardown_state}" == "complete" ]]; then
    teardown_ok=true
  elif [[ "${teardown_state}" == "not_started" ]]; then
    destroy_recovered_data && teardown_ok=true
  fi
  if [[ "${teardown_ok}" != "true" ]]; then
    status=1
    log "CRITICAL: recovered data teardown could not be verified; quarantine and securely remove volumes ${volume} and ${wal_volume}"
  fi

  if [[ "${status}" -ne 0 ]]; then
    jq -n \
      --arg drill_id "${drill_id}" \
      --arg operator_id "${DRILL_OPERATOR_ID}" \
      --arg environment "${BACKUP_ENVIRONMENT}" \
      --arg failed_stage "${failed_stage}" \
      --arg started_at "${started_at}" \
      --arg failed_at "$(date -u +%FT%TZ)" \
      --arg image "${BACKUP_IMAGE}" \
      --arg source "${WALG_S3_PREFIX}" \
      --arg database "${RESTORE_DATABASE_NAME}" \
      --arg source_region "${AWS_REGION}" \
      --arg evidence_region "${BACKUP_EVIDENCE_REGION}" \
      --arg target_time "${RECOVERY_TARGET_TIME}" \
      --arg recovery_volume "${volume}" \
      --arg wal_cache_volume "${wal_volume}" \
      --argjson exit_code "${status}" \
      --argjson recovered_data_destroyed "${teardown_ok}" \
      '{evidence_version:2,kind:"postgres_restore_drill",result:"failed",environment:$environment,drill_id:$drill_id,operator_id:$operator_id,failed_stage:$failed_stage,exit_code:$exit_code,started_at:$started_at,completed_at:$failed_at,backup_image:$image,database:$database,source_prefix:$source,source_region:$source_region,evidence_region:$evidence_region,recovery_target_time:$target_time,recovered_data_destroyed:$recovered_data_destroyed,recovery_volume:$recovery_volume,wal_cache_volume:$wal_cache_volume}' \
      >"${evidence}"
    upload_evidence failed || true
    aws cloudwatch put-metric-data --region "${BACKUP_METRIC_REGION}" --namespace Postwave/Backup \
      --metric-data "MetricName=RestoreDrillFailures,Value=1,Unit=Count,Dimensions=[{Name=Environment,Value=${BACKUP_ENVIRONMENT}}]" >/dev/null 2>&1 || true
  fi

  if [[ "${status}" -eq 0 ]]; then
    rm -rf "${workdir}"
  else
    log "preserving private failure evidence and PostgreSQL logs at ${workdir}; attach them to the incident, then securely remove them"
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

current_stage="verifying backup image signature"
cosign verify \
  --certificate-identity "${BACKUP_IMAGE_CERTIFICATE_IDENTITY}" \
  --certificate-oidc-issuer "${BACKUP_IMAGE_CERTIFICATE_OIDC_ISSUER}" \
  --output json \
  "${BACKUP_IMAGE}" >"${cosign_verification}"
jq -e 'type == "array" and length > 0' "${cosign_verification}" >/dev/null || fail "cosign returned no valid image signatures"

current_stage="validating AWS identity and pulling backup image"
aws sts get-caller-identity >/dev/null
docker pull "${BACKUP_IMAGE}" >/dev/null
resolved_local_image="$(docker image inspect --format '{{index .RepoDigests 0}}' "${BACKUP_IMAGE}")"
docker volume create --label postwave.purpose=destructive-restore-drill "${volume}" >/dev/null
docker volume create --label postwave.purpose=destructive-restore-drill "${wal_volume}" >/dev/null

current_stage="selecting an eligible physical base backup"
log "reading WAL-G catalog from ${WALG_S3_PREFIX}"
docker run --rm --user 999:999 "${docker_env_args[@]}" "${BACKUP_IMAGE}" \
  wal-g backup-list --detail --json >"${backup_list}"
[[ "$(jq 'length' "${backup_list}")" -gt 0 ]] || fail "WAL-G catalog has no base backups"

backup_selection="$(python3 "${SCRIPT_DIR}/select_walg_backup.py" "${backup_list}" "${RECOVERY_TARGET_TIME}")" || fail "no eligible WAL-G base backup exists for ${RECOVERY_TARGET_TIME}"
selected_backup_name="$(jq -r '.name' <<<"${backup_selection}")"
selected_backup="$(jq -c '.metadata' <<<"${backup_selection}")"
[[ "${selected_backup_name}" =~ ^base_[A-Za-z0-9._-]+$ ]] || fail "WAL-G returned an unsafe base-backup name"
log "selected base backup ${selected_backup_name} completed before the target"

[[ "${source_prefix}" =~ ^postgres/${BACKUP_ENVIRONMENT}/clusters/([a-z0-9][a-z0-9-]{2,62})/walg/?$ ]] || fail "WALG prefix does not identify one immutable Moosewave cluster generation"
selected_cluster_id="${BASH_REMATCH[1]}"
base_evidence_prefix="postgres/${BACKUP_ENVIRONMENT}/evidence/base-backups/${selected_backup_name}"
base_manifest="${workdir}/base-backup-manifest.json"
base_manifest_checksum="${workdir}/base-backup-manifest.json.sha256"
base_manifest_signature="${workdir}/base-backup-manifest.json.sig.json"
current_stage="verifying signed evidence for the selected physical base backup"
download_source_evidence "${base_evidence_prefix}/manifest.json" "${base_manifest}" || fail "selected base backup has no checksum-verified manifest in the recovery region"
download_source_evidence "${base_evidence_prefix}/manifest.json.sha256" "${base_manifest_checksum}" || fail "selected base backup manifest checksum is missing or invalid"
download_source_evidence "${base_evidence_prefix}/manifest.json.sig.json" "${base_manifest_signature}" || fail "selected base backup signature is missing or invalid"
expected_base_manifest_sha="$(awk 'NR == 1 {print $1}' "${base_manifest_checksum}")"
[[ "${expected_base_manifest_sha}" =~ ^[a-f0-9]{64}$ && "${expected_base_manifest_sha}" == "$(openssl dgst -sha256 "${base_manifest}" | awk '{print $2}')" ]] || fail "selected base backup manifest checksum does not match"
jq -e --arg environment "${BACKUP_ENVIRONMENT}" --arg cluster_id "${selected_cluster_id}" --arg backup_name "${selected_backup_name}" '
  .manifest_version == 2 and
  .kind == "postgres_walg_base_backup" and
  .environment == $environment and
  .cluster_id == $cluster_id and
  .page_checksums_verified == true and
  ((.latest_backup.backup_name // .latest_backup.BackupName // .latest_backup.name) == $backup_name) and
  (.postgres_system_identifier | type == "string" and test("^[0-9]{10,20}$")) and
  .wal_integrity.integrity.status == "OK" and
  .wal_integrity.timeline.status == "OK"
' "${base_manifest}" >/dev/null || fail "selected base backup manifest violates the recovery contract"
verify_evidence_signature "${base_manifest}" "${base_manifest_signature}" || fail "selected base backup manifest signature is invalid"
selected_base_manifest_sha="$(openssl dgst -sha256 "${base_manifest}" | awk '{print $2}')"

current_stage="verifying WAL continuity and timeline"
docker run --rm --user 999:999 "${docker_env_args[@]}" "${BACKUP_IMAGE}" \
  wal-g wal-verify integrity timeline --json >"${workdir}/wal-verify.json"
jq -e '.integrity.status == "OK" and .timeline.status == "OK"' "${workdir}/wal-verify.json" >/dev/null || fail "WAL integrity/timeline verification did not report OK"

archive_timestamp="$(aws s3api list-objects-v2 \
  --region "${AWS_REGION}" \
  --bucket "${source_bucket}" \
  --prefix "${source_prefix}/wal_005/" \
  --query 'reverse(sort_by(Contents,&LastModified))[0].LastModified' \
  --output text)"
[[ -n "${archive_timestamp}" && "${archive_timestamp}" != "None" ]] || fail "WAL-G archive contains no WAL objects"
archive_age_at_start="$(( started_epoch - $(parse_epoch "${archive_timestamp}") ))"
[[ "${archive_age_at_start}" -ge 0 ]] || archive_age_at_start=0

current_stage="fetching selected physical base backup"
restore_started_at="$(date -u +%FT%TZ)"
restore_started_epoch="$(date -u +%s)"
docker run --rm --user 0:0 --mount "type=volume,src=${volume},dst=/restore" "${BACKUP_IMAGE}" \
  install -d -o 999 -g 999 -m 0700 /restore/pgdata

log "destructively restoring selected signed base backup ${selected_backup_name} into isolated volume ${volume}"
docker run --rm --user 999:999 "${docker_env_args[@]}" \
  --mount "type=volume,src=${volume},dst=/restore" "${BACKUP_IMAGE}" \
  wal-g backup-fetch /restore/pgdata "${selected_backup_name}"

current_stage="staging checksum-verified WAL for offline replay"
docker run --rm --user 0:0 --mount "type=volume,src=${wal_volume},dst=/offline" "${BACKUP_IMAGE}" \
  install -d -o 999 -g 999 -m 0700 /offline/wal_005
docker run --rm --user 999:999 "${docker_env_args[@]}" \
  --mount "type=volume,src=${wal_volume},dst=/offline" "${BACKUP_IMAGE}" \
  aws s3 sync "${WALG_S3_PREFIX}/wal_005/" /offline/wal_005/ \
    --region "${AWS_REGION}" --checksum-mode ENABLED --only-show-errors
docker run --rm --user 999:999 --mount "type=volume,src=${wal_volume},dst=/offline,readonly" "${BACKUP_IMAGE}" \
  /bin/bash -euo pipefail -c 'find /offline/wal_005 -type f -print -quit | grep -q .'

docker run --rm --user 999:999 --mount "type=volume,src=${volume},dst=/restore" "${BACKUP_IMAGE}" \
  /bin/bash -euo pipefail -c "cat >>/restore/pgdata/postgresql.auto.conf <<'EOF'
restore_command = '/usr/local/bin/postwave-wal-fetch %f %p'
recovery_target_time = '${recovery_target_pg}'
recovery_target_timeline = 'latest'
recovery_target_action = 'promote'
EOF
touch /restore/pgdata/recovery.signal"

current_stage="replaying WAL to the requested target"
docker run --detach \
  --name "${container}" \
  --network none \
  --user 999:999 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,uid=999,gid=999 \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=999,gid=999 \
  --env PGDATA=/var/lib/postgresql/data/pgdata \
  --env WALG_FILE_PREFIX=/offline \
  --mount "type=volume,src=${volume},dst=/var/lib/postgresql/data" \
  --mount "type=volume,src=${wal_volume},dst=/offline,readonly" \
  "${BACKUP_IMAGE}" \
  postgres -c listen_addresses='' -c unix_socket_directories=/var/run/postgresql >/dev/null

deadline="$(( $(date -u +%s) + START_TIMEOUT_SECONDS ))"
until docker exec --user 999:999 "${container}" pg_isready --username=postgres --dbname="${RESTORE_DATABASE_NAME}" --timeout=2 >/dev/null 2>&1 &&
  [[ "$(docker exec --user 999:999 "${container}" psql --username=postgres --dbname="${RESTORE_DATABASE_NAME}" -Atqc 'SELECT pg_is_in_recovery()')" == "f" ]]; do
  [[ "$(date -u +%s)" -lt "${deadline}" ]] || fail "restore did not complete within ${START_TIMEOUT_SECONDS}s"
  [[ "$(docker inspect --format '{{.State.Running}}' "${container}")" == "true" ]] || fail "recovery PostgreSQL container exited"
  sleep 5
done

current_stage="verifying recovered database integrity"
"${SCRIPT_DIR}/verify-postgres-backup.sh" --container "${container}" --database "${RESTORE_DATABASE_NAME}" --output "${verification}"
verification_completed_epoch="$(date -u +%s)"
restore_duration_seconds="$(( verification_completed_epoch - restore_started_epoch ))"
caller_arn="$(aws sts get-caller-identity --query Arn --output text)"

current_stage="destroying isolated recovered data before success attestation"
destroy_recovered_data || fail "could not verify deletion of the recovered-data and offline-WAL volumes"
completed_at="$(date -u +%FT%TZ)"
completed_epoch="$(date -u +%s)"
drill_duration_seconds="$(( completed_epoch - started_epoch ))"

jq -n \
  --arg drill_id "${drill_id}" \
  --arg operator_id "${DRILL_OPERATOR_ID}" \
  --arg environment "${BACKUP_ENVIRONMENT}" \
  --arg caller_arn "${caller_arn}" \
  --arg started_at "${started_at}" \
  --arg completed_at "${completed_at}" \
  --arg restore_started_at "${restore_started_at}" \
  --arg image "${BACKUP_IMAGE}" \
  --arg resolved_local_image "${resolved_local_image}" \
  --arg certificate_identity "${BACKUP_IMAGE_CERTIFICATE_IDENTITY}" \
  --arg certificate_oidc_issuer "${BACKUP_IMAGE_CERTIFICATE_OIDC_ISSUER}" \
  --arg source "${WALG_S3_PREFIX}" \
  --arg database "${RESTORE_DATABASE_NAME}" \
  --arg source_region "${AWS_REGION}" \
  --arg evidence_region "${BACKUP_EVIDENCE_REGION}" \
  --arg source_archive_observed_at "${archive_timestamp}" \
  --arg target_time "${RECOVERY_TARGET_TIME}" \
  --arg selected_base_manifest_sha256 "${selected_base_manifest_sha}" \
  --argjson drill_duration_seconds "${drill_duration_seconds}" \
  --argjson restore_duration_seconds "${restore_duration_seconds}" \
  --argjson archive_age_at_start_seconds "${archive_age_at_start}" \
  --argjson selected_backup "${selected_backup}" \
  --slurpfile verification "${verification}" \
  '{
    evidence_version: 2,
    kind: "postgres_restore_drill",
    result: "passed",
    environment: $environment,
    drill_id: $drill_id,
    operator_id: $operator_id,
    aws_caller_arn: $caller_arn,
    started_at: $started_at,
    restore_started_at: $restore_started_at,
    completed_at: $completed_at,
    drill_duration_seconds: $drill_duration_seconds,
    database_restore_and_verification_duration_seconds: $restore_duration_seconds,
    backup_image: $image,
    resolved_local_image: $resolved_local_image,
    backup_image_signature: {
      verified: true,
      certificate_identity: $certificate_identity,
      certificate_oidc_issuer: $certificate_oidc_issuer
    },
    source_prefix: $source,
    database: $database,
    source_region: $source_region,
    evidence_region: $evidence_region,
    source_archive_observed_at: $source_archive_observed_at,
    source_archive_age_at_drill_start_seconds: $archive_age_at_start_seconds,
    recovery_target_time: $target_time,
    selected_base_backup: $selected_backup,
    selected_base_backup_manifest_sha256: $selected_base_manifest_sha256,
    selected_base_backup_signature_verified: true,
    wal_integrity_and_timeline_verified: true,
    recovery_network_mode: "none",
    cloud_credentials_exposed_to_recovered_database: false,
    offline_wal_staged_with_s3_checksum_validation: true,
    recovered_data_destroyed_before_signing: true,
    verification: $verification[0],
    notes: "Archive age and measured durations are observations, not contractual RPO/RTO."
  }' >"${evidence}"

current_stage="signing and retaining restore evidence"
upload_evidence passed
if ! aws cloudwatch put-metric-data \
  --region "${BACKUP_METRIC_REGION}" \
  --namespace Postwave/Backup \
  --metric-data \
    "MetricName=RestoreVerificationAgeSeconds,Value=0,Unit=Seconds,Dimensions=[{Name=Environment,Value=${BACKUP_ENVIRONMENT}}]" \
    "MetricName=RestoreDurationSeconds,Value=${restore_duration_seconds},Unit=Seconds,Dimensions=[{Name=Environment,Value=${BACKUP_ENVIRONMENT}}]" \
    "MetricName=MeasuredWalArchiveAgeSeconds,Value=${archive_age_at_start},Unit=Seconds,Dimensions=[{Name=Environment,Value=${BACKUP_ENVIRONMENT}}]"; then
  log "warning: signed success evidence is retained, but CloudWatch metric publication failed"
fi

log "restore drill ${drill_id} passed in ${drill_duration_seconds}s (database restore+verification ${restore_duration_seconds}s); recovered data was destroyed before success evidence was signed"
