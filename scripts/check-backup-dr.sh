#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

fail() { printf 'backup/DR gate failed: %s\n' "$*" >&2; exit 1; }
require_text() {
  local file="$1"
  local pattern="$2"
  grep -Eq -- "${pattern}" "${file}" || fail "${file} is missing required contract: ${pattern}"
}
forbid_text() {
  local file="$1"
  local pattern="$2"
  if grep -Eiq -- "${pattern}" "${file}"; then
    fail "${file} contains forbidden/unsupported contract: ${pattern}"
  fi
}

for script in infra/backup/*.sh infra/backup/image/*.sh scripts/backup/*.sh; do
  bash -n "${script}"
done
bash -n scripts/update/preflight.sh
python3 scripts/backup/test_select_walg_backup.py
python3 scripts/backup/test-rds-dr-monitor.py
scripts/backup/test-configure-rds-cross-region-pitr.sh
scripts/backup/test-export-evidence-public-key.sh
scripts/backup/test-verify-r2-backup.sh

# Psych, CloudFormation validators, and several other YAML loaders accept a
# duplicate mapping key by silently keeping only the last value. Reject that
# ambiguity before schema validation so an IAM or storage control cannot be
# hidden by parser behaviour.
ruby - \
  .github/workflows/backup-dr.yml \
  infra/backup/aws-backup-dr.yaml \
  infra/backup/aws-dns-failover.yaml \
  infra/backup/aws-rds-dr.yaml \
  infra/backup/postgres-backup-cronjob.yaml \
  infra/backup/postgres-pitr-config.yaml \
  infra/backup/postgres-statefulset-patch.yaml <<'RUBY'
require "psych"

def check_node(node, file)
  return if node.nil?

  if node.is_a?(Psych::Nodes::Mapping)
    seen = {}
    node.children.each_slice(2) do |key, value|
      if key.is_a?(Psych::Nodes::Scalar)
        if seen.key?(key.value)
          abort "#{file}:#{key.start_line + 1}: duplicate YAML key #{key.value.inspect}"
        end
        seen[key.value] = true
      end
      check_node(key, file)
      check_node(value, file)
    end
  elsif node.respond_to?(:children)
    Array(node.children).each { |child| check_node(child, file) }
  end
end

ARGV.each do |file|
  stream = Psych.parse_stream(File.read(file), filename: file)
  check_node(stream, file)
end
RUBY

require_text infra/backup/image/Dockerfile '^ARG POSTGRES_IMAGE="postgres:[0-9.]+-alpine[0-9.]+@sha256:[a-f0-9]{64}"$'
require_text infra/backup/image/Dockerfile '^ARG GO_IMAGE="golang:[0-9.]+-trixie@sha256:[a-f0-9]{64}"$'
require_text infra/backup/image/Dockerfile '^ARG WALG_COMMIT="[a-f0-9]{40}"$'
require_text infra/backup/image/Dockerfile '^ARG WALG_SOURCE_SHA256="[a-f0-9]{64}"$'
require_text infra/backup/image/Dockerfile '^ARG WALG_VERSION="v[0-9]+\.[0-9]+\.[0-9]+\+postwave\.[0-9]+"$'
require_text infra/backup/image/Dockerfile '^ARG AWSCLI_APK_VERSION="[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+"$'
require_text infra/backup/image/Dockerfile '^ARG OPENSSL_APK_VERSION="3\.5\.8-r0"$'
require_text infra/backup/image/Dockerfile '^ARG LIBUUID_APK_VERSION="2\.41\.6-r1"$'
require_text infra/backup/image/Dockerfile '"libuuid=\$\{LIBUUID_APK_VERSION\}"'
require_text infra/backup/image/Dockerfile 'sha256sum --check --strict'
require_text infra/backup/image/Dockerfile 'aws s3 cp /etc/hosts .* --checksum-algorithm SHA256 --dryrun'
require_text infra/backup/image/base-backup-once.sh 'backup-push --verify'
require_text infra/backup/image/base-backup-once.sh 'wal-verify integrity timeline'
require_text infra/backup/image/base-backup-once.sh 'SHOW data_checksums'
require_text infra/backup/image/base-backup-once.sh 'pg_control_system'
require_text infra/backup/image/base-backup-once.sh 'postwave_backup_id'
forbid_text infra/backup/image/base-backup-once.sh '^[[:space:]]*wal-g delete'
require_text infra/backup/image/sign-base-backup-evidence.sh 'sign_file'
require_text infra/backup/image/sign-base-backup-evidence.sh 'MAX_UNSIGNED_BASE_EVIDENCE_BACKLOG'
require_text infra/backup/image/sign-base-backup-evidence.sh 'verify_manifest_signature'
require_text infra/backup/image/sign-base-backup-evidence.sh 'health/base-backup-signed/latest.json'
require_text infra/backup/image/wal-push-wrapper.sh 'POSTGRES_SYSTEM_IDENTIFIER'
require_text infra/backup/image/logical-backup.sh 'checksum-algorithm SHA256|upload_evidence_file'
require_text infra/backup/image/common.sh 'aws s3 cp'
require_text infra/backup/image/common.sh 'checksum-algorithm SHA256'
require_text infra/backup/image/common.sh 'Metadata.sha256'
require_text infra/backup/image/common.sh 'object-lock-retain-until-date'
require_text infra/backup/image/monitor-backups.sh 'BackupReplicationLagSeconds'
require_text infra/backup/image/monitor-backups.sh 'RestoreVerificationAgeSeconds'
require_text infra/backup/image/monitor-backups.sh 'restore-drills/passed/'
require_text infra/backup/image/monitor-backups.sh 'replication-canary/latest.json'
require_text infra/backup/image/monitor-backups.sh 'metric_for_latest_signed_base'
forbid_text infra/backup/image/monitor-backups.sh 'metric_for_latest BaseBackupAgeSeconds'
require_text infra/backup/image/monitor-wal-integrity.sh 'wal-verify integrity timeline'
require_text infra/backup/image/wal-fetch-wrapper.sh '0\|74\) exit'
require_text infra/backup/image/wal-fetch-wrapper.sh '\*\) exit 126'
require_text infra/backup/postgres-statefulset-patch.yaml 'replicas: 1'
require_text infra/backup/postgres-statefulset-patch.yaml 'archive_command=/usr/local/bin/postwave-wal-push %p'
require_text infra/backup/postgres-statefulset-patch.yaml 'name: postgres'
require_text infra/backup/postgres-statefulset-patch.yaml 'image: "__BACKUP_IMAGE__"'
require_text infra/backup/postgres-statefulset-patch.yaml 'name: postgres-data'
require_text infra/backup/postgres-statefulset-patch.yaml 'mountPath: /var/lib/postgresql/data'
require_text infra/backup/postgres-statefulset-patch.yaml 'readOnly: true'
require_text infra/backup/postgres-statefulset-patch.yaml 'value: postwave'
forbid_text infra/backup/postgres-pitr-config.yaml 'curl|apk add|apt-get|image: postgres:'
forbid_text infra/backup/postgres-backup-cronjob.yaml 'curl|apk add|apt-get|image: postgres:'

require_text infra/backup/aws-backup-dr.yaml 'ObjectLockEnabled: true'
require_text infra/backup/aws-backup-dr.yaml 'ReplicationConfiguration:'
require_text infra/backup/aws-backup-dr.yaml 'SseKmsEncryptedObjects:'
require_text infra/backup/aws-backup-dr.yaml 'OperationsFailedReplication'
require_text infra/backup/aws-backup-dr.yaml 'PrimaryBackupBucketName:'
require_text infra/backup/aws-backup-dr.yaml 'ReplicaBackupBucketName:'
require_text infra/backup/aws-backup-dr.yaml 'RestoreDrillEvidenceManagedPolicyArn:'
require_text infra/backup/aws-backup-dr.yaml 'BackupEvidenceSignerManagedPolicyArn:'
require_text infra/backup/aws-backup-dr.yaml 'DeletionPolicy: Retain'
require_text infra/backup/aws-backup-dr.yaml 'AssertDescription: Primary mode requires an operator-owned on-call AlarmTopicArn'
for metric in BaseBackupAgeSeconds LogicalBackupAgeSeconds WalArchiveAgeSeconds WalIntegrityHealthy BackupReplicationLagSeconds RestoreVerificationAgeSeconds; do
  require_text infra/backup/aws-backup-dr.yaml "MetricName: ${metric}"
done
for metric in BackupMonitorSuccess WalIntegrityMonitorSuccess EvidenceSignerSuccess BackupJobFailures RestoreDrillFailures; do
  require_text infra/backup/aws-backup-dr.yaml "MetricName: ${metric}"
done
require_text infra/backup/aws-dns-failover.yaml 'Failover: PRIMARY'
require_text infra/backup/aws-dns-failover.yaml 'Failover: SECONDARY'
require_text infra/backup/aws-dns-failover.yaml 'EvaluateTargetHealth: true'
require_text infra/backup/aws-dns-failover.yaml 'Primary and secondary failover records must target different ALBs'

require_text infra/backup/aws-rds-dr.yaml 'LockConfiguration:'
require_text infra/backup/aws-rds-dr.yaml 'ChangeableForDays:'
require_text infra/backup/aws-rds-dr.yaml 'Type: AWS::Backup::BackupSelection'
require_text infra/backup/aws-rds-dr.yaml 'CopyActions:'
require_text infra/backup/aws-rds-dr.yaml 'Resources:'
require_text infra/backup/aws-rds-dr.yaml 'NativeRdsReplicationLagSeconds'
require_text infra/backup/aws-rds-dr.yaml 'NativeRdsReplicationValid'
require_text infra/backup/aws-rds-dr.yaml 'RdsBackupReplicaAgeSeconds'
require_text infra/backup/aws-rds-dr.yaml 'RdsBackupReplicaValid'
require_text infra/backup/aws-rds-dr.yaml 'Recovery-Region RDS backup monitor invocation failed'
require_text infra/backup/aws-rds-dr.yaml 'DeletionPolicy: Retain'
require_text infra/backup/aws-rds-dr.yaml 'rds:DescribeDBInstanceAutomatedBackups'
require_text infra/backup/aws-rds-dr.yaml 'backup:ListRecoveryPointsByBackupVault'
require_text infra/backup/aws-rds-dr.yaml 'tag:GetResources'
require_text infra/backup/aws-rds-dr.yaml 'for page in paginator\.paginate\(\):'
require_text infra/backup/aws-rds-dr.yaml 'expected_source_vault'
forbid_text infra/backup/aws-rds-dr.yaml 'AWSBackupServiceRolePolicyForBackup'
forbid_text infra/backup/aws-rds-dr.yaml 'paginator\.paginate\(DBInstanceIdentifier='
forbid_text infra/backup/aws-rds-dr.yaml 'source_vault_prefix|SourceBackupVaultArn.*startswith'
forbid_text infra/backup/aws-rds-dr.yaml 'aws:Source(Account|Arn)'

require_text scripts/backup/restore-drill.sh 'backup-fetch /restore/pgdata "\$\{selected_backup_name\}"'
require_text scripts/backup/restore-drill.sh "recovery_target_time ="
require_text scripts/backup/restore-drill.sh 'network_isolated|--network'
require_text scripts/backup/restore-drill.sh 'kms verify'
require_text scripts/backup/restore-drill.sh 'cosign verify'
require_text scripts/backup/restore-drill.sh 'wal-verify integrity timeline'
require_text scripts/backup/restore-drill.sh 'object-lock-retain-until-date'
require_text scripts/backup/restore-drill.sh 'docker volume rm --force'
require_text scripts/backup/restore-drill.sh 'recovered_data_destroyed_before_signing: true'
require_text scripts/backup/restore-drill.sh '\-\-network none'
require_text scripts/backup/restore-drill.sh 'WALG_FILE_PREFIX=/offline'
require_text scripts/backup/restore-drill.sh 'complete.json'
require_text scripts/backup/restore-drill.sh 'preserving private failure evidence and PostgreSQL logs'
require_text scripts/backup/restore-drill.sh 'backup KMS identifiers must be key ARNs'
forbid_text scripts/backup/restore-drill.sh 'NEON_|neon snapshots|branches/'
forbid_text scripts/backup/restore-drill.sh '(-p|--publish)[ =]'
forbid_text scripts/backup/restore-drill.sh 'backup-fetch /restore/pgdata LATEST'
forbid_text scripts/backup/restore-drill.sh '--network "\$\{network\}"'
require_text scripts/backup/test-base-evidence-signer.sh 'invalid existing signature'

require_text infra/backup/restore.sh 'backup-version-id'
require_text infra/backup/restore.sh 'confirm-isolated-target'
require_text infra/backup/restore.sh 'expected-migration'
require_text infra/backup/restore.sh 'PRODUCTION_DB_HOST'
require_text infra/backup/restore.sh 'kms verify'
require_text infra/backup/restore.sh '\.manifest_version == 2'
require_text infra/backup/restore.sh 'row_counts_are_transactionally_bound_to_dump == false'
require_text infra/backup/restore.sh 'restored migration .* does not match the selected application migration'
require_text infra/backup/restore.sh 'tenant-scoped tables lost enabled and forced RLS'
require_text infra/backup/restore.sh 'LEGACY_RESTORE_APPROVAL.*I_ACCEPT_UNSIGNED_LEGACY_ARTIFACT_RISK'
require_text infra/backup/restore.sh 'LEGACY_RESTORE_TICKET'
forbid_text infra/backup/restore.sh 'CREATE ROLE|CREATE USER|postwave_app LOGIN'
require_text scripts/backup/create-postgres-backup.sh 'manifest_version: 2'
require_text scripts/backup/create-postgres-backup.sh 'row_counts_are_transactionally_bound_to_dump: false'
forbid_text scripts/update/preflight.sh '--database-url[[:space:]]+"\$\{DATABASE_URL\}"'
require_text scripts/backup/run-self-hosted-backup.sh 'DATABASE_URL_FILE'
require_text scripts/backup/run-self-hosted-backup.sh 'flock -n'
require_text scripts/backup/run-self-hosted-backup.sh 'checksum-algorithm SHA256'
require_text scripts/backup/run-self-hosted-backup.sh 'sse aws:kms'
require_text scripts/backup/run-self-hosted-backup.sh 'SELF_HOST_BACKUP_KMS_KEY_ID must be a KMS key ARN'
require_text scripts/backup/run-self-hosted-backup.sh 'invalid SELF_HOST_BACKUP_BUCKET'
require_text scripts/backup/verify-r2-backup.sh 'R2_ACCESS_KEY_ID'
require_text scripts/backup/verify-r2-backup.sh 'ambient AWS credentials are refused'
require_text scripts/backup/verify-r2-backup.sh 'cloudflarestorage\\.com'
require_text scripts/backup/verify-r2-backup.sh 'R2 backup inventory is empty or invalid'
require_text scripts/backup/verify-r2-backup.sh 'Advance the baseline only after'
require_text scripts/backup/configure-rds-cross-region-pitr.sh 'start-db-instance-automated-backups-replication'
require_text scripts/backup/configure-rds-cross-region-pitr.sh 'describe-source-regions'
require_text scripts/backup/configure-rds-cross-region-pitr.sh 'source and recovery Regions must differ'
require_text scripts/backup/configure-rds-cross-region-pitr.sh 'refusing to stop or replace it automatically'
require_text scripts/backup/configure-rds-cross-region-pitr.sh 'matching replication is not recoverable yet'
forbid_text scripts/backup/configure-rds-cross-region-pitr.sh 'stop-db-instance-automated-backups-replication'
require_text scripts/backup/export-evidence-public-key.sh '"\$\{OUTPUT\}\.der"'
require_text scripts/backup/export-evidence-public-key.sh 'DER checksum'

rendered="$(mktemp -d -t postwave-backup-render.XXXXXX)"
trap 'rm -rf "${rendered}"' EXIT
infra/backup/render-manifests.sh \
  --output-dir "${rendered}" \
  --image ghcr.io/postwave/postwave-backup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bucket postwave-prod-backups-example \
  --replica-bucket postwave-prod-backups-replica-example \
  --kms-key-id arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111 \
  --evidence-signing-key-id arn:aws:kms:us-west-2:123456789012:key/22222222-2222-2222-2222-222222222222 \
  --writer-role-arn arn:aws:iam::123456789012:role/postwave-prod-backup \
  --signer-role-arn arn:aws:iam::123456789012:role/postwave-prod-backup-signer \
  --region us-west-2 \
  --replica-region us-east-1 \
  --environment prod \
  --cluster-id prod-20260714-a \
  --system-identifier 7412345678901234567 >/dev/null

if grep -R -n -E '__[A-Z0-9_]+__' "${rendered}"; then
  fail "rendered manifests retain substitution tokens"
fi
image_count="$(grep -Rho 'image: "[^\"]*"' "${rendered}" | wc -l | tr -d ' ')"
digest_count="$(grep -Rho 'image: "[^\"]*@sha256:[a-f0-9]\{64\}"' "${rendered}" | wc -l | tr -d ' ')"
[[ "${image_count}" -eq "${digest_count}" && "${image_count}" -gt 0 ]] || fail "every rendered backup image must be digest-pinned"

ruby -e 'require "yaml"; ARGV.each { |f| abort("empty YAML: #{f}") if YAML.load_stream(File.read(f)).empty? }' "${rendered}"/*.yaml

if infra/backup/render-manifests.sh \
  --output-dir "${rendered}/invalid" \
  --image ghcr.io/postwave/postwave-backup:latest \
  --bucket postwave-prod-backups-example \
  --replica-bucket postwave-prod-backups-replica-example \
  --kms-key-id arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111 \
  --evidence-signing-key-id arn:aws:kms:us-west-2:123456789012:key/22222222-2222-2222-2222-222222222222 \
  --writer-role-arn arn:aws:iam::123456789012:role/postwave-prod-backup \
  --signer-role-arn arn:aws:iam::123456789012:role/postwave-prod-backup-signer \
  --region us-west-2 --replica-region us-east-1 --environment prod \
  --cluster-id prod-20260714-a --system-identifier 7412345678901234567 >/dev/null 2>&1; then
  fail "manifest renderer accepted a mutable image tag"
fi

if infra/backup/render-manifests.sh \
  --output-dir "${rendered}/same-region" \
  --image ghcr.io/postwave/postwave-backup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bucket postwave-prod-backups-example \
  --replica-bucket postwave-prod-backups-example \
  --kms-key-id arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111 \
  --evidence-signing-key-id arn:aws:kms:us-west-2:123456789012:key/22222222-2222-2222-2222-222222222222 \
  --writer-role-arn arn:aws:iam::123456789012:role/postwave-prod-backup \
  --signer-role-arn arn:aws:iam::123456789012:role/postwave-prod-backup-signer \
  --region us-west-2 --replica-region us-west-2 --environment prod \
  --cluster-id prod-20260714-a --system-identifier 7412345678901234567 >/dev/null 2>&1; then
  fail "manifest renderer accepted identical primary/replica storage and regions"
fi

if infra/backup/render-manifests.sh \
  --output-dir "${rendered}/cross-account" \
  --image ghcr.io/postwave/postwave-backup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bucket postwave-prod-backups-example \
  --replica-bucket postwave-prod-backups-replica-example \
  --kms-key-id arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111 \
  --evidence-signing-key-id arn:aws:kms:us-west-2:123456789012:key/22222222-2222-2222-2222-222222222222 \
  --writer-role-arn arn:aws:iam::999999999999:role/postwave-prod-backup \
  --signer-role-arn arn:aws:iam::123456789012:role/postwave-prod-backup-signer \
  --region us-west-2 --replica-region us-east-1 --environment prod \
  --cluster-id prod-20260714-a --system-identifier 7412345678901234567 >/dev/null 2>&1; then
  fail "manifest renderer accepted a cross-account workload role"
fi

if command -v cfn-lint >/dev/null 2>&1; then
  cfn-lint infra/backup/aws-backup-dr.yaml infra/backup/aws-dns-failover.yaml infra/backup/aws-rds-dr.yaml
else
  printf 'warning: cfn-lint unavailable; CI performs CloudFormation schema validation\n' >&2
fi

for doc in infra/backup/README.md docs/DISASTER-RECOVERY.md docs/runbooks/disaster-recovery.md docs/runbooks/backup-quarterly-test.md docs/runbooks/rds-cross-region-backup.md scripts/backup/README.md apps/web/content/blog/gdpr-data-residency-for-newsletters.mdx; do
  forbid_text "${doc}" '(^|[^[:alnum:]])(30[- ]second|30s|sub-minute)[[:space:]]+RPO'
  forbid_text "${doc}" '(^|[^[:alnum:]])(2h|two[- ]hour|2 hour)[[:space:]]+RTO'
  forbid_text "${doc}" 'RPO[^.\n]*(commitment|guarantee|approximately 30)'
  forbid_text "${doc}" 'RTO[^.\n]*(commitment|guarantee|30-120)'
done

printf 'backup/DR static gate passed\n'
