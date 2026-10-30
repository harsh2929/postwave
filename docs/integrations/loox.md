# Loox Native Review Integration

Last updated: 2026-06-30

## Runtime Status

Loox is local-runtime-complete/live-certification-pending for the implemented REST review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `loox:` page cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `loox_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Photo/media deepening, managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live store validation remain open before full availability.

## Setup

- `provider`: `loox`
- `settings.shop_domain`: Shopify domain connected to Loox.
- `credentials_ref`: vault reference containing the Loox API key.
- Optional: `default_status`.

Raw API keys and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Loox reviews with page pagination, advance `loox:{page}` cursors, and complete at `loox:complete`. The mapper imports canonical review rows plus reviewer/event evidence.

## Validation Checklist

- Connect with `shop_domain` and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, run history, and a `loox:` cursor.
- Confirm webhook settings are suppressed until callback runtime lands.
