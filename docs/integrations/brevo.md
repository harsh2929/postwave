# Brevo Native Foundation

Status: Native / partial.

Moosewave exposes `brevo` as a native marketing provider row while preserving the migration cutover tile as `brevo-migration`. The native row owns API-key credential-reference setup, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `brevo_handoff` delegated import cursor evidence. Contacts, lists, segments, automations, and campaign archive import still delegate to the migration adapter; source-event polling, native webhooks, writeback, suppression mirror, cleanup automation, and live workspace certification remain future work.

## Current Surface

- Catalog slug: `brevo`
- Migration slug: `brevo-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `workspace_id`, `migration_job_id`, `import_cursor`
- Delegated data plane: `brevo_migration_contacts_campaigns`

## Delegated Coverage

The delegated adapter imports contacts/profiles, lists, saved segments, automation inventory, sent email campaign archive, and campaign/report evidence where Brevo exposes it. It does not currently claim templates, SMS/WhatsApp, source events, native webhooks, or full suppression-list mirror support. Native `/sync` and `/backfill` record partial provider-row runs and return `brevo_handoff:` cursor evidence.

## Disconnect

`DELETE /api/v1/marketing-integrations/{id}` marks the provider row disconnected, rejects further native sync/backfill, preserves run evidence, and stores operator cleanup guidance. API-key revocation, webhook cleanup, writeback cleanup, suppression cleanup, and duplicate provider-console audits remain Brevo account actions.

## Promotion Blockers

- Certify API-key lifecycle, pagination, and rate limits against a live Brevo workspace.
- Add source-event polling or native webhook ingest before claiming live sync.
- Add suppression mirror/writeback only after provider behavior and consent handling are certified.
- Add active provider-row scheduler execution and managed cleanup automation.
- Live-certify reconnect, disconnect, and data-delete behavior.
