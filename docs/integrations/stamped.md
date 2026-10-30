# Stamped Native Review Integration

Last updated: 2026-06-30

## Runtime Status

Stamped is local-runtime-complete/live-certification-pending for the implemented REST review puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `stamped:` page cursor checkpoints, canonical review/reviewer/event mapping, review sync run history, disconnect-safe local writes, scheduled retry continuation via `stamped_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Questions, loyalty extensions, managed webhook registration/cleanup, signed callback validation, credential cleanup proof, reconnect certification, data-delete behavior, and live store validation remain open before full availability.

## Setup

- `provider`: `stamped`
- `settings.store_id`: Stamped store identifier. `store_hash` or `store_url` are accepted aliases when provided by the credential payload or advanced setup.
- `credentials_ref`: vault reference containing Stamped API credentials.
- Optional: `default_status`.

Raw API keys/secrets and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Stamped review pages, advance `stamped:{page}` cursors, and complete at `stamped:complete`. The mapper imports canonical reviews plus reviewer/event evidence.

## Validation Checklist

- Connect with `store_id` and `credentials_ref`.
- Run empty sync/backfill and confirm review rows, run history, and a `stamped:` cursor.
- Confirm loyalty/question/webhook claims remain documented as gaps.
