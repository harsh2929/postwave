# Front Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Front is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, optional inbox-scoped REST conversation pulls, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `front:` cursor checkpoints, `front_retry:` retry cursors with provider `Retry-After` timing, signed Front webhook callback ingest, sparse conversation refresh for webhook payloads that only include a conversation id, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Credential rotation proof, reconnect certification, provider-side webhook cleanup posture, duplicate/manual callback audit, and live inbox validation remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `front`
- `settings.inbox_id`: Front inbox identifier for ownership and cleanup evidence.
- `credentials_ref`: vault reference containing a Front API/OAuth bearer token, or JSON with `api_token`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: conversation page size.
- `front_webhook_secret_ref`: vault reference used to verify Front webhook signatures.
- `front_webhook_id`: optional provider webhook identifier used to constrain signed public webhook routing and retained for cleanup evidence.

Raw access tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls Front conversations sorted newest first. When `inbox_id` is configured, the first page uses `GET /inboxes/{inbox_id}/conversations`; otherwise it uses `GET /conversations`. The cursor stores Front's returned next-page URL as `front:{url}` and completes at `front:complete`. Conversations without an email recipient handle are skipped because the canonical support sinks require an email identity.

Scheduled continuation scans stale connected/error rows, resumes bounded pages through the same backfiller, records scheduled support sync runs, and stores `front_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Front cursor.

## Webhook Ingest

`POST [historical public callback path redacted]` receives signed Front callbacks for a configured inbox. The handler resolves the connected support row through the inbox id plus optional `front_webhook_id`, verifies the `X-Front-Signature` HMAC with the timestamp and raw request body, claims delivery ids durably for replay safety, maps dense conversation/message payloads directly, and refreshes `GET /conversations/{id}` when the webhook only carries a conversation id.

Webhook deliveries record support run history with `run_mode=webhook`, `front-webhook:` cursors, provider event/id metadata, and canonical message rows when message text is present.

## Disconnect And Cleanup

`DELETE /api/v1/support-integrations/{id}` marks the local row disconnected, stops manual and scheduled provider pulls, prevents provider-routed webhooks from resolving this row, preserves support run history, prevents local writes from stale runs from reviving the row, and returns plus persists `settings.provider_cleanup` readiness evidence. Front-side token revocation, webhook/rule deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `inbox_id` and `credentials_ref`.
- Run an empty sync and confirm the first page uses the inbox-scoped conversations endpoint, then confirm support tickets, profile upserts, event tracking, run history, and a `front:` cursor.
- Force a transient provider failure and confirm a `front_retry:` cursor is stored and later resumes the embedded cursor.
- Send a signed Front webhook and confirm durable replay suppression, `run_mode=webhook`, `front-webhook:` cursor evidence, and sparse conversation refresh when only the conversation id is present.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify Front OAuth/API-token behavior, signed webhook delivery, certified operator-managed or managed webhook lifecycle, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
