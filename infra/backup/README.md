# PostgreSQL backup and recovery

This directory is the executable backup contract for Moosewave. It provides an
immutable WAL-G runtime, continuous WAL archiving, scheduled physical and
logical backups, independent cross-region storage, health alarms, and a
destructive restore drill.

## Current evidence status

The image build and a complete local WAL-G base-backup/WAL/PITR cycle are
automated in [the backup workflow](../../.github/workflows/backup-dr.yml). The
AWS templates and Kubernetes manifests are statically validated. That proves
the code path, not a live production recovery objective.

No production RPO or RTO is published yet. Those values must come from signed
drill evidence against the deployed production-scale dataset. Until the AWS
stacks, workload identity, alarms, replica, and a successful restore/failover
drill exist in the target account, this is a deployment-ready reference
implementation rather than evidence of an operating control.

## Components

| File | Contract |
|---|---|
| [`image/Dockerfile`](image/Dockerfile) | Multi-architecture PostgreSQL 16/Alpine runtime pinned by upstream digest; WAL-G is compiled from a checksum-pinned commit with a current Go toolchain; APK runtime versions are exact. No runtime download. |
| [`postgres-statefulset-patch.yaml`](postgres-statefulset-patch.yaml) | Valid strategic-merge patch. The primary and sidecar run the same tested digest, WAL archiving runs in the primary, and the sidecar reads the same `postgres-data` PGDATA volume. |
| [`postgres-pitr-config.yaml`](postgres-pitr-config.yaml) | Separate writer/signer workload identities, WAL-G settings, a five-minute freshness/replication monitor, and a six-hour WAL integrity monitor. |
| [`postgres-backup-cronjob.yaml`](postgres-backup-cronjob.yaml) | Independent six-hour logical dump trail and hourly least-privilege base-manifest signer. |
| [`render-manifests.sh`](render-manifests.sh) | Refuses mutable image tags and renders environment-specific manifests. |
| [`aws-backup-dr.yaml`](aws-backup-dr.yaml) | Multi-region KMS, Object-Locked/versioned S3 buckets, replication-time control, IAM policies, and alarms. |
| [`aws-rds-dr.yaml`](aws-rds-dr.yaml) | Compliance-locked AWS Backup vaults, explicit canonical RDS selection, daily cross-Region snapshot copy, native RDS replication monitor, and alarms. |
| [`aws-dns-failover.yaml`](aws-dns-failover.yaml) | Active-passive Route 53 aliases for two independently healthy ALBs. |
| [`restore.sh`](restore.sh) | Fail-closed signed logical-dump recovery into an explicitly isolated, newly named database. |
| [`../../scripts/backup/configure-rds-cross-region-pitr.sh`](../../scripts/backup/configure-rds-cross-region-pitr.sh) | Validates and explicitly enables native RDS automated-backup replication; refuses automatic stop/replacement. |
| [`../../scripts/backup/restore-drill.sh`](../../scripts/backup/restore-drill.sh) | Destructive physical PITR into an egress/inbound-isolated Docker volume; signed evidence is committed only after verified teardown. |

## Data paths

The physical path is the primary recovery path for a same-major-version
PostgreSQL failure:

1. PostgreSQL invokes `wal-g wal-push` for every completed segment.
2. `archive_timeout=60s` forces rotation on a quiet database. This is an
   engineering setting and does **not** itself prove a data-loss bound.
3. A sidecar checks every 15 minutes and runs a checksummed `backup-push
   --verify` when the last successful base backup is at least one day old.
4. Every base backup requires PostgreSQL page checksums, records the immutable
   cluster generation and system identifier, runs `wal-verify integrity
   timeline`, and uploads a SHA-256 manifest/checksum with S3 checksums and
   SSE-KMS. A separate least-privilege signer workload validates and signs that
   manifest; the database pod has no `kms:Sign` permission. The base-backup age
   metric comes from the signer-owned, signature-verified latest manifest, not
   from a heartbeat writable by the database backup identity. The signer scans
   a bounded 64-backup backlog, covering more than the 45-day physical-chain
   retention without an unbounded evidence-prefix walk.
5. The runtime has no delete or Object-Lock-bypass permission. S3 Object Lock is
   in governance mode: it protects against the workload roles and ordinary
   deletion, while an explicitly privileged principal with
   `s3:BypassGovernanceRetention` could override it. The 45-day WAL/base
   lifecycle is the intended retention authority; protect bypass and KMS key
   administration with organization controls and break-glass approval.

The logical path runs every six hours. It validates the pg_dump custom-format
TOC, records a dump checksum and diagnostic schema metadata, signs the
manifest, and uploads every object with an S3 SHA-256 checksum and SSE-KMS.
Its row counts are explicitly diagnostic: they are observed after the dump and
are not presented as transactionally identical to its snapshot.

## Build and publish the immutable image

Pull requests build and test an amd64 image. Main-branch and manual workflows
also publish amd64/arm64, attach provenance/SBOM, scan it, and keylessly sign the
result. Copy the exact `repository@sha256:digest` from the workflow summary.
Never deploy the source templates with a tag or unresolved token.

Local equivalent:

```bash
docker build --platform linux/amd64 \
  --build-arg BUILD_REVISION="$(git rev-parse HEAD)" \
  -t postwave-backup:local-test infra/backup/image

LOCAL_BACKUP_IMAGE=postwave-backup:local-test \
  scripts/backup/test-walg-local.sh
```

## Provision retained cross-region object storage

Bucket names are globally unique. The following shows the required three-step
deployment order; substitute account-owned names and regions. These S3 buckets
use Object Lock **governance** mode, not compliance mode; workload roles cannot
delete/bypass retained versions, but a separately privileged governance-bypass
principal can. The canonical RDS template uses compliance-mode Backup Vault
Lock and has different operational constraints.

```bash
# 1. Primary-region multi-region encryption key + evidence signing key.
aws cloudformation deploy \
  --region us-west-2 \
  --stack-name postwave-prod-backup-seed \
  --template-file infra/backup/aws-backup-dr.yaml \
  --parameter-overrides Mode=seed Environment=prod \
  --capabilities CAPABILITY_IAM

PRIMARY_KEY_ARN="$(aws cloudformation describe-stacks --region us-west-2 \
  --stack-name postwave-prod-backup-seed \
  --query 'Stacks[0].Outputs[?OutputKey==`SeedPrimaryBackupKeyArn`].OutputValue' --output text)"
SIGNING_KEY_ARN="$(aws cloudformation describe-stacks --region us-west-2 \
  --stack-name postwave-prod-backup-seed \
  --query 'Stacks[0].Outputs[?OutputKey==`SeedEvidenceSigningKeyArn`].OutputValue' --output text)"

# 2. Independent bucket and KMS replica in the recovery region.
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name postwave-prod-backup-replica \
  --template-file infra/backup/aws-backup-dr.yaml \
  --parameter-overrides \
    Mode=replica Environment=prod \
    ReplicaBucketName=ACCOUNT-UNIQUE-postwave-prod-backup-replica \
    PrimaryBackupKeyArn="${PRIMARY_KEY_ARN}" \
  --capabilities CAPABILITY_IAM

REPLICA_BUCKET_ARN="$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name postwave-prod-backup-replica \
  --query 'Stacks[0].Outputs[?OutputKey==`ReplicaBucketArn`].OutputValue' --output text)"
REPLICA_KEY_ARN="$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name postwave-prod-backup-replica \
  --query 'Stacks[0].Outputs[?OutputKey==`ReplicaBackupKeyArn`].OutputValue' --output text)"

# 3. Primary bucket, replication role, runtime policies, and alarms.
aws cloudformation deploy \
  --region us-west-2 \
  --stack-name postwave-prod-backup-primary \
  --template-file infra/backup/aws-backup-dr.yaml \
  --parameter-overrides \
    Mode=primary Environment=prod \
    PrimaryBucketName=ACCOUNT-UNIQUE-postwave-prod-backup-primary \
    PrimaryBackupKeyArn="${PRIMARY_KEY_ARN}" \
    PrimaryEvidenceSigningKeyArn="${SIGNING_KEY_ARN}" \
    ReplicaBucketArn="${REPLICA_BUCKET_ARN}" \
    ReplicaBackupKeyArn="${REPLICA_KEY_ARN}" \
    AlarmTopicArn=arn:aws:sns:us-west-2:ACCOUNT_ID:postwave-prod-oncall \
  --capabilities CAPABILITY_IAM
```

Attach `BackupWriterManagedPolicyArn` only to the database-side writer role and
attach `BackupEvidenceSignerManagedPolicyArn` only to a **different** signer
role used by the logical and base-manifest signing CronJobs. The writer cannot
sign evidence; the signer cannot read PGDATA. Attach `RestoreManagedPolicyArn`
only to a separately controlled break-glass restore role. During an approved
drill, that role also needs the narrowly scoped
`RestoreDrillEvidenceManagedPolicyArn`, which can sign and write only retained
restore evidence. None of these policies grants `s3:DeleteObject`, Object-Lock
governance bypass, or KMS administration.
The runtime writer can list restore evidence for age monitoring but cannot write
the `evidence/restore-drills/` prefix; only the approved drill policy can do so.

The primary stack also outputs `PrimaryBackupBucketName`; the replica stack
outputs `ReplicaBackupBucketName`. Consume those outputs in the out-of-band
backup workload. The API application role does not need backup-bucket access.

## Render and deploy the self-managed PostgreSQL manifests

The patch intentionally has three invariants: StatefulSet
`postwave-postgres`, primary container `postgres`, PVC volume
`postgres-data`, and PGDATA `/var/lib/postgresql/data/pgdata`. Stop if the live
workload differs; do not edit a rendered file ad hoc.

The patch deliberately replaces the primary container image with the same
digest tested for backup/recovery, eliminating WAL-G ABI drift. Before rollout,
prove that the source server is PostgreSQL 16 and that every required extension
exists in this image; otherwise build and test an extension-compatible image
from the same pinned base rather than applying this patch.

Create the `postwave-backup-db` Secret with a dedicated credential for database
`postwave` that can read PostgreSQL monitoring state but cannot mutate
application tables. The physical
backup sidecar uses the primary pod's Unix socket and OS `postgres` identity;
it does not carry a database password.

Before rendering, query and record the immutable source identity:

```sql
SHOW server_version;
SHOW data_checksums;
SELECT system_identifier FROM pg_control_system();
```

`data_checksums` must be `on`. `POSTGRES_INITDB_ARGS=--data-checksums` affects
only a new PGDATA; it does not repair an existing cluster. If checksums are off,
schedule an offline supported checksum migration or restore into a newly
initialized checksummed cluster and pass the destructive drill before rollout.
Choose a new immutable cluster ID (for example `prod-20260714-a`) for every
init/restore generation and never reuse its WAL-G prefix.

```bash
infra/backup/render-manifests.sh \
  --output-dir /tmp/postwave-backup-prod \
  --image 'ghcr.io/OWNER/postwave-backup@sha256:DIGEST' \
  --bucket ACCOUNT-UNIQUE-postwave-prod-backup-primary \
  --replica-bucket ACCOUNT-UNIQUE-postwave-prod-backup-replica \
  --kms-key-id "${PRIMARY_KEY_ARN}" \
  --evidence-signing-key-id "${SIGNING_KEY_ARN}" \
  --writer-role-arn arn:aws:iam::ACCOUNT_ID:role/postwave-prod-backup-writer \
  --signer-role-arn arn:aws:iam::ACCOUNT_ID:role/postwave-prod-backup-signer \
  --region us-west-2 \
  --replica-region us-east-1 \
  --environment prod \
  --cluster-id prod-20260714-a \
  --system-identifier 7412345678901234567

kubectl apply \
  -f /tmp/postwave-backup-prod/postgres-pitr-config.yaml \
  -f /tmp/postwave-backup-prod/postgres-backup-cronjob.yaml
kubectl patch statefulset postwave-postgres -n postwave \
  --type=strategic \
  --patch-file /tmp/postwave-backup-prod/postgres-statefulset-patch.yaml
kubectl rollout status statefulset/postwave-postgres -n postwave
```

Verify `SHOW archive_mode`, inspect `pg_stat_archiver`, wait for the first
signed base-backup heartbeat, then confirm all CloudWatch alarms leave
`INSUFFICIENT_DATA`. A successful manifest render is not a deployment check.

## Monitoring contract

The monitor runs every five minutes and publishes these dimensions under
`Postwave/Backup` with `Environment=<env>`:

- physical base-backup age and health;
- independent logical-backup age and health;
- PostgreSQL archiver age plus the independent six-hour WAL
  integrity/timeline probe;
- primary-to-replica heartbeat lag plus native S3 failed-replication metrics;
- age of the newest signed restore verification;
- job, monitor, and restore-drill failures.

Missing custom metrics are treated as breaching. Thresholds in IaC are paging
thresholds, not customer commitments. Tune only after observing production
volume and completing recovery exercises.

## Canonical AWS RDS deployment

The main AWS stack uses encrypted Multi-AZ RDS with native automated backups
and primary-Region point-in-time recovery. WAL-G is only for self-managed
PostgreSQL; its S3 chain is not a recovery source for the canonical RDS
filesystem.

Deploy [`aws-rds-dr.yaml`](aws-rds-dr.yaml) in recovery mode first and primary
mode second, then use
[`configure-rds-cross-region-pitr.sh`](../../scripts/backup/configure-rds-cross-region-pitr.sh)
to enable native RDS automated-backup replication. This produces two distinct
recovery paths:

- native cross-Region RDS snapshots plus transaction logs for PITR; and
- daily primary/recovery AWS Backup recovery points in retained,
  compliance-locked vaults with separate regional KMS keys.

AWS Backup cross-Region copies are periodic snapshots and do not retain PITR;
they are the independently locked fallback, not the native log-replication
replacement. Exact deployment, Vault Lock/SCP requirements, validation,
private restore, and teardown commands are in
[`../../docs/runbooks/rds-cross-region-backup.md`](../../docs/runbooks/rds-cross-region-backup.md).
Do not claim RDS recovery or regional failover until both a native recovery-
Region PITR and a locked-snapshot restore pass with signed target-account
evidence.

## Signed logical fallback

Select the exact dump object version and restore only to a disposable/private
cluster where the application owner role has already been provisioned with a
rotated credential. The script refuses an existing database, requires a
`postwave_restore_*` or `postwave_dr_*` name, verifies S3 checksums/SSE-KMS,
the exact version of every sidecar, the manifest checksum and asymmetric KMS
signature, the dump digest/TOC, and restored schema integrity. It refuses the
known production host and requires a marker stored in the target's maintenance
database; a command-line assertion alone is insufficient. It never creates a
passwordless/superuser/BYPASSRLS role and never promotes traffic.

Provision the marker on the isolated target, not on production:

```sql
CREATE TABLE public.postwave_restore_target_control (
  marker text PRIMARY KEY,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.postwave_restore_target_control FROM PUBLIC;
INSERT INTO public.postwave_restore_target_control(marker)
VALUES ('ticket-1234-isolated-target');
GRANT SELECT ON public.postwave_restore_target_control TO break_glass_restore;
```

```bash
BACKUP_BUCKET=ACCOUNT-UNIQUE-postwave-prod-backup-primary \
AWS_REGION=us-west-2 \
BACKUP_SOURCE_KMS_KEY_ID="${PRIMARY_KEY_ARN}" \
BACKUP_EVIDENCE_SIGNING_KEY_ID="${SIGNING_KEY_ARN}" \
PGHOST=PRIVATE_ISOLATED_TARGET PGUSER=break_glass_restore \
PRODUCTION_DB_HOST=KNOWN_PRODUCTION_HOST \
RESTORE_TARGET_MARKER=ticket-1234-isolated-target \
infra/backup/restore.sh \
  --backup-key postgres/prod/logical/YYYY/MM/DD/logical-TIMESTAMP/logical-TIMESTAMP.dump \
  --backup-version-id EXACT_DUMP_VERSION_ID \
  --dump-checksum-version-id EXACT_DUMP_CHECKSUM_VERSION_ID \
  --manifest-version-id EXACT_MANIFEST_VERSION_ID \
  --manifest-checksum-version-id EXACT_MANIFEST_CHECKSUM_VERSION_ID \
  --manifest-signature-version-id EXACT_SIGNATURE_VERSION_ID \
  --target-time YYYY-MM-DDTHH:MM:SSZ \
  --expected-migration MIGRATION_FOR_SELECTED_APP_RELEASE \
  --db-name postwave_restore_ticket_1234 \
  --confirm-isolated-target
```

For a dump read from the replica region, set `BACKUP_SOURCE_KMS_KEY_ID` to the
replica key, keep `AWS_REGION` on the source, and set
`BACKUP_EVIDENCE_REGION` to the primary region that owns the asymmetric signing
key. Export the public verification key before an outage with
[`../../scripts/backup/export-evidence-public-key.sh`](../../scripts/backup/export-evidence-public-key.sh)
and archive its PEM, DER, and pinned DER SHA-256 checksum in an independently
controlled out-of-region/offline recovery kit. Setting
`BACKUP_EVIDENCE_PUBLIC_KEY_FILE` and
`BACKUP_EVIDENCE_PUBLIC_KEY_SHA256` permits verification without calling the
primary KMS service; the key ID in signed metadata must still match the reviewed
signing key ARN.

`--target-time` labels the selected dump; a logical dump cannot replay between
snapshots. `--allow-missing-sidecars` is an explicitly degraded legacy path and
cannot produce production-control evidence. It is accepted only when
`LEGACY_RESTORE_APPROVAL=I_ACCEPT_UNSIGNED_LEGACY_ARTIFACT_RISK` and a safe,
traceable `LEGACY_RESTORE_TICKET` are both set; preserve the command transcript
with that ticket and treat the recovered database as untrusted until separately
reconciled.
