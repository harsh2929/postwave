# Backup verification tools

These scripts turn stored objects into evidence. They never make availability
or recovery promises by themselves.

## `test-walg-local.sh`

The CI integration test for the immutable backup image. It initializes a
checksummed PostgreSQL cluster, takes a verified physical base backup, archives
subsequent WAL, restores into an inbound-isolated volume, replays to a timestamp
between two writes, and proves that only the pre-target value survived. The
restored data and Docker resources are removed on success and failure.

```bash
LOCAL_BACKUP_IMAGE=postwave-backup:local-test \
  scripts/backup/test-walg-local.sh
```

## `restore-drill.sh`

The account-backed destructive exercise. Unlike the removed Neon branch-clone
script, this restores the same WAL-G base backup and continuous WAL chain used
for recovery. It requires:

- an exact image reference ending in `@sha256:<64 hex>`;
- an explicit past UTC target timestamp;
- temporary AWS credentials for the break-glass restore role;
- access to the source WAL-G prefix;
- write access to the governance-retained evidence prefix and KMS signing key.

Example (values intentionally placeholders):

```bash
export AWS_REGION=us-west-2
export BACKUP_IMAGE='ghcr.io/OWNER/postwave-backup@sha256:DIGEST'
export WALG_S3_PREFIX='s3://PRIMARY_BUCKET/postgres/prod/clusters/prod-20260714-a/walg'
export BACKUP_EVIDENCE_BUCKET='PRIMARY_BUCKET'
export BACKUP_EVIDENCE_REGION=us-west-2
export BACKUP_KMS_KEY_ID='arn:aws:kms:us-west-2:ACCOUNT:key/PRIMARY_EVIDENCE_KEY_ID'
export BACKUP_SOURCE_KMS_KEY_ID='arn:aws:kms:us-west-2:ACCOUNT:key/SOURCE_BACKUP_KEY_ID'
export BACKUP_EVIDENCE_SIGNING_KEY_ID='arn:aws:kms:us-west-2:ACCOUNT:key/SIGNING_KEY_ID'
export BACKUP_ENVIRONMENT=prod
export BACKUP_IMAGE_CERTIFICATE_IDENTITY='https://github.com/OWNER/REPO/.github/workflows/backup-dr.yml@refs/heads/main'

scripts/backup/restore-drill.sh \
  --database postwave \
  --target-time 2026-07-14T03:00:00Z \
  --operator-id engineer.ticket-1234
```

The database starts with no TCP listener and no published Docker ports. The
script first verifies the image's keyless signature against the approved
main-branch workflow, selects the newest completed base backup no later than
the recovery target, and verifies that backup's exact checksummed and signed
manifest, immutable cluster ID, PostgreSQL system identifier, page-checksum
state, and WAL integrity/timeline result. It then
validates migrations, required tables, forced RLS on tenant-scoped tables,
foreign keys, indexes, and archive-replay completion. It records the observed
restore duration and WAL-object age, KMS-signs the evidence digest, verifies the
signature, uploads checksummed evidence under explicit seven-year Object Lock
governance retention, and verifies every uploaded object/version. The recovered
database receives no cloud credentials and runs with `--network none` from
checksum-validated offline WAL. A pass is signed and committed only after both
recovered-data volumes are proven absent; cleanup failure makes the drill fail
and every failed run preserves its private local evidence and PostgreSQL log for
incident handling, even when the remote failed-attestation upload succeeded.

Run alternating drills from the primary and replica bucket. A replica exercise
is the only meaningful proof that cross-region object recovery works.
Set `BACKUP_SOURCE_KMS_KEY_ID` to the exact key for the chosen source and keep
`BACKUP_KMS_KEY_ID` on the primary evidence destination. The optional pinned
offline public key exported by `export-evidence-public-key.sh` verifies source
manifests when the primary KMS verification API is unavailable; producing a
new signed result still depends on the approved evidence-signing service.

## `verify-postgres-backup.sh`

Internal verifier used by both local and account-backed drills. `--database` is
mandatory. It accepts only
containers named `postwave-dr-*` and rejects host networking or published
ports. Its JSON output is embedded in the signed drill evidence.

## `configure-rds-cross-region-pitr.sh`

Fail-closed configuration path for the canonical RDS instance. It validates
caller account, source ARN/Region/database, Multi-AZ/encryption/native backups,
recovery key identity, and existing replication. The default is plan-only;
`--apply` enables native automated-backup replication. A mismatched existing
replication is never stopped or replaced automatically. Its mocked regression
suite is `test-configure-rds-cross-region-pitr.sh`; live-account validation is
still required by the RDS runbook.

## `export-evidence-public-key.sh`

Exports the non-secret RSA public key as PEM and DER plus a checksum for the
actual DER file from the evidence-signing KMS key. Store all three in an
independently controlled, out-of-region/offline recovery kit. Recovery scripts
compare the DER fingerprint, signed metadata's key ARN, algorithm, digest, and
RSA-PSS signature.

## `create-postgres-backup.sh`

Creates a local/self-host logical custom-format dump plus SHA-256 and manifest.
Manifest row counts are diagnostic observations after the dump, not
transaction-bound parity. This is a pre-update safety tool, not the managed
production scheduled backup path.

## `run-self-hosted-backup.sh`

AWS S3 wrapper for scheduled self-hosted logical backups. It reads the database
URL from `DATABASE_URL_FILE`, takes a non-blocking process lock, invokes
`create-postgres-backup.sh`, uploads the dump/checksum/manifest with SSE-KMS
and S3 SHA-256 checksums, and verifies the stored encryption/checksum/full-hash
metadata. A non-zero exit must page the self-hosting operator. Object-store
uploads and a recurring isolated restore remain separate required controls.

## `verify-r2-backup.sh`

Legacy inventory sampling for self-hosted Cloudflare R2 media/object copies.
It accepts only an official account/jurisdiction R2 HTTPS endpoint, requires
the dedicated `R2_*` key pair or an explicitly named `R2_AWS_PROFILE` (never
ambient/default AWS credentials), rejects empty or shrinking inventories,
HEAD-checks a random sample, and advances its local baseline only after every
check passes. Its mocked regression suite is
`test-verify-r2-backup.sh`. It does not validate the PostgreSQL WAL chain and
must not substitute for `restore-drill.sh`.

## Incident handling

A missing/old backup metric, WAL integrity failure, failed replication, or
failed restore drill is an operational incident:

1. Preserve CloudWatch, S3 inventory/version, PostgreSQL archiver, and job logs.
2. Do not prune WAL-G chains or alter Object Lock during investigation.
3. Confirm whether the failure affects physical, logical, or both independent
   paths.
4. Fix and rerun the failed check; for a restore failure, rerun the destructive
   drill before closing the incident.
5. Record observed measurements and evidence object keys. Never fill a signoff
   row from a plan or a local-only test.
