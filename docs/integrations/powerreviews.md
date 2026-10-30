# PowerReviews Native Review Integration

Last updated: 2026-06-30

## Runtime Status

PowerReviews is local-runtime-complete/live-certification-pending for the implemented REST product-review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `powerreviews:` offset cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `powerreviews_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Q&A, review requests, managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live merchant validation remain open before full availability.

## Setup

- `provider`: `powerreviews`
- `settings.merchant_id`: PowerReviews merchant/account identifier.
- `settings.page_id`: PowerReviews product page identifier to pull reviews for.
- `credentials_ref`: vault reference containing PowerReviews API credentials.
- Optional: `product_id` alias, `locale`, `default_status`.

Raw API credentials and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read PowerReviews review pages, advance `powerreviews:{offset}` cursors, and complete at `powerreviews:complete`. The mapper imports canonical reviews plus reviewer/event evidence.

## Validation Checklist

- Connect with `merchant_id`, `page_id`, and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, run history, and a `powerreviews:` cursor.
- Confirm Q&A/review-request/webhook claims remain partial.
