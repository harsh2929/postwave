# Substack Native Foundation

Status: Native / partial.

Moosewave exposes `substack` as a native marketing provider row while preserving the migration cutover tile as `substack-migration`. The native row owns export-bundle credential-reference setup, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `substack_handoff` delegated cursor evidence. Official ZIP/CSV parsing, post archive, aggregate stats, and consent/billing parity evidence delegate to the migration adapter.

## Current Surface

- Catalog slug: `substack`
- Migration slug: `substack-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `publication_url`, `publication_id`, `migration_job_id`, `import_cursor`, `archive_stats_ref`
- Delegated data plane: `substack_migration_export_archive`

## Boundaries

Substack has no claimed native provider API, webhook, source-event polling, writeback runtime, Stripe enumeration, or Apple billing bridge in this foundation. Raw export paths and cookies must stay in referenced secret/export bundles.

## Promotion Blockers

- Certify export-bundle lifecycle and a provider-approved, publication-bound Stripe/Apple billing handoff before offering billing continuity.
- Add active provider-row scheduler execution instead of handoff-only runs.
- Decide whether a native Substack API path exists for ongoing sync.
- Live-certify reconnect, disconnect, cleanup evidence, and data-delete behavior.
