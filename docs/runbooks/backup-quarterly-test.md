# Runbook — quarterly destructive recovery exercise

Cadence: at least once every 100 days, with primary and replica sources
alternated. Owner: Platform on-call. A full regional application/DNS exercise
is separate and must also be scheduled before claiming regional failover.

This file is a checklist and index. Signed objects—not checked boxes—are the
evidence. Blank rows below mean no account-backed result has yet been recorded.
Local CI proves the WAL-G mechanics but must not be entered as a production
drill.

## Preconditions

- [ ] Approved change/ticket and named operator, database owner, incident
      commander for the exercise, and Security contact.
- [ ] Exact backup image digest and application release digest recorded.
- [ ] Break-glass restore credentials are temporary and `aws sts
      get-caller-identity` matches the approved role.
- [ ] Primary/replica buckets, KMS keys, Object Lock, versioning, replication,
      CloudTrail, alarms, and evidence-signing key are healthy.
- [ ] Restore target is isolated from production networking and has no public
      ingress.
- [ ] Enough capacity/quota exists; teardown owner and deadline are assigned.
- [ ] Customer data residency permits the chosen recovery region.

## Source and target selection

- [ ] Choose primary or replica according to the alternating schedule; record
      bucket, region, and object versions.
- [ ] Run `wal-g backup-list --detail --json`; select a completed base backup.
- [ ] Run `wal-g wal-verify integrity timeline --json`; any missing-lost segment
      fails the exercise.
- [ ] Confirm the newest WAL object, base-backup manifest, checksum, KMS
      signature, S3 checksum, and encryption key.
- [ ] Choose an explicit recovery timestamp covered by the selected base/WAL
      chain. Record why it is valid.
- [ ] Record the logical dump fallback and its sidecars, but do not silently
      switch sources if the physical path fails; that failure is evidence.

## Execute physical restore

Set the account-owned values described in
[`../../infra/backup/README.md`](../../infra/backup/README.md), then run:

```bash
scripts/backup/restore-drill.sh \
  --image 'ghcr.io/OWNER/postwave-backup@sha256:DIGEST' \
  --walg-prefix 's3://CHOSEN_BUCKET/postgres/prod/clusters/IMMUTABLE_CLUSTER_ID/walg' \
  --database postwave \
  --target-time 'YYYY-MM-DDTHH:MM:SSZ' \
  --operator-id CHANGE_OR_INCIDENT_ID
```

Set `BACKUP_IMAGE_CERTIFICATE_IDENTITY` to the approved main-branch
`backup-dr.yml` GitHub workflow identity. When restoring from the replica
region, keep `AWS_REGION` on the source but set `BACKUP_EVIDENCE_REGION` and
`BACKUP_METRIC_REGION` to the primary evidence/monitoring region. Set
`BACKUP_SOURCE_KMS_KEY_ID` to the exact source-region backup key and
`BACKUP_KMS_KEY_ID` to the evidence destination key. If primary KMS verification
is impaired, use the independently archived PEM plus the retained DER and its
pinned checksum created by `scripts/backup/export-evidence-public-key.sh`.

- [ ] Script restores a new volume, never the source database.
- [ ] Recovery reaches the requested target and promotes without skipped/fatal
      archive errors.
- [ ] Recovered database has no TCP listener, no cloud credentials, no
      published port, and Docker network mode `none`; WAL was staged and
      checksum-validated before offline replay.
- [ ] Required tables/migrations, forced tenant RLS, foreign keys, indexes, and
      database-size/core-count diagnostics pass.
- [ ] Script proves both recovered-data volumes are absent before signing a
      pass. A cleanup failure is a failed drill and preserves local evidence.
- [ ] Passed/failed JSON, checksum, signature, and `complete.json` commit marker
      exist under the governance-retained evidence prefix; independently run
      `aws kms verify` (or pinned offline public-key verification) against the
      digest.
- [ ] CloudWatch restore-verification metric updated and failure alarms behave
      as designed.

## Canonical RDS exercise

When production uses RDS, also perform the recovery-Region native PITR and
locked-snapshot fallback flows from
[`rds-cross-region-backup.md`](rds-cross-region-backup.md):

- [ ] restore a new non-public instance to an explicit timestamp;
- [ ] restrict it to recovery tasks and preserve the source;
- [ ] run equivalent database verification and an isolated exact-digest
      application stack;
- [ ] require `/api/ready` plus strict customer-path smoke;
- [ ] record RDS events, recovered timestamp/LSN, database restore duration,
      application-ready duration, and teardown;
- [ ] sign and retain an evidence JSON matching the repository drill schema.
- [ ] restore once from replicated RDS automated backups at an explicit time
      and once from the recovery AWS Backup vault's periodic snapshot;
- [ ] confirm native-replication lag/configuration alarms and AWS Backup
      copy/freshness/failure alarms deliver to on-call;

## Regional recovery exercise

- [ ] Fence primary writers and prove fencing before secondary activation.
- [ ] Restore Moosewave, Listmonk, object data, and secrets in the secondary.
- [ ] Use exact application/migration digests and pass full consistency checks.
- [ ] Pass `/api/ready` and direct-ALB smoke before DNS eligibility.
- [ ] Exercise Route 53 failover using
      [`../../infra/backup/aws-dns-failover.yaml`](../../infra/backup/aws-dns-failover.yaml).
- [ ] Verify public resolution/customer paths from multiple networks.
- [ ] Perform controlled failback without simultaneous writers.
- [ ] Capture service-recovery duration separately from database restore
      duration, then destroy recovered customer data not required for evidence.

## Pass/fail

The database drill passes only if the selected source restores to the selected
time, every integrity check passes, signed evidence verifies, and recovered
data is destroyed. The regional drill passes only if the full secondary stack,
consistency checks, readiness, traffic movement, and failback also pass.

There is no hardcoded recovery-time or data-loss promise in this checklist.
Record actual measurements and failure conditions. An operational/commercial
objective may be proposed only after repeated representative results are
reviewed and owned.

## Evidence index

Append; never edit a prior row. Use the evidence object key and signature key
version, not a link that can silently point at a new object version.

| Date | Environment/source region | Operator/ticket | Backup + target | Evidence object/version | Signature verified | DB restore duration | Service-ready duration | Recovered timestamp/LSN | Result/follow-ups |
|---|---|---|---|---|---|---|---|---|---|
| _No account-backed drill recorded_ |  |  |  |  |  |  |  |  |  |
