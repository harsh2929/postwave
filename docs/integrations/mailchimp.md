# Mailchimp Native Foundation

Status: Native / partial.

Moosewave exposes `mailchimp` as a native marketing provider row while preserving the migration cutover tile as `mailchimp-migration`. The native row owns credential-reference setup, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `mailchimp_handoff` delegated cursor evidence. Mailchimp API/OAuth import, source archives, and materialization still run through the migration adapter until native webhooks, source-event polling, writeback, cleanup automation, and live account certification are implemented.

Mailchimp OAuth access follows the authorizing user's account role. Our current authorize URL does not request granular read-only scopes; it receives a Marketing API OAuth token that remains valid until revoked or until the user's account access changes. Operator/customer docs should describe role and revocation behavior rather than claiming scoped read-only access.

## Current Surface

- Catalog slug: `mailchimp`
- Migration slug: `mailchimp-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `account_id`, `data_center`, `migration_job_id`, `import_cursor`
- Delegated data plane: `mailchimp_migration_source_archive`

## Delegated Coverage

The delegated migration path can import or preserve selected audiences, members, native tags, groups/interests, static segment membership, the supported saved-segment subset, the validated Classic `welcomeSeries` subset as paused runtime records, campaigns, templates, reports, forms, landing pages, ecommerce source archives, and rebuild tasks. Other Classic workflows remain rebuild-review evidence. Audience selection scopes audience-bound members/merge data, groups/interests, segments, signup-form and audience-schema evidence, list-triggered Classic Automations, campaigns, and reports. Templates, landing pages, and ecommerce evidence are account-wide; other source-archive guidance is either account-global or non-detected, and all of it is labeled. Live commit requires an exact dedicated Listmonk tenant match. Mailchimp's public Marketing API does not provide a general Customer Journey / Automation Flow list or graph export, so the adapter emits one generic, non-detected parity gap rather than Journey inventory or executable automations. Operators must inventory Journeys in Mailchimp and attach rebuild or waiver evidence. The native `/sync` and `/backfill` endpoints record partial provider-row runs and return `mailchimp_handoff:` cursor evidence; they do not yet perform a live native Mailchimp pull by themselves.

## Disconnect

`DELETE /api/v1/marketing-integrations/{id}` marks the provider row disconnected, rejects further native sync/backfill, preserves run evidence, and stores operator cleanup guidance. Mailchimp app uninstall, token/key revocation, webhook cleanup, writeback cleanup, and duplicate provider-console audits remain operator actions.

## Promotion Blockers

- Certify Mailchimp OAuth/public app install, same-job reconnect, access-change,
  and revoke behavior; do not model provider access as a refresh-token expiry.
- Add native source-event polling or provider webhook ingest.
- Add active provider-row scheduler execution instead of handoff-only runs.
- Add provider-side cleanup automation and writeback cleanup evidence.
- Live-certify pagination, rate limits, reconnect, disconnect, and data-delete behavior.
