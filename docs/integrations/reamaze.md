# Reamaze Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-02

## Runtime Status

Reamaze is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, Basic-auth Conversations REST backfill, conversation-scoped Messages REST thread pulls, route-token webhook sparse conversation refresh, durable `support_webhook_events` idempotency, optional original-body HTML preservation, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `reamaze:` page checkpoints, `reamaze_retry:` retry cursors with provider `Retry-After` timing, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Signed callback certification, managed Reamaze webhook registration/cleanup, credential rotation proof, reconnect/disconnect/data-delete certification, duplicate/manual webhook audit, and live account validation remain open before `RuntimeAvailable` promotion.

## Setup

Create the support integration with:

- `provider`: `reamaze`
- `settings.account_domain`: Reamaze account/brand subdomain.
- `credentials_ref`: vault reference containing JSON with `email` and `api_token`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: conversation page size.
- `reamaze_webhook_id`: opaque Moosewave route token embedded in the Reamaze callback URL.

`brand`, `subdomain`, `domain`, and `account_domain` are accepted as credential or settings aliases for the Reamaze brand host. Raw API tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /api/v1/conversations` using Basic auth. Conversations map to canonical support tickets when the author has an email, including status, tags, assignee, category evidence, and the requester profile anchor. Cursors use `reamaze:{page}` and complete at `reamaze:complete`.

For each landed conversation, Moosewave pulls `GET /api/v1/conversations/{slug}/messages?include=original_body` and maps regular, staff-outbound, and internal-note messages into canonical support messages. `body` is stored as text, `original_body` is preserved as HTML when present, and message direction is inferred from Reamaze visibility/origin plus the requester email.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `reamaze_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Reamaze cursor. Provider `Retry-After` headers from Reamaze REST failures are preserved in `ReamazeRESTError` and reused for the next scheduled attempt.

## Webhook Behavior

Operator-configured Reamaze callbacks post to `[historical public callback path redacted]`. The route normalizes the account domain, requires an exact stored `reamaze_webhook_id`, fails closed for disconnected rows, claims delivery IDs in `support_webhook_events`, and sparse-refreshes the conversation slug through `GET /api/v1/conversations/{slug}/messages?include=original_body`.

Dense payloads with conversation and message data can be mapped directly as a fallback, but the preferred path is sparse refresh so canonical tickets/messages are hydrated from Reamaze REST with the same mapping as backfill. Signed provider callback verification and managed webhook registration/deletion remain certification work.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Reamaze-side API-token rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed.

## Validation Checklist

- Connect with `account_domain` and JSON credentials containing `email` and `api_token`.
- Run an empty sync and confirm tickets, message rows, profile upserts, event tracking, run history, and a `reamaze:` cursor.
- Confirm scoped message pulls preserve `original_body` HTML when Reamaze returns it.
- Configure a route-token callback, post a sparse conversation webhook, and confirm `support_webhook_events` idempotency plus a webhook-mode support sync run with `reamaze_webhook_id` metadata.
- Force a transient provider failure with `Retry-After` and confirm a `reamaze_retry:` cursor is stored with that retry timing and later resumes the embedded cursor.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify Reamaze REST paging, route-token or signed webhook posture, managed webhook cleanup, reconnect, disconnect, credential rotation, and data-delete behavior before `RuntimeAvailable` promotion.
