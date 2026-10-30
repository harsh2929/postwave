# Runbook — canonical RDS cross-Region backup and PITR

Owner: Platform/SRE. Database owner and Security approve retention, key-policy,
restore, and teardown changes. This runbook applies to the canonical encrypted
Multi-AZ PostgreSQL **DB instance** named `postwave-prod`; it does not apply to
an RDS Multi-AZ DB cluster.

## Evidence status

The repository contains linted CloudFormation, a fail-closed configuration
script with mocked tests, and monitoring logic. No AWS account was available
during repository validation, so deployment, copy completion, native
cross-Region PITR, alarm delivery, and an isolated production-scale restore are
still release evidence gates. Do not infer an RPO or RTO from the configured
cadence or alarm thresholds.

## Recovery layers

| Layer | Purpose | Important limit |
|---|---|---|
| RDS automated backups in the primary Region | Native PITR for the main database | Shares the primary Region. |
| RDS automated-backup replication | Copies snapshots and transaction logs to the recovery Region for native PITR | Must be enabled by the tested CLI script because CloudFormation has no resource for it. |
| Compliance-locked AWS Backup primary vault | Daily independently retained RDS recovery point | Periodic snapshot, not a substitute for transaction-log PITR. |
| Compliance-locked AWS Backup recovery vault | Daily cross-Region snapshot copy under a recovery-Region KMS key | A cross-Region copy of a continuous backup is a periodic snapshot and has no PITR. |
| Scheduled monitor and alarms | Checks native restore-window lag/configuration, the exact recovery-vault/key/lock/copy state, and AWS Backup failures | Thresholds are incident triggers, not contractual objectives. |

[`../../infra/backup/aws-rds-dr.yaml`](../../infra/backup/aws-rds-dr.yaml)
creates the locked vaults, retained KMS keys, an RDS-only AWS Backup role and
selection, cross-Region copy action, a fifteen-minute native-replication
monitor, encrypted logs, and failure/freshness alarms. The RDS source remains
the database in
[`../../infra/aws/cloudformation/postwave-stack.yaml`](../../infra/aws/cloudformation/postwave-stack.yaml).

## Preconditions

- Use different primary and recovery Regions in the same approved account.
- Confirm `postwave-prod` is `available`, PostgreSQL, encrypted, Multi-AZ,
  `BackupTarget=region`, and has a non-zero native retention period.
- Confirm RDS and AWS Backup support the chosen Region pair and that RDS is
  enabled in `aws backup describe-region-settings`.
- Use customer-managed KMS keys. The source RDS key policy and recovery key
  policy must allow the required RDS/AWS Backup grants; never use an alias where
  this runbook requires an ARN.
- Create separate on-call SNS topics in both Regions and verify their topic
  policies allow CloudWatch alarm delivery.
- Review quotas, private DB subnet group, recovery-only security group, option
  and parameter groups, engine minor availability, and customer residency.
- Review `RetentionDays`, `NativeReplicationRetentionDays`, and
  `VaultLockChangeableForDays` before deployment. Compliance mode becomes
  unchangeable when its grace period expires.

Record the exact inputs:

```bash
export PRIMARY_REGION=us-west-2
export RECOVERY_REGION=us-east-1
export ACCOUNT_ID=123456789012
export RDS_DB_ARN="arn:aws:rds:${PRIMARY_REGION}:${ACCOUNT_ID}:db:postwave-prod"
export RDS_STORAGE_KMS_KEY_ARN="arn:aws:kms:${PRIMARY_REGION}:${ACCOUNT_ID}:key/SOURCE_KEY_ID"
export PRIMARY_ALARM_TOPIC_ARN="arn:aws:sns:${PRIMARY_REGION}:${ACCOUNT_ID}:postwave-prod-oncall"
export RECOVERY_ALARM_TOPIC_ARN="arn:aws:sns:${RECOVERY_REGION}:${ACCOUNT_ID}:postwave-prod-oncall"
```

Before any mutation, save these results in the change ticket:

```bash
aws sts get-caller-identity
aws rds describe-db-instances \
  --region "${PRIMARY_REGION}" \
  --db-instance-identifier postwave-prod \
  --query 'DBInstances[0].{Arn:DBInstanceArn,Status:DBInstanceStatus,Engine:Engine,Version:EngineVersion,MultiAZ:MultiAZ,Encrypted:StorageEncrypted,KmsKeyId:KmsKeyId,Retention:BackupRetentionPeriod,Window:PreferredBackupWindow,Target:BackupTarget}'
aws backup describe-region-settings --region "${PRIMARY_REGION}"
aws backup describe-region-settings --region "${RECOVERY_REGION}"
aws rds describe-source-regions \
  --region "${RECOVERY_REGION}" \
  --region-name "${PRIMARY_REGION}" \
  --query 'SourceRegions[0].{Region:RegionName,Status:Status,SupportsNativeReplication:SupportsDBInstanceAutomatedBackupsReplication}'
```

Stop if any returned value differs from the reviewed change.

## Deploy the recovery-Region controls first

```bash
aws cloudformation deploy \
  --region "${RECOVERY_REGION}" \
  --stack-name postwave-prod-rds-dr-replica \
  --template-file infra/backup/aws-rds-dr.yaml \
  --parameter-overrides \
    Mode=replica \
    Environment=prod \
    RdsDbArn="${RDS_DB_ARN}" \
    AlarmTopicArn="${RECOVERY_ALARM_TOPIC_ARN}" \
    RetentionDays=35 \
    NativeReplicationRetentionDays=14 \
    NativeReplicationMaxLagSeconds=1800 \
    ReplicaCopyMaxAgeSeconds=172800 \
    VaultLockChangeableForDays=7 \
  --capabilities CAPABILITY_IAM

aws cloudformation update-termination-protection \
  --region "${RECOVERY_REGION}" \
  --stack-name postwave-prod-rds-dr-replica \
  --enable-termination-protection

export REPLICA_VAULT_ARN="$(aws cloudformation describe-stacks \
  --region "${RECOVERY_REGION}" \
  --stack-name postwave-prod-rds-dr-replica \
  --query 'Stacks[0].Outputs[?OutputKey==`ReplicaBackupVaultArn`].OutputValue' \
  --output text)"
export REPLICA_VAULT_NAME="$(aws cloudformation describe-stacks \
  --region "${RECOVERY_REGION}" \
  --stack-name postwave-prod-rds-dr-replica \
  --query 'Stacks[0].Outputs[?OutputKey==`ReplicaBackupVaultName`].OutputValue' \
  --output text)"
export REPLICA_VAULT_KMS_KEY_ARN="$(aws cloudformation describe-stacks \
  --region "${RECOVERY_REGION}" \
  --stack-name postwave-prod-rds-dr-replica \
  --query 'Stacks[0].Outputs[?OutputKey==`ReplicaVaultKmsKeyArn`].OutputValue' \
  --output text)"
```

The KMS key and vault have `DeletionPolicy` and `UpdateReplacePolicy` set to
`Retain`. Termination protection adds an operator guard; neither control alone
prevents a sufficiently privileged administrator from disabling or scheduling
deletion of a retained key. Enforce an organization SCP and separately
controlled break-glass process for `kms:DisableKey`, `kms:ScheduleKeyDeletion`,
Vault Lock changes during the grace period, and termination-protection changes.

## Enable native cross-Region PITR

Run the validator without `--apply` first. It rejects a cluster ARN, same-Region
configuration, wrong account/key, unencrypted or non-Multi-AZ source, disabled
native backups, an unsupported Region pair, and a mismatched existing
replication. It never stops or replaces an existing replication.

```bash
scripts/backup/configure-rds-cross-region-pitr.sh \
  --source-db-arn "${RDS_DB_ARN}" \
  --source-region "${PRIMARY_REGION}" \
  --replica-region "${RECOVERY_REGION}" \
  --replica-kms-key-arn "${REPLICA_VAULT_KMS_KEY_ARN}" \
  --database postwave \
  --retention-days 14

scripts/backup/configure-rds-cross-region-pitr.sh \
  --source-db-arn "${RDS_DB_ARN}" \
  --source-region "${PRIMARY_REGION}" \
  --replica-region "${RECOVERY_REGION}" \
  --replica-kms-key-arn "${REPLICA_VAULT_KMS_KEY_ARN}" \
  --database postwave \
  --retention-days 14 \
  --apply
```

Rerun the first command until it reports `status=active` and a latest restore
time. A matching but still `pending`/`creating` record returns temporary-failure
status `75` so automation cannot treat it as recoverable. A key/retention
mismatch is a fail-closed change requiring a separate approved stop/re-enable
window; do not add an automatic stop command.

## Deploy the primary AWS Backup plan

The default `02:00 UTC` schedule is intentionally outside the canonical RDS
native backup window (`08:00–09:00 UTC`). Re-review both if either changes.

```bash
aws cloudformation deploy \
  --region "${PRIMARY_REGION}" \
  --stack-name postwave-prod-rds-dr-primary \
  --template-file infra/backup/aws-rds-dr.yaml \
  --parameter-overrides \
    Mode=primary \
    Environment=prod \
    RdsDbArn="${RDS_DB_ARN}" \
    RdsStorageKmsKeyArn="${RDS_STORAGE_KMS_KEY_ARN}" \
    ReplicaBackupVaultArn="${REPLICA_VAULT_ARN}" \
    ReplicaBackupVaultName="${REPLICA_VAULT_NAME}" \
    ReplicaVaultKmsKeyArn="${REPLICA_VAULT_KMS_KEY_ARN}" \
    AlarmTopicArn="${PRIMARY_ALARM_TOPIC_ARN}" \
    RetentionDays=35 \
    VaultLockChangeableForDays=7 \
    BackupScheduleExpression='cron(0 2 * * ? *)' \
  --capabilities CAPABILITY_IAM

aws cloudformation update-termination-protection \
  --region "${PRIMARY_REGION}" \
  --stack-name postwave-prod-rds-dr-primary \
  --enable-termination-protection
```

Do not delete or recreate either stack to change a locked vault. Review drift,
retention, and alarm delivery during the Vault Lock grace period, then record
the exact lock date. After compliance mode locks, even the account root cannot
remove the lock or shorten retention for existing recovery points.

## Operational validation

After the first native copy and scheduled AWS Backup copy complete, capture:

```bash
aws rds describe-db-instance-automated-backups \
  --region "${RECOVERY_REGION}" \
  --query 'DBInstanceAutomatedBackups[?DBInstanceArn==`'"${RDS_DB_ARN}"'`].{Status:Status,RestoreWindow:RestoreWindow,KmsKeyId:KmsKeyId,Encrypted:Encrypted,Retention:BackupRetentionPeriod,Arn:DBInstanceAutomatedBackupsArn}'

aws backup list-recovery-points-by-backup-vault \
  --region "${RECOVERY_REGION}" \
  --backup-vault-name "${REPLICA_VAULT_NAME}" \
  --by-resource-type RDS \
  --query 'reverse(sort_by(RecoveryPoints[?Status==`COMPLETED`],&CompletionDate))[:5].{Arn:RecoveryPointArn,Completed:CompletionDate,CreatedBy:CreatedBy,Encrypted:EncryptionKeyArn}'

aws backup list-copy-jobs \
  --region "${PRIMARY_REGION}" \
  --by-destination-vault-arn "${REPLICA_VAULT_ARN}" \
  --query 'reverse(sort_by(CopyJobs,&CreationDate))[:5].{State:State,Created:CreationDate,Completed:CompletionDate,Destination:DestinationBackupVaultArn,Message:StatusMessage}'

aws backup describe-backup-vault \
  --region "${RECOVERY_REGION}" \
  --backup-vault-name "${REPLICA_VAULT_NAME}"
```

Verify exact KMS ARNs, retention, `active` status, a non-empty restore window,
completed copy state, Vault Lock dates, and the source resource ARN. Confirm all
stack alarms reach `OK`, then deliberately test SNS delivery and one failure
alarm in an approved non-production stack. The recovery-Region monitor treats
missing metrics, a wrong native key/retention/status, restore-window lag, an
unavailable customer key, changed vault-lock settings, or a stale/malformed
cross-Region recovery point as incidents.

## Restore from recovery-Region native PITR

Always restore a new private instance. First select the exact replicated backup
record and prove the target is within its `EarliestTime`/`LatestTime` window:

```bash
export REPLICATED_AUTOMATED_BACKUP_ARN='arn:aws:rds:RECOVERY_REGION:ACCOUNT_ID:auto-backup:ab-...'
export RESTORE_TIME='YYYY-MM-DDTHH:MM:SSZ'
export DRILL_DB_ID='postwave-dr-CHANGEID'

aws rds restore-db-instance-to-point-in-time \
  --region "${RECOVERY_REGION}" \
  --source-db-instance-automated-backups-arn "${REPLICATED_AUTOMATED_BACKUP_ARN}" \
  --target-db-instance-identifier "${DRILL_DB_ID}" \
  --restore-time "${RESTORE_TIME}" \
  --db-instance-class db.m7g.large \
  --db-subnet-group-name RECOVERY_PRIVATE_DB_SUBNET_GROUP \
  --vpc-security-group-ids RECOVERY_ONLY_SECURITY_GROUP_ID \
  --no-publicly-accessible \
  --no-multi-az \
  --enable-iam-database-authentication \
  --deletion-protection \
  --tags Key=project,Value=postwave Key=purpose,Value=destructive-restore-drill Key=ticket,Value=CHANGEID

aws rds wait db-instance-available \
  --region "${RECOVERY_REGION}" \
  --db-instance-identifier "${DRILL_DB_ID}"
```

For a periodic AWS Backup fallback, choose a `COMPLETED` recovery point from
the recovery vault and pass its RDS snapshot ARN to
`restore-db-instance-from-db-snapshot` with the same explicit private subnet,
recovery-only security group, non-public setting, instance class, tags, and
deletion protection. That path restores only to the snapshot time; do not label
it PITR.

## Verification, evidence, and teardown

Keep all public application tasks at zero. From an isolated recovery task:

1. Verify database `postwave`, expected migration, required tables, valid
   foreign keys/indexes, database size, and enabled **and forced** RLS on every
   tenant table.
2. Run the exact release digest with providers disabled; require dependency-aware
   `/api/ready`, authentication, tenant isolation, and a controlled write/read.
3. Record the source ARN, replicated-backup or snapshot ARN, requested and
   observed recovered time/LSN, caller ARN, RDS events, exact network controls,
   database/application verification, and measured durations.
4. Fence and destroy the restored customer data before signing a `passed`
   attestation. A cleanup failure is a failed drill and a security incident.
5. Sign the canonical JSON digest with the asymmetric backup-evidence key and
   retain the JSON, checksum, signature, and commit marker in the existing
   `postgres/prod/evidence/restore-drills/{passed|failed}/...` contract.

Teardown is explicit:

```bash
aws rds modify-db-instance \
  --region "${RECOVERY_REGION}" \
  --db-instance-identifier "${DRILL_DB_ID}" \
  --no-deletion-protection \
  --apply-immediately
aws rds wait db-instance-available \
  --region "${RECOVERY_REGION}" \
  --db-instance-identifier "${DRILL_DB_ID}"
aws rds delete-db-instance \
  --region "${RECOVERY_REGION}" \
  --db-instance-identifier "${DRILL_DB_ID}" \
  --skip-final-snapshot
aws rds wait db-instance-deleted \
  --region "${RECOVERY_REGION}" \
  --db-instance-identifier "${DRILL_DB_ID}"
```

Never run teardown against `postwave-prod`. Verify deletion with a fresh
`describe-db-instances` call before producing passed evidence.

## Incident handling

- A missing/invalid native replication metric, lag alarm, failed/expired AWS
  Backup job, failed copy, stale completion alarm, failed restore, or unexpected
  Vault Lock/key state pages Platform on-call.
- Preserve CloudTrail, RDS events, AWS Backup job details, Lambda monitor logs,
  KMS events, alarm history, and recovery point ARNs before changing anything.
- Do not stop native replication, delete snapshots, disable a key, or weaken
  retention to clear an alarm.
- If the primary Region is impaired, verification can use the separately
  archived public evidence key; signing new evidence may remain unavailable
  until the signing service is restored. Preserve local evidence and state that
  limitation explicitly.

Authoritative provider references reviewed on 2026-07-14:
[RDS automated-backup replication](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReplicateBackups.html),
[RDS PITR CLI](https://docs.aws.amazon.com/cli/latest/reference/rds/restore-db-instance-to-point-in-time.html),
[AWS Backup cross-Region copies](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html),
and [AWS Backup feature availability](https://docs.aws.amazon.com/aws-backup/latest/devguide/backup-feature-availability.html).
