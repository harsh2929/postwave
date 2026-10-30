#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

SOURCE_DB_ARN=""
SOURCE_REGION=""
REPLICA_REGION=""
REPLICA_KMS_KEY_ARN=""
ENVIRONMENT="prod"
DATABASE_NAME="postwave"
RETENTION_DAYS="14"
APPLY=0

usage() {
  cat <<'EOF'
Usage: configure-rds-cross-region-pitr.sh \
  --source-db-arn ARN \
  --source-region REGION \
  --replica-region REGION \
  --replica-kms-key-arn ARN \
  [--environment prod] [--database postwave] [--retention-days 14] [--apply]

Without --apply, validates both Regions and prints the change that would be
made. Existing replication is never stopped or replaced: a mismatched existing
configuration fails closed and requires a separately approved change window.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-db-arn) SOURCE_DB_ARN="$2"; shift 2 ;;
    --source-region) SOURCE_REGION="$2"; shift 2 ;;
    --replica-region) REPLICA_REGION="$2"; shift 2 ;;
    --replica-kms-key-arn) REPLICA_KMS_KEY_ARN="$2"; shift 2 ;;
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --database) DATABASE_NAME="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

for name in SOURCE_DB_ARN SOURCE_REGION REPLICA_REGION REPLICA_KMS_KEY_ARN; do
  [[ -n "${!name}" ]] || { echo "missing required option for ${name}" >&2; exit 64; }
done

for command_name in aws jq; do
  command -v "${command_name}" >/dev/null 2>&1 || { echo "required command not found: ${command_name}" >&2; exit 69; }
done

PARTITION='aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b'
[[ "${SOURCE_DB_ARN}" =~ ^arn:(${PARTITION}):rds:([a-z0-9-]+):([0-9]{12}):db:([A-Za-z0-9-]+)$ ]] || {
  echo "--source-db-arn must identify an RDS DB instance, not a cluster" >&2
  exit 64
}
arn_partition="${BASH_REMATCH[1]}"
arn_source_region="${BASH_REMATCH[2]}"
arn_account="${BASH_REMATCH[3]}"
db_identifier="${BASH_REMATCH[4]}"

[[ "${SOURCE_REGION}" == "${arn_source_region}" ]] || { echo "source ARN Region does not match --source-region" >&2; exit 64; }
[[ "${SOURCE_REGION}" != "${REPLICA_REGION}" ]] || { echo "source and recovery Regions must differ" >&2; exit 64; }
for region in "${SOURCE_REGION}" "${REPLICA_REGION}"; do
  [[ "${region}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || { echo "invalid AWS Region: ${region}" >&2; exit 64; }
done
[[ "${REPLICA_KMS_KEY_ARN}" =~ ^arn:(${PARTITION}):kms:([a-z0-9-]+):([0-9]{12}):key/[A-Za-z0-9-]+$ ]] || {
  echo "--replica-kms-key-arn must be a customer-managed KMS key ARN" >&2
  exit 64
}
[[ "${BASH_REMATCH[1]}" == "${arn_partition}" && "${BASH_REMATCH[2]}" == "${REPLICA_REGION}" && "${BASH_REMATCH[3]}" == "${arn_account}" ]] || {
  echo "replica KMS key must be in the recovery Region and source account/partition" >&2
  exit 64
}
[[ "${ENVIRONMENT}" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "invalid environment" >&2; exit 64; }
[[ "${DATABASE_NAME}" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || { echo "invalid database name" >&2; exit 64; }
[[ "${RETENTION_DAYS}" =~ ^[0-9]+$ && "${RETENTION_DAYS}" -ge 1 && "${RETENTION_DAYS}" -le 35 ]] || {
  echo "--retention-days must be an integer from 1 through 35" >&2
  exit 64
}

caller_account="$(aws sts get-caller-identity --query Account --output text)"
[[ "${caller_account}" == "${arn_account}" ]] || { echo "AWS caller account does not own the source DB ARN" >&2; exit 77; }

source_json="$(aws rds describe-db-instances \
  --region "${SOURCE_REGION}" \
  --db-instance-identifier "${db_identifier}" \
  --output json)"

jq -e \
  --arg arn "${SOURCE_DB_ARN}" \
  --arg database "${DATABASE_NAME}" \
  '.DBInstances | length == 1 and
   .[0].DBInstanceArn == $arn and
   .[0].Engine == "postgres" and
   .[0].DBName == $database and
   .[0].DBInstanceStatus == "available" and
   .[0].MultiAZ == true and
   .[0].StorageEncrypted == true and
   .[0].BackupRetentionPeriod > 0 and
   (.[0].BackupTarget // "region") == "region"' \
  <<<"${source_json}" >/dev/null || {
    echo "source must be the available, encrypted, Multi-AZ PostgreSQL ${DATABASE_NAME} DB with native backups enabled and BackupTarget=region" >&2
    exit 65
  }

key_json="$(aws kms describe-key \
  --region "${REPLICA_REGION}" \
  --key-id "${REPLICA_KMS_KEY_ARN}" \
  --output json)"
jq -e \
  --arg arn "${REPLICA_KMS_KEY_ARN}" \
  '.KeyMetadata.Arn == $arn and
   .KeyMetadata.Enabled == true and
   .KeyMetadata.KeyState == "Enabled" and
   .KeyMetadata.KeyManager == "CUSTOMER" and
   .KeyMetadata.KeyUsage == "ENCRYPT_DECRYPT"' \
  <<<"${key_json}" >/dev/null || {
    echo "recovery key must be the exact enabled customer-managed ENCRYPT_DECRYPT key ARN" >&2
    exit 65
  }

source_regions_json="$(aws rds describe-source-regions \
  --region "${REPLICA_REGION}" \
  --region-name "${SOURCE_REGION}" \
  --output json)"
jq -e \
  --arg source_region "${SOURCE_REGION}" \
  '.SourceRegions | length == 1 and
   .[0].RegionName == $source_region and
   .[0].Status == "available" and
   .[0].SupportsDBInstanceAutomatedBackupsReplication == true' \
  <<<"${source_regions_json}" >/dev/null || {
    echo "source Region does not support native automated-backup replication into the recovery Region" >&2
    exit 65
  }

existing_json="$(aws rds describe-db-instance-automated-backups \
  --region "${REPLICA_REGION}" \
  --output json)"
matching_count="$(jq --arg arn "${SOURCE_DB_ARN}" '[.DBInstanceAutomatedBackups[]? | select(.DBInstanceArn == $arn)] | length' <<<"${existing_json}")"
[[ "${matching_count}" -le 1 ]] || { echo "multiple replicated automated-backup records matched the source ARN" >&2; exit 65; }

if [[ "${matching_count}" -eq 1 ]]; then
  jq -e \
    --arg arn "${SOURCE_DB_ARN}" \
    --arg kms "${REPLICA_KMS_KEY_ARN}" \
    --argjson retention "${RETENTION_DAYS}" \
    '[.DBInstanceAutomatedBackups[] | select(.DBInstanceArn == $arn)] | length == 1 and
     .[0].Engine == "postgres" and
     .[0].Encrypted == true and
     .[0].KmsKeyId == $kms and
     .[0].BackupRetentionPeriod == $retention and
     (.[0].Status == "active" or .[0].Status == "creating" or .[0].Status == "pending")' \
    <<<"${existing_json}" >/dev/null || {
      echo "existing cross-Region automated-backup replication does not match the requested key/retention/source" >&2
      echo "refusing to stop or replace it automatically; use a separately reviewed change window" >&2
      exit 65
    }
  status="$(jq -r --arg arn "${SOURCE_DB_ARN}" '.DBInstanceAutomatedBackups[] | select(.DBInstanceArn == $arn) | .Status' <<<"${existing_json}")"
  latest="$(jq -r --arg arn "${SOURCE_DB_ARN}" '.DBInstanceAutomatedBackups[] | select(.DBInstanceArn == $arn) | .RestoreWindow.LatestTime // "not-yet-available"' <<<"${existing_json}")"
  printf 'RDS automated-backup replication already matches: status=%s latest_restore_time=%s\n' "${status}" "${latest}"
  if [[ "${status}" != "active" || "${latest}" == "not-yet-available" ]]; then
    echo "matching replication is not recoverable yet; rerun until status=active and latest_restore_time is present" >&2
    exit 75
  fi
  exit 0
fi

printf 'Validated source %s and recovery key %s.\n' "${SOURCE_DB_ARN}" "${REPLICA_KMS_KEY_ARN}"
if [[ "${APPLY}" -ne 1 ]]; then
  printf 'Plan only: rerun with --apply to enable %s-day native automated-backup replication in %s.\n' "${RETENTION_DAYS}" "${REPLICA_REGION}"
  exit 0
fi

result_json="$(aws rds start-db-instance-automated-backups-replication \
  --region "${REPLICA_REGION}" \
  --source-region "${SOURCE_REGION}" \
  --source-db-instance-arn "${SOURCE_DB_ARN}" \
  --backup-retention-period "${RETENTION_DAYS}" \
  --kms-key-id "${REPLICA_KMS_KEY_ARN}" \
  --tags "Key=project,Value=postwave" "Key=environment,Value=${ENVIRONMENT}" "Key=purpose,Value=cross-region-pitr" \
  --output json)"

jq -e \
  --arg arn "${SOURCE_DB_ARN}" \
  --arg kms "${REPLICA_KMS_KEY_ARN}" \
  --argjson retention "${RETENTION_DAYS}" \
  '.DBInstanceAutomatedBackup.DBInstanceArn == $arn and
   .DBInstanceAutomatedBackup.Engine == "postgres" and
   .DBInstanceAutomatedBackup.KmsKeyId == $kms and
   .DBInstanceAutomatedBackup.Encrypted == true and
   .DBInstanceAutomatedBackup.BackupRetentionPeriod == $retention and
   (.DBInstanceAutomatedBackup.Status == "active" or
    .DBInstanceAutomatedBackup.Status == "creating" or
    .DBInstanceAutomatedBackup.Status == "pending")' \
  <<<"${result_json}" >/dev/null || {
    echo "AWS accepted the request but returned an unexpected replication configuration" >&2
    exit 70
  }

status="$(jq -r '.DBInstanceAutomatedBackup.Status' <<<"${result_json}")"
replication_arn="$(jq -r '.DBInstanceAutomatedBackup.DBInstanceAutomatedBackupsArn' <<<"${result_json}")"
[[ "${replication_arn}" =~ ^arn:(${PARTITION}):rds:${REPLICA_REGION}:${arn_account}:auto-backup:ab-[A-Za-z0-9-]+$ ]] || {
  echo "AWS accepted the request but returned an invalid replicated automated-backup ARN" >&2
  exit 70
}
printf 'Enabled RDS automated-backup replication: status=%s arn=%s\n' "${status}" "${replication_arn}"
printf 'Rerun this command without --apply until status=active and a latest restore time is present.\n'
