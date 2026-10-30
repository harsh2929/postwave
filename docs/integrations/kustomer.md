# Kustomer Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Kustomer is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, Bearer-auth Conversations REST backfill, signed outbound webhook ingest, sparse conversation refresh, customer lookup fallback, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `kustomer:` page checkpoints, `kustomer_retry:` retry cursors, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Credential rotation proof, reconnect certification, provider-side webhook cleanup posture, duplicate/manual callback audit, and live workspace validation remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `kustomer`
- `settings.organization_id`: Kustomer organization identifier for ownership and cleanup evidence.
- `credentials_ref`: vault reference containing a bearer token or JSON with `api_key`, `token`, or `access_token`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: conversation page size.
- `kustomer_webhook_secret_ref`: vault reference for Kustomer outbound webhook signature verification.
- `kustomer_webhook_id`: optional webhook identifier retained for cleanup evidence.

Raw tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /v1/conversations` and resolves customer email evidence through `GET /v1/customers/{id}` when needed. Conversations with email evidence map to canonical support tickets, profile upserts, and support events. Cursors use `kustomer:{page}` and complete at `kustomer:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `kustomer_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Kustomer cursor.

## Webhook Behavior

Kustomer outbound webhooks route to `[historical public callback path redacted]`. The route resolves the active support row by `organization_id` and, when supplied, an exact `kustomer_webhook_id`/`provider_webhook_id`/`webhook_id` match. Unscoped rows only match unscoped deliveries.

The runtime requires a vault-backed `kustomer_webhook_secret_ref` or compatible webhook secret reference, verifies the request body HMAC SHA256 signature from Kustomer signature headers, claims deliveries through durable support webhook idempotency, and maps dense conversation/message payloads directly into canonical tickets, messages, profiles, and events.

Sparse callbacks that only include a conversation id refresh `GET /v1/conversations/{id}` and resolve customer email evidence through `GET /v1/customers/{id}` before recording a `kustomer-webhook-*` cursor. Provider `Retry-After` values from refresh failures are returned to the caller and reused by scheduled retry cursor creation.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Kustomer-side token rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `organization_id` and a vault credential token.
- Run an empty sync and confirm customer lookup, tickets, profile upserts, event tracking, run history, and a `kustomer:` cursor.
- Send a signed dense Kustomer webhook and confirm ticket/message/profile/event writes plus durable replay suppression.
- Send a signed sparse conversation callback and confirm `GET /v1/conversations/{id}` refresh, customer lookup, `kustomer-webhook-*` cursor evidence, and retryable `Retry-After` behavior on transient provider failures.
- Force a transient provider failure and confirm a `kustomer_retry:` cursor is stored and later resumes the embedded cursor.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify Kustomer REST paging, signed outbound webhooks, certified operator-managed or managed webhook lifecycle, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
