# Reviews.io Native Review Integration

Last updated: 2026-06-30

## Runtime Status

Reviews.io is local-runtime-complete/live-certification-pending for the implemented REST product-review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `reviews-io:` page cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `reviews_io_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Company reviews, questions, invitations, managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live store validation remain open before full availability.

## Setup

- `provider`: `reviews-io`
- `settings.store_id`: Reviews.io store identifier.
- `credentials_ref`: vault reference containing Reviews.io API credentials.
- Optional: `default_status`.

Raw API credentials and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Reviews.io product review pages, advance `reviews-io:{page}` cursors, and complete at `reviews-io:complete`. The mapper imports canonical reviews plus reviewer/event evidence.

## Validation Checklist

- Connect with `store_id` and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, run history, and a `reviews-io:` cursor.
- Confirm company-review/question/webhook coverage remains partial.
