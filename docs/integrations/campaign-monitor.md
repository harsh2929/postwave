# Campaign Monitor Native Foundation

Status: Native / partial.

Moosewave exposes `campaign-monitor` as a native marketing provider row while preserving the migration cutover tile as `campaign-monitor-migration`. The native row owns CSV-export bundle references, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `campaign-monitor_handoff` delegated CSV cursor evidence.

## Current Surface

- Catalog slug: `campaign-monitor`
- Migration slug: `campaign-monitor-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `account_id`, `export_bundle_ref`, `migration_job_id`, `import_cursor`
- Delegated data plane: `campaign_monitor_migration_csv_export`

## Boundaries

The current delegated path imports subscriber CSV exports and list evidence. API import, native webhooks, source-event polling, writeback, cleanup automation, and live client/account validation remain future work.

## Promotion Blockers

- Build and certify Campaign Monitor API import before claiming live native sync.
- Add active provider-row scheduler execution and cleanup automation.
- Live-certify reconnect, disconnect, rate limits, and data-delete behavior.
