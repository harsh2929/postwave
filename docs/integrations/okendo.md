# Okendo Native Review Integration

Last updated: 2026-06-30

## Runtime Status

Okendo is local-runtime-complete/live-certification-pending for the implemented REST review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `okendo:` cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `okendo_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Media/attribute expansion, managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live store validation remain open before full availability.

## Setup

- `provider`: `okendo`
- `settings.store_id`: Okendo store identifier.
- `credentials_ref`: vault reference containing the Okendo API key.
- Optional: `default_status`.

Raw API keys and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Okendo review pages and preserve the provider cursor as `okendo:{cursor}` until `okendo:complete`. The mapper lands canonical reviews, reviewer profile evidence, and review events.

## Validation Checklist

- Connect with `store_id` and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, run history, and an `okendo:` cursor.
- Confirm webhook topics are not advertised before callback certification.
