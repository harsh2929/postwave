# Data safety and update readiness

This is the engineering contract for shipping schema/code changes without
silently losing customer data. Disaster recovery is related but distinct; its
live outcomes are governed by
[`disaster-recovery.md`](disaster-recovery.md), not inferred from a migration
or backup schedule.

## Update standard

For an ordinary software update:

- new code remains compatible with the currently deployed schema during the
  rollout window;
- migrations are forward-only, idempotent, and expand/contract by default;
- the runner blocks destructive SQL unless an approved break-glass path is
  recorded;
- a fresh logical safety backup exists before a risky migration;
- restore/cutover is performed only into a new target after checksum, schema,
  RLS, constraint, index, and application smoke verification.

This minimizes update risk; it is not a mathematical guarantee against bugs,
operator error, provider loss, or an unsafe override. No disaster-recovery
objective is stated until production-scale signed recovery exercises exist.

## Pre-update flow

Run against an appropriately protected production snapshot/connection:

```bash
DATABASE_URL="$PRODUCTION_SNAPSHOT_DATABASE_URL" \
  scripts/update/preflight.sh
```

The preflight:

1. creates a fresh local logical artifact with
   [`../backup/create-postgres-backup.sh`](../../scripts/backup/create-postgres-backup.sh);
2. runs the migration dry-run;
3. fails on migration safety blockers.

`POSTWAVE_SKIP_PREUPDATE_BACKUP=1` is not a production path. Its paired
break-glass variable is for disposable local databases only.

## Migration guardrails

| Guardrail | Effect |
|---|---|
| Advisory lock | Only one runner applies migrations per database. |
| SHA-256 migration checksums | Applied files cannot be edited silently. |
| Per-file transaction/application | A later failure does not hide earlier state. |
| Dry-run plan | Operators see pending files and warnings before deployment. |
| Static scan | Destructive statements are blocked pending explicit review. |

Blocked by default: `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, and broad
`DELETE FROM`. Renames, type changes, `SET NOT NULL`, and unique-index changes
require an online migration plan even when the scanner only warns.

## Backup artifact contracts

The local pre-update script creates a custom-format dump, SHA-256 sidecar, and
JSON manifest. The production logical CronJob additionally uses S3 SHA-256,
SSE-KMS, an asymmetric KMS signature, Object Lock, and cross-region
replication. Physical recovery uses a separate WAL-G base-backup/WAL chain.

Logical manifest row counts are diagnostics observed after the dump. They are
not transactionally bound to the pg_dump snapshot on a live write-heavy
database and therefore must not be used as exact parity gates. Hard integrity
checks are:

- valid custom-format magic and `pg_restore --list`;
- matching artifact and manifest checksums/signature;
- expected migration version/checksums;
- required schema objects;
- enabled and forced RLS for tenant-scoped tables;
- validated foreign keys and valid/ready indexes;
- application readiness and customer-path smoke against an isolated restore.

Counts, database size, and audit timestamps are compared for plausibility and
investigation, with expected write-window differences documented.

## Restore gate

For a logical fallback,
[`../../infra/backup/restore.sh`](../../infra/backup/restore.sh) downloads the
exact dump version and signed sidecars, verifies S3/SHA-256/KMS signature and
TOC, requires an explicitly isolated target and pre-provisioned owner role,
creates a new recovery-only database, restores, and checks the schema. It never
creates an application login or performs traffic cutover.

For physical/PITR qualification,
[`../backup/restore-drill.sh`](../../scripts/backup/restore-drill.sh) restores
the actual WAL-G chain into an inbound-isolated disposable volume, replays to
an explicit timestamp, verifies the database, signs evidence, and destroys the
recovered data. The canonical AWS RDS path uses a new isolated native PITR
instance and equivalent checks.

## Honest recovery measurements

Do not calculate a data-loss promise as `archive_timeout + replication lag`.
The setting controls segment rotation, while failure/retry, upload completion,
provider consistency, restore coverage, transaction timing, and verification
determine the observed outcome.

Record instead:

- newest verified durable transaction timestamp/LSN in the recovered database;
- incident/canary timestamp and observed data-loss interval;
- latest WAL-object age as a separately labelled archive-freshness proxy;
- database restore duration;
- application-ready and traffic-recovery duration;
- source/replica identity, exact image digest, dataset size, and any failed
  attempt.

Repeated production-scale measurements may support an internal objective after
ownership and capacity review. Client wording additionally requires the
appropriate commercial/legal approval.

## Capacity planning

Measure actual compressed dump and daily WAL sizes from the deployed dataset.
For a planning estimate only:

```text
logical bytes ≈ compressed dump bytes × dumps per day × retained days
physical bytes ≈ retained full/delta chains + archived WAL + object versions
restore time = provision + download/fetch + replay + integrity + app readiness + traffic decision
```

Object Lock, versioning, noncurrent versions, replication, multipart overhead,
and evidence retention all add storage. Validate lifecycle behavior in both
regions; a spreadsheet estimate is not a restore test.
