# Crisp Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Crisp is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, plugin-token Conversations REST backfill, website-scoped empty `/sync` and `/backfill` pulls, scheduled continuation, `crisp:` page checkpoints, `crisp_retry:` retry cursors with provider `Retry-After` timing, signed Crisp plugin-hook ingest, sparse session metadata refresh for webhook payloads that only include a session id, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Credential rotation proof, reconnect certification, provider-side plugin-hook cleanup posture, duplicate/manual callback audit, and live website validation remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `crisp`
- `settings.website_id`: Crisp website identifier.
- `credentials_ref`: vault reference containing JSON with `identifier` and `key` or `token`.

Optional settings:

- `tier`: Crisp API tier header override.
- `api_base_url`: test or regional API host override.
- `page_size`: conversation page size.
- `crisp_webhook_secret_ref`: vault reference used to verify Crisp plugin-hook signatures.
- `crisp_webhook_id`: optional plugin-hook identifier used to constrain signed public webhook routing and retained for cleanup evidence.

Raw plugin tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /v1/website/{website_id}/conversations/{page}` with Crisp plugin-token Basic auth and `X-Crisp-Tier`. Conversations with people/email evidence map to canonical support tickets, profile upserts, and support events. Cursors use `crisp:{page}` and complete at `crisp:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `crisp_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Crisp cursor.

## Webhook Ingest

`POST [historical public callback path redacted]` receives signed Crisp plugin-hook callbacks for a configured website. The handler resolves the connected support row through the website id plus optional `crisp_webhook_id`, verifies `X-Crisp-Signature` with `X-Crisp-Request-Timestamp` and the raw request body, claims delivery ids durably for replay safety, maps dense session/message payloads directly, and refreshes `GET /v1/website/{website_id}/conversation/{session_id}/meta` when the webhook only carries a session id.

Webhook deliveries record support run history with `run_mode=webhook`, `crisp-webhook:` cursors, provider event/id metadata, and canonical message rows when message content is present.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, prevents provider-routed webhooks from resolving this row, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Crisp-side plugin-token rotation/revocation, plugin-hook deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `website_id` and JSON credentials containing `identifier` plus `key` or `token`.
- Run an empty sync and confirm tickets, profile upserts, event tracking, run history, and a `crisp:` cursor.
- Force a transient provider failure and confirm a `crisp_retry:` cursor is stored and later resumes the embedded cursor.
- Send a signed Crisp plugin-hook and confirm durable replay suppression, `run_mode=webhook`, `crisp-webhook:` cursor evidence, and sparse session metadata refresh when only the session id is present.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify Crisp REST paging, signed plugin-hook delivery, certified operator-managed or managed plugin-hook lifecycle, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
