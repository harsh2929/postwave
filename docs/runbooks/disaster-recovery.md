# Runbook — database and regional recovery

Owner: Platform on-call. Database owner and Security join for corruption,
credential compromise, ransomware, data exposure, or destructive operator
actions. This runbook authorizes diagnosis and recovery preparation; traffic
cutover still requires the incident commander.

The strategic posture and evidence limitations are in
[`../DISASTER-RECOVERY.md`](../DISASTER-RECOVERY.md). There is currently no
repository-backed contractual recovery objective. Report measured timestamps
and uncertainty, not configuration-derived promises.

## Non-negotiable safety rules

1. Declare an incident and start a UTC timeline before mutating recovery state.
2. Fence writers before any database or DNS promotion. Two writable primaries
   are worse than downtime.
3. Restore into new isolated infrastructure. Never run a destructive restore
   over the only surviving source.
4. Preserve database logs, CloudTrail, S3 versions, Object-Lock state,
   replication metrics, task events, and the suspected bad database.
5. Use exact image digests and reviewed IaC. Do not install tools interactively
   during an incident.
6. Treat Moosewave, Listmonk, object data, encryption secrets, and external
   provider effects as one consistency decision.
7. Do not delete a failed drill/restore environment until evidence is captured;
   do destroy recovered customer data promptly after evidence is secured.

## Triage

Record:

- incident ID, commander, database owner, security contact, start time;
- affected region/services/tenants and whether reads or writes are unsafe;
- last known healthy application release and migration version;
- RDS events or `pg_stat_archiver`, WAL-G, S3 replication, and alarm state;
- suspected bad-write timestamp and time source;
- newest primary and replica backup IDs, WAL object timestamps, logical dump,
  and signed restore evidence;
- Listmonk/object-store/provider consistency risk.

Classify the event:

- **availability only**: no evidence of corruption or destructive writes;
- **logical corruption**: known/suspected bad transaction or migration;
- **physical loss/corruption**: database unavailable or storage integrity bad;
- **regional/provider loss**: multiple AZ/control-plane dependencies unavailable;
- **security event**: backup, KMS, IAM, or data confidentiality may be compromised.

## Fence mutations

Use the deployment platform's reviewed scaling/feature controls to stop every
writer: API, automation, migration, voice, outbox, schedulers, Listmonk, and
operator jobs. In the canonical AWS stack this means setting the relevant ECS
service desired counts to zero or applying the incident read-only control, then
confirming database connections and write metrics fall to the expected set.

Also revoke or isolate the old database endpoint from the recovery stack. Do
not rely on DNS TTL alone. Record the fencing command and observed completion
time. Preserve read access only if the database is known safe and reads cannot
trigger writes.

## Choose a recovery source

Use the newest source that is both before the destructive event and verified:

1. RDS native PITR for the canonical AWS database: primary automated backups
   for a same-Region event or replicated automated backups in the recovery
   Region for a regional event.
2. WAL-G base backup plus continuous WAL for self-managed PostgreSQL.
3. Independent logical dump if the physical chain is missing/corrupt or a
   cross-major restore is required.
4. Recovery-Region AWS Backup snapshot or replica object copy when the primary
   Region path is impaired; record that snapshot recovery has coarser timing.

Check checksum/signature, backup catalog, WAL integrity, replica status, KMS
decrypt permission, and target timestamp before provisioning. For a destructive
write, choose a target with a documented safety margin before the event and
accept that valid transactions after the target may require reconciliation.

## Canonical AWS RDS PITR

The full provisioning, monitoring, recovery-Region selection, Vault Lock, and
teardown procedure is
[`rds-cross-region-backup.md`](rds-cross-region-backup.md). Create a new private
database instance; never replace the source in place. For a same-Region restore
use the source identifier:

```bash
aws rds restore-db-instance-to-point-in-time \
  --region PRIMARY_REGION \
  --source-db-instance-identifier SOURCE_ID \
  --target-db-instance-identifier "postwave-INCIDENT_ID-restore" \
  --restore-time 'UTC_TIMESTAMP_BEFORE_EVENT' \
  --db-subnet-group-name PRIVATE_SUBNET_GROUP \
  --vpc-security-group-ids RECOVERY_ONLY_SECURITY_GROUP \
  --no-publicly-accessible \
  --deletion-protection
```

For a regional event, run the same command **in the recovery Region** with
`--source-db-instance-automated-backups-arn` set to the exact replicated native
backup ARN and prove the requested timestamp lies inside its restore window.
Do not substitute the source DB identifier from an unavailable Region. If
native PITR is impaired, restore the newest verified RDS snapshot ARN from the
compliance-locked recovery AWS Backup vault and label its recovery point as the
snapshot completion time, not PITR.

Wait for `available`, confirm the endpoint is reachable only from the isolated
recovery tasks, and collect RDS events. Apply no new migrations until the
restored migration version and candidate application compatibility are known.

Run the database integrity checks performed by
[`../../scripts/backup/verify-postgres-backup.sh`](../../scripts/backup/verify-postgres-backup.sh)
through an equivalent isolated runner, then start an isolated application stack
on the exact release digest. `/api/ready` must return HTTP 200 with every probe
passing; `/api/v1/healthz` alone is insufficient.

## Self-managed WAL-G PITR drill/recovery

The destructive exercise uses the real base-backup/WAL path and never accepts
a mutable image tag:

```bash
export AWS_REGION=PRIMARY_OR_REPLICA_REGION
export BACKUP_IMAGE='ghcr.io/OWNER/postwave-backup@sha256:DIGEST'
export WALG_S3_PREFIX='s3://SOURCE_BUCKET/postgres/prod/clusters/IMMUTABLE_CLUSTER_ID/walg'
export BACKUP_EVIDENCE_BUCKET='PRIMARY_EVIDENCE_BUCKET'
export BACKUP_EVIDENCE_REGION=PRIMARY_EVIDENCE_REGION
export BACKUP_KMS_KEY_ID='PRIMARY_EVIDENCE_KMS_ARN'
export BACKUP_SOURCE_KMS_KEY_ID='EXACT_SOURCE_REGION_BACKUP_KMS_ARN'
export BACKUP_EVIDENCE_SIGNING_KEY_ID='EVIDENCE_SIGNING_KMS_ARN'
export BACKUP_ENVIRONMENT=prod
export BACKUP_IMAGE_CERTIFICATE_IDENTITY='https://github.com/OWNER/REPO/.github/workflows/backup-dr.yml@refs/heads/main'

scripts/backup/restore-drill.sh \
  --database postwave \
  --target-time UTC_TIMESTAMP_BEFORE_EVENT \
  --operator-id INCIDENT_OR_CHANGE_TICKET
```

When reading from the replica region, keep `AWS_REGION` on that source but set
`BACKUP_EVIDENCE_REGION` and `BACKUP_METRIC_REGION` to the primary evidence and
monitoring region. The drill refuses an image whose keyless certificate does
not match the configured main-branch workflow identity. It also refuses a
base backup without the exact checksum-verified signed manifest for the
selected cluster generation. If the primary KMS verification API is
unavailable, use the reviewed PEM plus the retained DER and its checksum exported in advance with
`scripts/backup/export-evidence-public-key.sh`; preserve unsigned local result
material if the signing service itself is unavailable.

For an actual incident, use the same digest and recovery configuration in an
isolated persistent cluster instead of the script's disposable Docker volume.
`restore_command` must remain `/usr/local/bin/postwave-wal-fetch %f %p`; the
wrapper maps storage/configuration failure to a fatal PostgreSQL status rather
than silently treating it as the end of WAL.

## Logical dump fallback

[`../../infra/backup/restore.sh`](../../infra/backup/restore.sh) downloads the
exact version of a custom-format dump, requires an explicitly isolated target,
refuses the known production host, verifies a pre-provisioned target marker,
pins the dump plus all checksum/manifest/signature versions, verifies the exact
SSE-KMS key/S3 checksum/TOC and KMS-signed manifest, creates a new recovery-only
database, restores, and checks core integrity plus an application-role RLS
probe. The owner role must already exist without `SUPERUSER` or `BYPASSRLS`;
the script never creates a login. A logical dump cannot replay to a timestamp
after its snapshot; its timestamp is informational. Record the larger
uncertainty window. The full command and marker-table DDL are in
[`../../infra/backup/README.md`](../../infra/backup/README.md#signed-logical-fallback).

## Application consistency verification

Before traffic, verify all of the following:

- migration checksum/version matches the selected application release;
- tenant-scoped tables retain enabled and forced RLS;
- foreign keys and indexes are valid; database size and core counts are
  plausible against the signed manifest/history;
- audit/outbox timestamps and provider idempotency ledgers match the recovery
  target;
- Listmonk is restored/reconciled to a compatible time and identifier mappings
  pass;
- referenced upload/archive objects exist at correct versions and decrypt;
- required KMS/secrets work without copying production credentials into logs;
- isolated API `/api/ready`, smoke, authentication, tenant isolation, one
  controlled write/read, queue, and provider-disabled tests pass.

Do not assert that outbox replay recovers transactions which never committed or
that every external provider effect can be automatically reversed.

## Regional activation and DNS

Regional recovery requires a complete secondary stack, not only a replica
bucket.

1. Confirm the primary region's writers are fenced at database/network level.
2. Deploy/activate the secondary stack from reviewed IaC using the exact
   application and migration digests.
3. Restore Moosewave and Listmonk from secondary-region sources; restore/verify
   object data and secrets.
4. Keep public desired counts at zero until database/application checks pass.
5. Start secondary services and require dependency-aware `/api/ready` success.
6. Run strict smoke tests directly against the secondary ALB.
7. Only then deploy/enable
   [`../../infra/backup/aws-dns-failover.yaml`](../../infra/backup/aws-dns-failover.yaml)
   using each stack's `AlbDnsName` and `AlbHostedZoneId` outputs, or execute the
   approved equivalent Route 53 change.
8. Resolve the public record from multiple networks, run customer-path smoke,
   watch errors/latency/queues/audit writes, and record traffic recovery time.

The Route 53 template evaluates ALB target health. The primary is preferred;
the secondary becomes eligible only while its target group is healthy. This
does not fence the database, provision a secondary, or prove consistency—those
are operator prerequisites.

## Failback

Failback is a second migration, not an undo button:

1. Keep the recovered region authoritative.
2. Rebuild/restore the original region from the new authoritative state.
3. Verify replication direction and ensure no old primary can accept writes.
4. Pass the full integrity/readiness/smoke suite.
5. Schedule and approve traffic movement; monitor; then fence the temporary
   primary.
6. Preserve both incident and failback evidence and update the runbook.

## Communications

Use observed facts:

> Investigating `<time UTC>`. A database issue is affecting `<scope>`. We have
> stopped unsafe writes and are validating recovery sources. Next update in
> `<interval>`.

> Recovery in progress `<time UTC>`. An isolated restore is being verified.
> We will publish the recovered-data timestamp and customer impact after
> validation; no unverified recovery estimate is being stated.

> Resolved `<time UTC>`. Service validation passed. The newest verified durable
> data in the recovered system is `<timestamp/LSN>`; affected actions between
> `<window>` are being reconciled. Details and follow-ups will be shared through
> the incident process.

Security/privacy events require Security and legal approval before customer
wording. Never promise replay of data that evidence does not show.

## Closeout evidence

An incident or drill closes only when the timeline includes fencing, source
selection, restore start/end, database verification, application readiness,
traffic decision, recovered timestamp/LSN, reconciliation, and teardown. Link
CloudTrail/RDS events, logs, alarms, exact image digests, S3 object versions,
signed evidence keys, smoke output, and follow-up owners/dates.
