# ConvertKit Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

ConvertKit/Kit also has a separate `convertkit` native-foundation row for provider lifecycle, OAuth/API-secret credential-reference storage, pause/disconnect, run history, and delegated handoff evidence. This `convertkit-migration` tile remains the subscriber and broadcast migration surface.

## Setup

Create or reference a ConvertKit credential in the secure credential store, then create the migration job through the migration flow. The native provider row can store `migration_job_id`, `import_cursor`, and optional `stripe_account_id` evidence so `/api/v1/marketing-integrations/{id}/sync` can record `convertkit_handoff` evidence.

## Coverage

The migration adapter covers subscribers, tags, segments, sequences/basic automations, broadcasts, archive/report evidence, forms, landing-page context, and optional Stripe Connect paid-subscription evidence when available.

## Boundaries

This surface does not claim visual automations, incentive downloads, commerce products/purchases, native webhooks, source-event polling, writeback, provider-side cleanup automation, or token refresh/revoke certification. Promote the separate native `convertkit` row only after those provider behaviors are implemented and certified.
