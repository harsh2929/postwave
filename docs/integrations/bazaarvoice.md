# Bazaarvoice Native Review Integration

Last updated: 2026-06-30

## Runtime Status

Bazaarvoice is local-runtime-complete/live-certification-pending for the implemented Display API review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `bazaarvoice:` offset cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `bazaarvoice_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Q&A, syndication feed handling, managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live deployment validation remain open before full availability.

## Setup

- `provider`: `bazaarvoice`
- `settings.client_name`: Bazaarvoice client or deployment identifier.
- `credentials_ref`: vault reference containing Bazaarvoice API credentials.
- Optional: `environment`, `default_status`.

Raw API credentials and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Bazaarvoice Display API reviews using offset pagination, advance `bazaarvoice:{offset}` cursors, and complete at `bazaarvoice:complete`. The mapper imports canonical reviews plus reviewer/event evidence.

## Validation Checklist

- Connect with `client_name` and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, run history, and a `bazaarvoice:` cursor.
- Confirm Q&A, syndication, and webhook behavior remain partial.
