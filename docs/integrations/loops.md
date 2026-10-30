# Loops Native Foundation

Status: Native / partial.

Moosewave exposes `loops` as a native marketing provider row while preserving the migration cutover tile as `loops-migration`. The native row owns CSV-export bundle references, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `loops_handoff` delegated CSV cursor evidence.

## Current Surface

- Catalog slug: `loops`
- Migration slug: `loops-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `account_id`, `export_bundle_ref`, `migration_job_id`, `import_cursor`
- Delegated data plane: `loops_migration_csv_export`

## Boundaries

The current delegated path imports contact CSV exports and list evidence. API import, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain future work.

## Promotion Blockers

- Build and certify Loops API import before claiming live native sync.
- Add active provider-row scheduler execution and cleanup automation.
- Live-certify reconnect, disconnect, rate limits, and data-delete behavior.
