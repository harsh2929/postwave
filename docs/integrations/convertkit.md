# ConvertKit Native Foundation

Status: Native / partial.

Moosewave exposes `convertkit` as a native marketing provider row while preserving the migration cutover tile as `convertkit-migration`. The native row owns OAuth/API-secret credential-reference setup, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `convertkit_handoff` delegated import cursor evidence. Subscriber, tag, segment, sequence, broadcast, forms, landing-page context, and optional Stripe paid-subscription evidence still delegate to the migration adapter until native webhooks, source-event polling, token refresh/revoke certification, writeback, cleanup automation, and live account validation land.

## Current Surface

- Catalog slug: `convertkit`
- Migration slug: `convertkit-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `account_id`, `migration_job_id`, `import_cursor`, `stripe_account_id`
- Delegated data plane: `convertkit_migration_subscriber_broadcasts`

## Delegated Coverage

The delegated adapter imports subscribers, tags, segments, sequences/basic automations, broadcasts/archive/report evidence, forms, landing-page context, and Stripe Connect paid-subscription evidence when available. Visual automations, incentive downloads, commerce products/purchases, native webhooks, and source-event polling are not claimed as native runtime coverage. Native `/sync` and `/backfill` record partial provider-row runs and return `convertkit_handoff:` cursor evidence.

## Disconnect

`DELETE /api/v1/marketing-integrations/{id}` marks the provider row disconnected, rejects further native sync/backfill, preserves run evidence, and stores operator cleanup guidance. OAuth token/API-secret revocation, webhook cleanup, writeback cleanup, Stripe account review, and duplicate provider-console audits remain operator actions.

## Promotion Blockers

- Certify OAuth install, refresh, and revoke behavior against live Kit accounts.
- Add native webhook or source-event polling support.
- Add active provider-row scheduler execution and managed cleanup automation.
- Decide and certify paid-subscription ownership with Stripe Connect evidence.
- Live-certify rate limits, reconnect, disconnect, and data-delete behavior.
