# Chargebee Native Subscription Integration

Last updated: 2026-07-03

## Runtime Status

Chargebee remains `Native / partial` in the catalog, but the implemented REST subscription read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `chargebee:` offset cursor checkpoints, canonical subscription/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `chargebee_retry:` cursors.

Chargebee invoice expansion, webhooks, provider-console credential cleanup proof, reconnect/data-delete certification, and live site validation remain open.

## Setup

- `provider`: `chargebee`
- `settings.site_id`: Chargebee site identifier.
- `credentials_ref`: vault reference containing Chargebee API credentials.
- Optional: `page_size`, `api_base_url`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Chargebee subscriptions with offset pagination from `/api/v2/subscriptions`. The cursor advances as `chargebee:{offset}` and completes at `chargebee:complete`. The mapper imports canonical subscriptions and subscription events.

## Validation Checklist

- Connect with `site_id` and `credentials_ref`.
- Run empty sync/backfill and confirm subscription rows/events, run history, and a `chargebee:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm webhook topics remain suppressed until callback runtime lands.
