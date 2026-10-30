# Olark Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Olark is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, Bearer-auth Transcripts REST backfill, transcript item message mapping, route-token authenticated form-posted transcript webhook ingest, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `olark:` offset checkpoints, provider `Retry-After` aware `olark_retry:` retry cursors, canonical support ticket/message/profile/event mapping, support sync run history, durable webhook idempotency, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Credential rotation proof, reconnect certification, first-party signed callback or certified route-token posture, provider-side webhook cleanup posture, duplicate/manual callback audit, and live site validation remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `olark`
- `settings.site_id`: Olark site identifier for ownership and cleanup evidence.
- `credentials_ref`: vault reference containing a bearer token or JSON with `access_token`, `token`, or `api_key`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: transcript page size.
- `olark_webhook_id`: route token required for Olark webhook callbacks. Include it as `/webhooks/{olark_webhook_id}` or `?webhook_id=...` in the Olark webhook URL.

Raw tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /api/v1/transcripts`. Visitor email evidence maps transcripts to canonical support tickets, profile upserts, and support events. Transcript `items` with `MessageToOperator`, `MessageToVisitor`, or `OfflineMessage` kinds map to canonical support message rows with direction, sender type, sender nickname, body, item index, item kind, and item timestamp evidence. Cursors use `olark:{offset}` and complete at `olark:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `olark_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Olark cursor. Olark REST failures preserve provider `Retry-After` headers when present so scheduled retries avoid hammering rate-limited accounts.

## Webhook Behavior

Operator-configured Olark webhooks route to `POST [historical public callback path redacted]`. The handler resolves the active support row by `site_id` plus exact route token, accepts Olark's form `data` field containing transcript JSON or direct JSON test payloads, claims deliveries durably, and reuses the same transcript mapper as the REST backfill.

Webhook deliveries record support run history with `run_mode=webhook`, `olark-webhook:` cursor evidence, provider event metadata, transcript ticket rows, and transcript item message rows. The current Olark guide documents transcript payloads in the `data` form field but does not document a comparable HMAC signature header, so provider-managed signing remains a certification item rather than a local claim.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Olark-side token rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `site_id` and a vault credential token.
- Run an empty sync and confirm tickets, transcript item messages, profile upserts, event tracking, run history, and an `olark:` cursor.
- Configure an Olark webhook URL with `olark_webhook_id` in the path or `webhook_id` query string, send a transcript form post, and confirm `run_mode=webhook`, durable replay suppression, `olark-webhook:` cursor evidence, transcript ticket mapping, and item message mapping.
- Force a transient provider failure with `Retry-After` and confirm an `olark_retry:` cursor is stored with provider-aligned next-at timing and later resumes the embedded cursor.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify Olark transcript paging, webhooks, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
