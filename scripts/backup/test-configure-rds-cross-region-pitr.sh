#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/configure-rds-cross-region-pitr.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

SOURCE_ARN='arn:aws:rds:us-east-1:123456789012:db:postwave-prod'
REPLICA_KEY='arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111'

aws() {
  printf '%q ' "$@" >>"${AWS_MOCK_LOG}"
  printf '\n' >>"${AWS_MOCK_LOG}"
  case "$1 $2" in
    'sts get-caller-identity')
      printf '123456789012\n'
      ;;
    'rds describe-db-instances')
      if [[ "${AWS_MOCK_SCENARIO}" == source_bad ]]; then
        multi_az=false
      else
        multi_az=true
      fi
      printf '{"DBInstances":[{"DBInstanceArn":"%s","Engine":"postgres","DBName":"postwave","DBInstanceStatus":"available","MultiAZ":%s,"StorageEncrypted":true,"BackupRetentionPeriod":14,"BackupTarget":"region"}]}\n' \
        "${SOURCE_ARN}" "${multi_az}"
      ;;
    'kms describe-key')
      printf '{"KeyMetadata":{"Arn":"%s","Enabled":true,"KeyState":"Enabled","KeyManager":"CUSTOMER","KeyUsage":"ENCRYPT_DECRYPT"}}\n' "${REPLICA_KEY}"
      ;;
    'rds describe-source-regions')
      if [[ "${AWS_MOCK_SCENARIO}" == unsupported_region ]]; then
        supported=false
      else
        supported=true
      fi
      printf '{"SourceRegions":[{"RegionName":"us-east-1","Status":"available","SupportsDBInstanceAutomatedBackupsReplication":%s}]}\n' "${supported}"
      ;;
    'rds describe-db-instance-automated-backups')
      case "${AWS_MOCK_SCENARIO}" in
        existing)
          printf '{"DBInstanceAutomatedBackups":[{"DBInstanceArn":"%s","Engine":"postgres","Encrypted":true,"KmsKeyId":"%s","BackupRetentionPeriod":14,"Status":"active","RestoreWindow":{"LatestTime":"2026-07-14T09:00:00Z"}}]}\n' "${SOURCE_ARN}" "${REPLICA_KEY}"
          ;;
        existing_bad)
          printf '{"DBInstanceAutomatedBackups":[{"DBInstanceArn":"%s","Engine":"postgres","Encrypted":true,"KmsKeyId":"arn:aws:kms:us-west-2:123456789012:key/wrong","BackupRetentionPeriod":14,"Status":"active","RestoreWindow":{"LatestTime":"2026-07-14T09:00:00Z"}}]}\n' "${SOURCE_ARN}"
          ;;
        existing_pending)
          printf '{"DBInstanceAutomatedBackups":[{"DBInstanceArn":"%s","Engine":"postgres","Encrypted":true,"KmsKeyId":"%s","BackupRetentionPeriod":14,"Status":"pending","RestoreWindow":{}}]}\n' "${SOURCE_ARN}" "${REPLICA_KEY}"
          ;;
        *)
          printf '{"DBInstanceAutomatedBackups":[]}\n'
          ;;
      esac
      ;;
    'rds start-db-instance-automated-backups-replication')
      printf '{"DBInstanceAutomatedBackup":{"DBInstanceArn":"%s","Engine":"postgres","Encrypted":true,"KmsKeyId":"%s","BackupRetentionPeriod":14,"Status":"pending","DBInstanceAutomatedBackupsArn":"arn:aws:rds:us-west-2:123456789012:auto-backup:ab-test"}}\n' "${SOURCE_ARN}" "${REPLICA_KEY}"
      ;;
    *)
      echo "unexpected mocked AWS command: $*" >&2
      return 70
      ;;
  esac
}
export -f aws
export SOURCE_ARN REPLICA_KEY

run_subject() {
  "${SUBJECT}" \
    --source-db-arn "${SOURCE_ARN}" \
    --source-region us-east-1 \
    --replica-region us-west-2 \
    --replica-kms-key-arn "${REPLICA_KEY}" \
    "$@"
}

export AWS_MOCK_LOG="${WORKDIR}/aws.log"

export AWS_MOCK_SCENARIO=missing
run_subject >"${WORKDIR}/plan.out"
grep -q 'Plan only' "${WORKDIR}/plan.out"
! grep -q 'start-db-instance-automated-backups-replication' "${AWS_MOCK_LOG}"

: >"${AWS_MOCK_LOG}"
run_subject --apply >"${WORKDIR}/apply.out"
grep -q 'Enabled RDS automated-backup replication' "${WORKDIR}/apply.out"
grep -q 'start-db-instance-automated-backups-replication' "${AWS_MOCK_LOG}"

: >"${AWS_MOCK_LOG}"
export AWS_MOCK_SCENARIO=existing
run_subject >"${WORKDIR}/existing.out"
grep -q 'already matches: status=active' "${WORKDIR}/existing.out"
! grep -q 'start-db-instance-automated-backups-replication' "${AWS_MOCK_LOG}"

export AWS_MOCK_SCENARIO=existing_pending
if run_subject >"${WORKDIR}/pending.out" 2>"${WORKDIR}/pending.err"; then
  echo 'pending replication unexpectedly reported recoverable success' >&2
  exit 1
fi
grep -q 'not recoverable yet' "${WORKDIR}/pending.err"

export AWS_MOCK_SCENARIO=existing_bad
if run_subject >"${WORKDIR}/bad-existing.out" 2>"${WORKDIR}/bad-existing.err"; then
  echo 'mismatched existing replication unexpectedly passed' >&2
  exit 1
fi
grep -q 'refusing to stop or replace it automatically' "${WORKDIR}/bad-existing.err"

export AWS_MOCK_SCENARIO=source_bad
if run_subject >"${WORKDIR}/bad-source.out" 2>"${WORKDIR}/bad-source.err"; then
  echo 'non-Multi-AZ source unexpectedly passed' >&2
  exit 1
fi
grep -q 'source must be the available, encrypted, Multi-AZ PostgreSQL' "${WORKDIR}/bad-source.err"

export AWS_MOCK_SCENARIO=unsupported_region
if run_subject >"${WORKDIR}/unsupported-region.out" 2>"${WORKDIR}/unsupported-region.err"; then
  echo 'unsupported source/recovery Region pair unexpectedly passed' >&2
  exit 1
fi
grep -q 'does not support native automated-backup replication' "${WORKDIR}/unsupported-region.err"

if "${SUBJECT}" \
    --source-db-arn "${SOURCE_ARN}" \
    --source-region us-east-1 \
    --replica-region us-east-1 \
    --replica-kms-key-arn "${REPLICA_KEY}" \
    >"${WORKDIR}/bad-region.out" 2>"${WORKDIR}/bad-region.err"; then
  echo 'same-Region replication unexpectedly passed' >&2
  exit 1
fi
grep -q 'source and recovery Regions must differ' "${WORKDIR}/bad-region.err"

printf 'RDS cross-Region PITR configuration tests passed\n'
