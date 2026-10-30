# Bold Subscriptions Native Integration

Last updated: 2026-07-03

## Runtime Status

Bold Subscriptions remains `Native / partial` in the catalog, but the implemented REST subscription read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `bold:` page cursor checkpoints, canonical subscription/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `bold_subscriptions_retry:` cursors.

Line-item/order expansion, webhook registration/cleanup, provider-console credential cleanup proof, reconnect/data-delete certification, and live store validation remain open.

## Setup

- `provider`: `bold-subscriptions`
- `settings.shop_identifier`: Bold shop identifier used in the Subscriptions API path.
- `credentials_ref`: vault reference containing Bold Subscriptions API credentials.
- Optional: `store_domain`, `api_version_date`, `page_size`, `api_base_url`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Bold subscriptions with page pagination. The cursor advances as `bold:{page}` and completes at `bold:complete`. The mapper imports canonical subscriptions and subscription events.

## Validation Checklist

- Connect with `shop_identifier` and `credentials_ref`.
- Run empty sync/backfill and confirm subscription rows/events, run history, and a `bold:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm webhook topics remain suppressed until callback runtime lands.
