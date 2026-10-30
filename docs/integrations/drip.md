# Drip Native Foundation

Status: Native / partial.

Moosewave exposes `drip` as a native marketing provider row while preserving the migration cutover tile as `drip-migration`. The native row owns CSV-export bundle references, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `drip_handoff` delegated CSV cursor evidence.

## Current Surface

- Catalog slug: `drip`
- Migration slug: `drip-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `account_id`, `export_bundle_ref`, `migration_job_id`, `import_cursor`
- Delegated data plane: `drip_migration_csv_export`

## Boundaries

The current delegated path imports people CSV exports and tag/list evidence. API import, native webhooks, source-event polling, writeback, cleanup automation, and live account validation remain future work.

## Promotion Blockers

- Build and certify Drip API import before claiming live native sync.
- Add active provider-row scheduler execution and cleanup automation.
- Live-certify reconnect, disconnect, rate limits, and data-delete behavior.
