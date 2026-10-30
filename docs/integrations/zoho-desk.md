# Zoho Desk Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Zoho Desk is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, OAuth-token Tickets REST backfill, ticket Threads REST detail pulls with plain-text inclusion, organization routing, optional department filtering, contact/email enrichment, signed JWT webhook ingest with sparse ticket refresh, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `zoho-desk:` offset checkpoints, `zoho_desk_retry:` retry cursors with provider `Retry-After` timing, durable webhook idempotency, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed notification cleanup readiness evidence on disconnect.

OAuth token rotation/revocation proof, reconnect certification, provider-side notification cleanup posture, duplicate/manual notification audit, data-delete posture, and live helpdesk validation remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `zoho-desk`
- `settings.organization_id`: Zoho Desk organization identifier. `org_id` and `orgId` are accepted aliases.
- `credentials_ref`: vault reference containing an access token or JSON with `access_token` or `token`.

Optional settings:

- `api_base_url`: test or data-center API host override.
- `page_size`: ticket page size.
- `department_id`: optional Zoho Desk department filter. The puller sends `departmentId` and locally skips tickets whose returned `departmentId` does not match.
- `zoho_desk_webhook_id`: optional Zoho Desk webhook id used for strict signed public callback routing.
- `notification_channel_id`: optional provider cleanup evidence for older/manual rows.

Raw tokens and notification secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /api/v1/tickets?include=contacts` with `Authorization: Zoho-oauthtoken ...` and the `orgId` header. When `department_id` is configured, the request includes `departmentId` and the runtime only lands tickets whose returned department matches. Ticket/contact email evidence maps to canonical support tickets, profile upserts, and support events. Cursors use `zoho-desk:{from}` and complete at `zoho-desk:complete`.

For each landed ticket, Moosewave pulls `GET /api/v1/tickets/{ticket_id}/threads`, then hydrates each thread through `GET /api/v1/tickets/{ticket_id}/threads/{thread_id}?include=plainText`. Thread direction, visibility, author type, channel, status, HTML content, and `plainText` content map to canonical support messages.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `zoho_desk_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Zoho Desk cursor. Provider `Retry-After` headers from Zoho Desk REST failures are preserved in `ZohoDeskRESTError` and reused for the next scheduled attempt.

## Webhook Ingest

Zoho Desk webhooks route to `[historical public callback path redacted]`. The route resolves the active support row by `organization_id`, `org_id`, or `orgId` and, when supplied, an exact `zoho_desk_webhook_id`/`notification_channel_id`/`provider_webhook_id`/`webhook_id` match. Unscoped rows only match unscoped deliveries.

The runtime verifies Zoho Desk's `X-ZDesk-JWT` header with the provider JWKS, validates the `orgId:<organization_id>` issuer and `webhookId:<id>` audience when present, claims delivery ids durably for replay safety, extracts the sparse ticket id from common webhook shapes, then refreshes `GET /api/v1/tickets/{ticket_id}?include=contacts` before pulling ticket threads. Webhook refresh honors configured `department_id`; tickets outside the department are ignored after the delivery is marked processed.

This endpoint does not create or delete Zoho Desk webhooks, workflow rules, OAuth tokens, or provider-side notification channels. Those provider-side actions remain certified operator-managed unless a future provider API pass proves a managed lifecycle path.

Reference docs checked for this boundary:

- Zoho Desk webhook setup and `X-ZDesk-JWT` authentication: https://desk.zoho.com/support/WebhookDocument.do

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Zoho-side OAuth/token rotation, notification channel deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `organization_id` and a vault credential token.
- Run an empty sync and confirm tickets, thread message rows, contact enrichment, profile upserts, event tracking, run history, and a `zoho-desk:` cursor.
- Configure `department_id` and confirm ticket pulls send `departmentId` and skip tickets from other departments.
- Confirm thread detail pulls request `include=plainText` and preserve both HTML `content` and `plainText` when Zoho Desk returns them.
- Send a Zoho Desk webhook with a valid `X-ZDesk-JWT` and confirm `run_mode=webhook`, `zoho-desk-webhook:` cursor evidence, durable replay suppression, sparse ticket refresh, thread messages, and strict webhook id routing.
- Force a transient provider failure with `Retry-After` and confirm a `zoho_desk_retry:` cursor is stored with that retry timing and later resumes the embedded cursor.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or notification secret values.
- Live-certify Zoho Desk REST paging, notifications, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
