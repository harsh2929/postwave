# Drift Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Drift is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, OAuth/Bearer Conversations REST backfill, contact lookup fallback, verification-token authenticated webhook ingest, sparse conversation refresh for ID-only callbacks, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `drift:` cursor checkpoints, `drift_retry:` retry cursors with provider `Retry-After` timing, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Credential rotation proof, reconnect certification, provider-side webhook cleanup posture, duplicate/manual callback audit, and live workspace validation remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `drift`
- `settings.workspace_id`: Drift workspace identifier for ownership and cleanup evidence.
- `credentials_ref`: vault reference containing a bearer token or JSON with `access_token`, `token`, or `api_key`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: conversation page size.
- `drift_webhook_secret_ref`: vault reference for the Drift app verification token.
- `drift_webhook_id`: optional webhook identifier used to constrain public webhook routing and retained for cleanup evidence.

Raw tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /conversations/list`. The backfiller resumes either opaque next cursors or full next-page URLs returned by Drift, and resolves missing email identity through `GET /contacts/{id}`. Conversations with email evidence map to canonical support tickets, profile upserts, and support events. Cursors use `drift:{cursor_or_url}` and complete at `drift:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `drift_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Drift cursor.

## Webhook Behavior

Drift app webhooks route to `[historical public callback path redacted]`. The route resolves the active support row by `workspace_id`, `orgId`, or compatible workspace/organization aliases and, when supplied, an exact `drift_webhook_id`/`provider_webhook_id`/`webhook_id` match. Unscoped rows only match unscoped deliveries.

The runtime verifies Drift's verification token from `X-Verification-Token` or the JSON `token` field against the vault-backed `drift_webhook_secret_ref` or compatible webhook secret reference, checks the payload `orgId` against the route, claims deliveries through durable support webhook idempotency, and redacts the token before persisting raw evidence.

Dense `new_message` and `new_conversation` payloads with contact email evidence map directly into canonical support tickets/messages. Sparse `conversation_status_updated`, `conversation_inactive`, `conversation_manual_push`, and `conversation_push` payloads refresh `GET /conversations/{id}` plus contact lookup before recording `drift-webhook:` cursor evidence.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Drift-side token rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `workspace_id` and a vault credential token.
- Run an empty sync and confirm contact lookup, tickets, profile upserts, event tracking, run history, and a `drift:` cursor.
- Force a transient provider failure and confirm a `drift_retry:` cursor is stored and later resumes the embedded cursor.
- Send a Drift webhook with matching `orgId` and verification token and confirm durable replay suppression, `run_mode=webhook`, `drift-webhook:` cursor evidence, token redaction, and sparse conversation refresh for ID-only callbacks.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify Drift REST paging, verification-token app webhooks, certified operator-managed or managed webhook lifecycle, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
