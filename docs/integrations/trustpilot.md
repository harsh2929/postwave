# Trustpilot Native Review Integration

Last updated: 2026-06-30

## Runtime Status

Trustpilot is local-runtime-complete/live-certification-pending for the implemented REST service-review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `trustpilot:` page cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `trustpilot_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

OAuth refresh, product-review expansion, managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live business-unit validation remain open before full availability.

## Setup

- `provider`: `trustpilot`
- `settings.business_unit_id`: Trustpilot business unit identifier.
- `credentials_ref`: vault reference containing Trustpilot API credentials.
- Optional: `locale`, `default_status`.

Raw API credentials and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Trustpilot service review pages for the business unit, advance `trustpilot:{page}` cursors, and complete at `trustpilot:complete`. The mapper imports canonical reviews plus reviewer/event evidence.

## Validation Checklist

- Connect with `business_unit_id` and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, run history, and a `trustpilot:` cursor.
- Confirm OAuth refresh and webhook lifecycle are tracked as remaining work.
