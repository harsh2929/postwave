# Kayako Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-02

## Runtime Status

Kayako is native runtime-complete with live account certification pending. Moosewave owns credential references, Basic-auth Cases REST backfill, per-case Posts REST message pulls, requester resource/email mapping, route-token webhook sparse case refresh, durable callback idempotency, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `kayako:` offset checkpoints, provider `Retry-After` aware `kayako_retry:` retry cursors, canonical support ticket/message/profile/event mapping, support sync/webhook run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Kayako-side credential rotation proof, provider-console webhook cleanup posture, duplicate/manual callback audits, reconnect certification, data-delete behavior, and live account validation remain open before `RuntimeAvailable` promotion.

## Setup

Create the support integration with:

- `provider`: `kayako`
- `settings.account_domain`: Kayako account domain. `subdomain` and `domain` are accepted aliases.
- `credentials_ref`: vault reference containing JSON with `email` and `api_key`, `password`, or `token`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: case page size.
- `kayako_webhook_id`: route-token webhook identifier used for sparse callback routing and cleanup evidence.

Raw API keys and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /api/v1/cases.json?include=requester`. Requester resources are resolved from the returned resources map and only cases with requester email evidence are written to canonical support tickets, profile upserts, and support events. For each landed case, Moosewave pulls `GET /api/v1/cases/{case_id}/posts.json?filters=MESSAGES` and maps case posts into canonical support message rows with creator, source channel, destination, status, attachment count, HTML/body text, direction, sender type, and timestamp evidence. Cursors use `kayako:{offset}` and complete at `kayako:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `kayako_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Kayako cursor. Kayako REST failures preserve provider `Retry-After` headers when present so scheduled retries avoid hammering rate-limited accounts.

## Webhook Behavior

Kayako route-token callbacks resolve the owning support row by account domain and exact stored `kayako_webhook_id`, claim deliveries in `support_webhook_events`, sparse-refresh the referenced case, and fail closed after disconnect. This is the certified local posture until a provider-managed Kayako webhook lifecycle is proven in live certification.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Kayako-side API-key rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed.

## Validation Checklist

- Connect with `account_domain` and JSON credentials containing `email` plus `api_key`, `password`, or `token`.
- Run an empty sync and confirm requester resolution, tickets, case post messages, profile upserts, event tracking, run history, and a `kayako:` cursor.
- Force a transient provider failure with `Retry-After` and confirm a `kayako_retry:` cursor is stored with provider-aligned next-at timing and later resumes the embedded cursor.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify Kayako case paging, route-token webhook delivery, reconnect, disconnect, credential rotation, duplicate/manual callback audit, provider-console cleanup posture, and data-delete behavior before `RuntimeAvailable` promotion.
