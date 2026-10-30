# MailerLite Native Foundation

Status: Native / partial.

Moosewave exposes `mailerlite` as a native marketing provider row while preserving the migration cutover tile as `mailerlite-migration`. The native row owns API-key credential-reference setup, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `mailerlite_handoff` delegated Connect API cursor evidence.

## Current Surface

- Catalog slug: `mailerlite`
- Migration slug: `mailerlite-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `workspace_id`, `migration_job_id`, `import_cursor`
- Delegated data plane: `mailerlite_migration_connect_api`

## Boundaries

Delegated migration can import subscribers, groups, segments, automations, campaigns, reports, and source-archive rebuild evidence. Native webhooks, source-event polling, writeback, cleanup automation, and live workspace certification remain future work.

## Promotion Blockers

- Live-certify API-key lifecycle, cursor pagination, and rate limits.
- Add native webhook/source-event support or certified scheduled polling.
- Add active provider-row scheduler execution and cleanup automation.
- Certify reconnect, disconnect, and data-delete behavior.
