# Moosewave database migrations

Plain numbered SQL files. They are intended to be applied in lexicographic
order:

```
0001_init_tenants.sql
0002_audit_log.sql
0003_subscribers.sql
0004_migration_jobs.sql
...
0027_campaigns.sql
0028_mailchimp_compatibility.sql
0029_commerce_shopify_foundations.sql
0030_mailchimp_productization.sql
```

## How to apply (dev)

```bash
export DATABASE_URL='postgres://postgres:public-local-demo-only@localhost:5432/postwave?sslmode=disable'
go run ./apps/api/cmd/migrate --dir infra/migrations --dry-run
go run ./apps/api/cmd/migrate --dir infra/migrations
```

## Production safety contract

The Go migration runner in
[`apps/api/internal/migrationrunner`](../../apps/api/internal/migrationrunner)
is the only supported apply path. It:

- records a SHA-256 checksum for every applied file in
  `schema_migrations`;
- refuses to apply when an already-applied file changes on disk;
- takes a Postgres advisory lock so rolling deploys do not race DDL;
- statically scans pending migrations for destructive SQL and blocks
  by default on `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, and
  `DELETE FROM`;
- emits warnings for rollback-risk operations such as renames, type
  changes, `SET NOT NULL`, and unique indexes;
- emits a rollback plan for every pending migration. SQL files may declare
  `-- rollback-strategy: expand-contract`, `restore`, `rehearsed-job`, or
  `no-op`, with optional `-- rollback-details:`. Missing low-risk plans are
  inferred; rollback-risk migrations warn when the plan is inferred.

Normal deploys should run the preflight gate before applying:

```bash
DATABASE_URL='postgres://...' scripts/update/preflight.sh
```

That creates a fresh logical backup with checksum + manifest sidecars,
runs the migration dry-run, and fails if drift or destructive blockers
are present. `--allow-unsafe` is a break-glass flag only after a
reviewed backup/restore plan; it is not a routine deploy option.

## Immutable release artifact

Compose, CI, and production use `infra/migrations/Dockerfile`. The image
contains the same Go runner plus the complete SQL directory, a sorted SHA-256
manifest, and a database-state verifier. Its entrypoint fails unless:

> **Applied migrations are immutable byte-for-byte.** Never reformat them or
> change comments, copyright notices, or license headers. Even a comment-only
> edit changes the recorded checksum and correctly blocks the next production
> rollout. Put licensing clarifications in this README and make schema changes
> in a new migration.

The sole governed exception is an exact history split recorded in
`checksum-supersessions.json`. It exists for migration 0339 because the
original empty-schema partition conversion could not upgrade a populated
database containing current-month events. A supersession must name both the
old and current SHA-256 values, include a rationale and expiring owner review,
pass a populated upgrade rehearsal, and satisfy the effective-schema verifier
under both checksums. The runner and release verifier reject every checksum not
listed in that exact old→current pair; this ledger is not a general drift
waiver and must never be edited merely to make a deployment pass.

- migration filenames use unique four-digit numeric prefixes, except for the
  exact already-shipped `1839` pair recorded and fail-closed by
  `scripts/check-migration-numbering.mjs`;
- the on-disk file count, latest version, and every file checksum match the
  values baked at image build time;
- after apply, `schema_migrations` contains exactly that set of versions;
- every recorded database checksum is non-empty and matches the release file.

Production publishes this as `postwave-db-migrator:sha-<full-git-sha>`,
verifies that tag, resolves it to an immutable digest, and runs the digest as
a one-shot private ECS task before application rollout. See
`infra/aws/ecs-migrator-task-definition.json` and step 6 of the AWS production
runbook. A routine release never sets `POSTWAVE_MIGRATOR_ALLOW_UNSAFE`.

Databases created by the retired shell runner can contain `.sql`-suffixed
versions or empty checksums. The verifier deliberately rejects those rows;
reconcile them against a backup and a clean-schema comparison rather than
silently declaring the current files applied.

Example header for a forward-only migration:

```sql
-- rollback-strategy: expand-contract - previous release keeps reading old_col
-- rollback-details: leave this migration applied during rollback; restore from
-- the preflight backup only if validation finds corrupted data.
BEGIN;
...
COMMIT;
```

For an exceptional migration that must commit a brief DDL cutover before a
long DML-compatible validation scan, opt into the restartable phased runner
explicitly:

```sql
-- migration-execution: phased
BEGIN;
-- brief, idempotent lock-taking DDL
COMMIT;

-- long validation statements run after the DDL transaction commits
```

Each phase is checksum- and digest-bound in `schema_migration_steps`; a retry
skips only phases that committed and were durably attested. Use this directive
only when one atomic transaction would hold a hot-table lock across a long
scan. Ordinary migrations remain atomic, and concurrent-index migrations are
phased automatically.

Migration 1754's operator-reviewed drift and exact-resume procedure is in
[`runbooks/1754-merge-field-drift-reconciliation.md`](runbooks/1754-merge-field-drift-reconciliation.md).

## Connecting as the application role

Runtime services should connect as `postwave_app`, not as the migration/admin
role. Local docker creates `postwave_app` with password `postwave_app_dev`, so
the app-side development URL is:

```bash
export DATABASE_URL='postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable'
```

Every per-tenant query must run inside a transaction that first executes:

```sql
SET LOCAL app.tenant_id = '<tenant-uuid>';
```

`apps/api/internal/db.WithTenant(ctx, tenantID)` is the only sanctioned
way to do that from Go.
