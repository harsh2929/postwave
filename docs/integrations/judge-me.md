# Judge.me Native Review Integration

Last updated: 2026-06-30

## Runtime Status

Judge.me is local-runtime-complete/live-certification-pending for the implemented REST review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `judge-me:` page cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `judge_me_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live store validation remain open before full availability.

## Setup

- `provider`: `judge-me`
- `settings.shop_domain`: Shopify domain connected to Judge.me.
- `credentials_ref`: vault reference containing the Judge.me API token.
- Optional: `default_status`.

Raw API tokens and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read paged Judge.me reviews, map reviewer identity and review fields into canonical review rows, advance `judge-me:{page}` cursors, and complete at `judge-me:complete`. Reviews without enough identity/product evidence stay bounded by the canonical review sink behavior.

## Validation Checklist

- Connect with `shop_domain` and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, reviewer profile/event fanout, run history, and a `judge-me:` cursor.
- Confirm webhook settings are not exposed until callback handling is certified.
