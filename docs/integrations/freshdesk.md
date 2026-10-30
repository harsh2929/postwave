# Freshdesk Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-06-29

## Runtime Status

Freshdesk is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave now owns API-key credential references, account-domain normalization, `/api/v2/tickets` REST backfill with embedded requester enrichment, optional local `product_id` filtering, authenticated automation-webhook ingest, sparse ticket refresh, durable callback idempotency, page checkpoints, scheduled `freshdesk_retry:` continuation, `Retry-After` aware provider errors, canonical support ticket/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

It is not yet fully runtime-available. Managed Freshdesk webhook setup/deletion automation and provider-console cleanup remain operator-managed until live helpdesk certification proves the production posture.

## Setup

Create the support integration with:

- `account_domain`: either `acme` or `acme.freshdesk.com`.
- `credentials_ref`: a vault reference containing `{"api_key":"..."}` or a bare API key string.
- Optional `api_base_url`: test or regional host override.
- Optional `page_size`: capped at Freshdesk's 100 item ticket page size.
- Optional `product_id`: positive numeric Freshdesk product ID; local filter applied to returned ticket `product_id` values for multi-product desks.
- Optional `webhook_secret_ref`: vault reference for authenticating Freshdesk automation webhook calls with a shared secret header or bearer token.
- Optional `freshdesk_webhook_id`: automation/webhook identifier used to narrow public route lookup.

Raw API keys and webhook secrets are not accepted in public settings. Store secrets in the credential vault and pass only reference IDs.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls Freshdesk tickets directly from:

`GET /api/v2/tickets?include=requester&order_by=updated_at&order_type=desc&page=N&per_page=M`

Freshdesk API-key auth uses HTTP Basic with the API key as the username and `X` as the password. Ticket rows map into canonical support tickets, subscriber support profiles, and support events using the ticket `email` first and the embedded requester email/name as a fallback. Requester/product/company IDs and requester phone evidence are preserved in ticket properties. If `product_id` is configured, Moosewave filters locally after each raw Freshdesk page by comparing the returned ticket `product_id`; cursors still advance using raw page fullness so skipped pages do not stop a backfill early. Cursors use `freshdesk:<page>` and complete at `freshdesk:complete`.

The scheduled support worker scans stale connected/error Freshdesk rows and resumes up to the configured page budget. Provider failures store `freshdesk_retry:` cursors with attempt count, next attempt time, status, error snippet, and the underlying page cursor.

Manual empty `/sync` and `/backfill` calls use the stored `sync_cursor` when no cursor is supplied and understand the same `freshdesk_retry:` cursor envelope as scheduled continuation. Not-due retry cursors return the stored cursor without calling Freshdesk or writing a sync run; due retry cursors resume the underlying `freshdesk:` page cursor. Provider failures persist `BACKFILL_FAILED` retry state, and local sync-run failures attempt `SYNC_FAILED` retry state for the pre-fetch cursor.

## Webhook Behavior

Freshdesk automation rules can post JSON to:

`POST [historical public callback path redacted]`

Moosewave resolves the integration by normalized Freshdesk account domain plus optional `freshdesk_webhook_id`, requires `webhook_secret_ref`, and authenticates the call using `Authorization: Bearer <secret>`, HTTP Basic password, `X-Freshdesk-Webhook-Secret`, `X-Webhook-Secret`, or `X-Postwave-Webhook-Secret`.

Full ticket payloads are mapped directly. Sparse automation payloads that contain only a ticket ID are refreshed through:

`GET /api/v2/tickets/{id}?include=requester`

Freshdesk callback deliveries are claimed in `support_webhook_events`; processed replays return success, in-flight replays return `503` with `Retry-After`, and provider-rate-limited sparse refreshes are marked retryable for Freshdesk retry.

## Disconnect And Cleanup

`DELETE /api/v1/support-integrations/{id}` marks the local Freshdesk row disconnected, stops scheduled ticket pulls, makes manual `/sync`, `/backfill`, and admin `/ingest` return `409 integration_disconnected`, prevents authenticated automation-webhook routing from resolving that row, preserves support sync/webhook audit history, and returns plus persists `settings.provider_cleanup` readiness evidence. Stale run recording cannot revive the disconnected row or mutate its cursor/timestamp/error fields.

That evidence records `status=operator_action_required`, the account domain and webhook ID when known, local Moosewave stop effects, and checklist actions for Freshdesk API-key rotation or revocation, automation webhook rule deletion, and duplicate/manual webhook audit. Moosewave does not call a Freshdesk cleanup API on support disconnect yet, and the evidence never includes raw credential refs or webhook secret refs.

## Validation Checklist

- Connect using `account_domain=acme.freshdesk.com` and verify the computed API host is `https://acme.freshdesk.com`, not a double-suffixed host.
- Run an empty sync and confirm support tickets, embedded requester fallback mapping, profile upserts, event tracking, run history, and `freshdesk:` cursor updates.
- Force a 429 with `Retry-After` and verify Moosewave persists a `freshdesk_retry:` cursor; confirm a not-due retry cursor skips provider calls and a due retry cursor resumes the embedded provider cursor without resetting attempts.
- Confirm `product_id` is retained and filters returned tickets locally without adding an unsupported provider query parameter.
- Configure a Freshdesk automation webhook with a shared secret header and confirm full plus sparse ticket payloads create webhook-mode support sync history without duplicate replay work.
- Disconnect and confirm the response plus saved settings include `provider_cleanup` readiness evidence while Freshdesk-side API-key and automation-webhook cleanup remain operator-managed.
- Confirm managed Freshdesk webhook setup/deletion automation and live helpdesk certification before promotion.

## References

- Freshdesk API v2 documentation: https://developers.freshdesk.com/api/
