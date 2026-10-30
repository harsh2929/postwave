# Brevo Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

Brevo also has a separate `brevo` native-foundation row for provider lifecycle, API-key credential-reference storage, pause/disconnect, run history, and delegated handoff evidence. This `brevo-migration` tile remains the contacts and campaign migration surface.

## Setup

Create or reference a Brevo API credential in the secure credential store, then create the migration job through the migration flow. The native provider row can store `migration_job_id` and `import_cursor` so `/api/v1/marketing-integrations/{id}/sync` can record `brevo_handoff` evidence.

## Coverage

The migration adapter covers contacts/profiles, lists, saved segments, automation inventory, sent email campaign archives, campaign reports, and related migration evidence where Brevo exposes it.

## Boundaries

This surface does not claim templates, SMS/WhatsApp, source-event polling, native webhooks, writeback, suppression-list mirror support, provider-side cleanup automation, or live workspace certification. Promote the separate native `brevo` row only after those provider behaviors are implemented and certified.
