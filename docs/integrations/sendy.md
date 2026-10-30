# Sendy Native Foundation

Status: Native / partial.

Moosewave exposes `sendy` as a native marketing provider row while preserving the migration cutover tile as `sendy-migration`. The native row owns CSV-export reference setup, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `sendy_handoff` delegated CSV cursor evidence.

## Current Surface

- Catalog slug: `sendy`
- Migration slug: `sendy-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `account_id`, `export_bundle_ref`, `migration_job_id`, `import_cursor`
- Delegated data plane: `sendy_migration_csv_export`

## Boundaries

Sendy's current migration path is CSV-export based because the provider API does not expose a complete subscriber-list export surface. Native provider API export, webhooks, source-event polling, writeback, cleanup automation, and live account validation remain future work.

## Promotion Blockers

- Certify a provider API/export path or keep the CSV-export posture explicit.
- Add active provider-row scheduler execution and cleanup automation.
- Live-certify reconnect, disconnect, and data-delete behavior.
