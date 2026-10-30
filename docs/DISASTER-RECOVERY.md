# Disaster-recovery posture

This document describes what Moosewave can build and test from the repository,
what the production deployment must provide, and what still requires live
evidence. The incident procedure is in
[`runbooks/disaster-recovery.md`](runbooks/disaster-recovery.md).

## Readiness statement

The repository now contains a locally exercised self-managed PostgreSQL
physical recovery chain, governance-retained object-storage IaC,
compliance-locked canonical RDS backup IaC, native RDS replication monitoring,
active-passive DNS IaC, and a signed destructive-drill workflow. It does not
contain credentials, deployed vaults/replication/secondary capacity, production
data volume, DNS authority, or signed live drill results.

Accordingly:

- no production recovery-point or recovery-time objective is claimed;
- `archive_timeout`, backup cadence, alarm thresholds, RDS retention, and DNS
  TTL are configuration values—not measured service outcomes;
- local PITR success proves the software path, not provider access, replica
  completeness, production restore duration, or application cutover;
- production readiness requires dated evidence from the target account and
  exact release digests.

## State inventory

Moosewave recovery must account for all durable or externally visible state:

| State | Recovery source | Important coupling |
|---|---|---|
| Moosewave PostgreSQL | Primary and replicated recovery-Region RDS native PITR plus compliance-locked periodic snapshots in the canonical AWS stack; WAL-G base backups + WAL and independent logical dumps for self-managed PostgreSQL | Restore schema, RLS, audit/outbox state, credentials, and tenant data together. |
| Listmonk PostgreSQL | Its own same-time database backup/PITR contract | Subscriber and campaign identifiers must align with Moosewave. A Moosewave-only restore can create drift. |
| Object uploads/archives | Versioned, encrypted object-store copy and inventory | Restored database references must resolve to retained object versions. |
| Redis/asynq | Recreated, not treated as authoritative backup state | Jobs derived from committed outbox/business state may need controlled replay; missing uncommitted work is not recoverable. |
| KMS/secrets | Provider-managed keys plus separately protected secret configuration | A database without decryptable integration secrets is not a complete service recovery. KMS keys must never be backed up inside the database bucket. |
| DNS/certificates/images/IaC | Reviewed IaC and immutable release artifacts | Both regions must use the same approved release digest and compatible schema. |
| Third-party providers | Provider state plus Moosewave reconciliation ledgers | Sending, billing, CRM, SMS, and webhook effects may need reconciliation to avoid duplicates. |

This inventory must be extended whenever a new durable dependency is added.

## Backup design

### Canonical AWS deployment

The main stack provisions encrypted Multi-AZ RDS with automated backup
retention and native point-in-time recovery. AWS controls the physical storage,
so a WAL-G filesystem sidecar is not applicable. A production exercise must
restore a new isolated RDS instance, point an isolated application stack at it,
pass the same database/application checks, and record signed evidence.

[`infra/backup/aws-rds-dr.yaml`](../infra/backup/aws-rds-dr.yaml) adds an
explicit daily AWS Backup selection with compliance-locked primary and
recovery-Region vaults, cross-Region periodic snapshot copies, separately
retained regional KMS keys, job/copy freshness and failure alarms, and a
scheduled native-replication restore-window monitor. The tested configuration
script enables RDS automated-backup replication so the recovery Region has
transaction logs for native PITR. AWS Backup cross-Region copies are periodic
snapshots and do not retain PITR. Deployment and restore procedure:
[`runbooks/rds-cross-region-backup.md`](runbooks/rds-cross-region-backup.md).

The standalone template
[`infra/backup/aws-backup-dr.yaml`](../infra/backup/aws-backup-dr.yaml)
provisions an independent Object-Locked backup bucket and a second-region
replica for portable/self-managed artifacts and evidence. Deployment order and
IAM handoff are documented in
[`infra/backup/README.md`](../infra/backup/README.md).

### Self-managed PostgreSQL

The immutable runtime and manifests under [`infra/backup/`](../infra/backup/)
provide:

- WAL-G `wal-push` from PostgreSQL's actual PGDATA/archiver;
- verified physical base backups from a sidecar mounting that same PGDATA;
- an independent logical dump trail;
- SSE-KMS, S3 SHA-256 checksums, separately signed manifests, versioning,
  governance-mode Object Lock, and cross-region replication;
- alerts on backup age, newest WAL age, WAL gaps/timeline conflicts, failed
  replication, monitor failure, and restore-verification age.

WAL-G and logical backups are independent recovery paths, but they are not
independent of the primary AWS account. The replica bucket and replica KMS key
provide the regional storage boundary; a separate break-glass role and tested
secondary stack provide the operational boundary.

## Failure modes and required proof

| Failure | Recovery approach | Evidence needed before claiming readiness |
|---|---|---|
| Process/task loss | Scheduler restarts exact immutable image; queues/outbox resume | Multi-AZ task replacement test and dependency-aware `/api/ready` pass. |
| Single database instance/volume loss | RDS failover/native restore, or WAL-G fetch + replay to a new volume | Provider event/failover exercise or isolated physical restore with integrity checks. |
| Accidental/destructive write | Stop mutations, identify a timestamp before the write, PITR into a parallel database, verify, then cut over | Injected canary drill proving pre-target data remains and post-target data does not. |
| Backup corruption or deletion | Object-Lock version history, independent logical trail, or cross-region replica | Checksum/signature failure exercise and restore from alternate path. |
| Region outage | Fence primary writers, activate independently provisioned secondary, restore RDS from replicated native PITR (or the locked periodic snapshot fallback), restore other state from recovery copies, pass readiness, then enable DNS failover | Full secondary-region application + database + object restore and controlled DNS exercise. |
| Credential/KMS compromise | Revoke runtime identities, preserve versions, use uncompromised break-glass role/key controls | Security exercise; proof that restore role cannot delete/bypass retention and writer role cannot administer keys. |
| Partial external side effect | Restore durable state, then reconcile each provider by idempotency key/ledger | Provider-specific reconciliation results; never assume outbox replay reconstructs an uncommitted transaction. |

## Measuring recovery outcomes

Measurements must name exactly what they represent:

- **Recovered data timestamp**: timestamp/LSN of the newest verified durable
  application transaction in the recovered database.
- **Observed data-loss interval**: incident or canary cut timestamp minus that
  recovered transaction timestamp. Object `LastModified` age is only an archive
  freshness proxy and must be labelled as such.
- **Restore duration**: from approved recovery invocation until database
  integrity verification passes.
- **Service recovery duration**: from incident declaration until an isolated
  application stack passes `/api/ready`, smoke tests, and the traffic decision.
- **Replication lag**: age of a primary heartbeat not yet visible with the same
  backup ID in the replica bucket, corroborated by native S3 replication
  metrics.
- **Native RDS replication lag**: age of the latest recovery-Region RDS restore
  time, reported only when status, source ARN, encryption key, engine, and
  retention all match the reviewed configuration.
- **AWS Backup copy freshness**: time since a completed RDS copy into the
  compliance-locked recovery vault; it describes snapshot freshness, not PITR
  granularity.

Do not turn one small-dataset result into a contractual objective. Establish a
candidate only after repeated production-scale drills, define percentile and
failure treatment, obtain operational ownership, and have commercial/legal
review before publishing it to clients.

## Evidence contract

Each destructive drill must produce signed, versioned, governance-retained JSON
containing:

- exact backup image digest, source bucket/prefix, base-backup metadata, target
  timestamp, operator/ticket identity, AWS caller, and timestamps;
- restore duration and archive-age proxy, clearly labelled;
- schema migration version/count, database size, recovery state, RLS, foreign
  key, index, and core-table verification;
- `passed` or `failed`, never an unsigned manual success note.

The JSON digest is signed by the asymmetric backup-evidence KMS key, verified
before upload, stored with S3 SHA-256 and SSE-KMS, replicated, and retained by
the evidence lifecycle. A signoff row references its object key and signature;
it is not evidence on its own.

## Promotion gates

Before Moosewave is described as disaster-recovery ready, all of the following
must be true in a production-like account:

- primary and replica backup stacks deployed and drift-free;
- canonical RDS primary/recovery vault stacks deployed with termination
  protection, compliance Vault Lock, native automated-backup replication, and
  current restore windows/recovery points;
- backup writer and restore roles attached with reviewed trust policies;
- first physical/native and logical backups present, encrypted, checksummed,
  signed where applicable, and independently replicated;
- every backup alarm observed in `OK`, then deliberately driven to `ALARM` and
  confirmed at the on-call destination;
- self-managed restore from primary and replica sources, native RDS PITR from
  the recovery Region, and an RDS locked-snapshot fallback restore passed with
  retained signed evidence;
- secondary application/data plane deployed from reviewed IaC, initially
  fenced from writes, using the exact release digest;
- Listmonk, object data, secrets, provider reconciliation, migrations, smoke,
  and `/api/ready` verified in recovery;
- controlled DNS failover/failback completed without simultaneous writers;
- repeated measurements reviewed and any external client wording approved.

Until then, client-facing material should say only that backup/recovery controls
are under production qualification.
