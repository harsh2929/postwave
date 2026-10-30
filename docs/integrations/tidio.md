# Tidio Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Tidio is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, Tidio OpenAPI client-id/client-secret auth, Tickets page pulls, per-ticket message detail hydration, Contacts page pulls, per-contact conversation message hydration, signed webhook ingest, sparse ticket/contact refresh, optional custom-channel filtering, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `tidio:` checkpoints, `tidio_retry:` retry cursors, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Project public-key setup certification, credential rotation/revocation proof, reconnect certification, provider-side webhook cleanup posture, duplicate/manual webhook audit, data-delete posture, and live Plus/Premium project certification remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `tidio`
- `settings.project_id`: Tidio project identifier for operator evidence.
- `credentials_ref`: vault reference containing JSON with `client_id` and `client_secret`, or equivalent OpenAPI credential keys.

Optional settings:

- `project_public_key`: Tidio webhook route identity from Project Data. Required for signed public webhook routing.
- `tidio_webhook_secret_ref`: vault reference containing the Tidio webhook secret used for `x-tidio-signature`.
- `tidio_webhook_id`: optional Tidio webhook id used to narrow signed public webhook routing.
- `channel_id`: optional custom-channel filter for ticket pulls.
- `api_base_url`: test API host override.

Raw OpenAPI credentials and webhook secrets should be stored in the credential vault and passed only as references in production settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls:

`GET /tickets?cursor=...`

`GET /tickets/{ticketId}`

`GET /contacts?cursor=...`

`GET /contacts/{contactId}/messages?cursor=...`

Tickets with contact email evidence become canonical support tickets. Ticket details provide message rows. Contact pages become contact-scoped conversation tickets, and contact messages become canonical support messages. Tidio response `meta.cursor` values are stored in encoded `tidio:tickets:` and `tidio:contacts:` cursors; completion is `tidio:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `tidio_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Tidio cursor. Provider `Retry-After` values are preserved for retry timing.

## Webhook Behavior

Tidio webhooks route to:

`POST [historical public callback path redacted]`

or:

`POST [historical public callback path redacted]`

The handler resolves the support row by `project_public_key` and optional webhook id, verifies Tidio's documented `x-tidio-signature` HMAC-SHA256 over `{raw_body}_{timestamp}`, claims deliveries durably, and either sparse-refreshes ticket/contact data through OpenAPI or directly maps fully identified contact/ticket payloads.

Webhook deliveries record `run_mode=webhook`, replay suppression evidence, `tidio_webhook_event`, `tidio_project_public_key`, and the scrubbed raw payload on ticket properties.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, prevents signed public webhook routing from resolving the row, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Tidio-side OpenAPI credential rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `project_id`, `project_public_key`, and a vault OpenAPI credential JSON.
- Run an empty sync and confirm `/tickets`, `/tickets/{ticketId}`, `/contacts`, contact-message pagination, ticket/message/profile/event writes, run history, and `tidio:` cursor updates.
- Configure `channel_id` and confirm tickets from other custom channels are skipped without stopping cursor progress.
- Send a Tidio webhook signed with `x-tidio-signature` and confirm sparse refresh or direct mapping, durable replay suppression, `run_mode=webhook`, and `tidio_webhook_event` metadata.
- Force a transient provider failure with `Retry-After` and confirm a `tidio_retry:` cursor is stored and later resumes the embedded cursor.
- Disconnect and confirm local stop effects plus provider cleanup guidance are persisted without raw credential material.
- Live-certify Tidio Plus/Premium OpenAPI access, cursor paging, signed webhooks, project public-key routing, certified operator-managed or managed webhook lifecycle, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.

## References

- Tidio OpenAPI authorization: https://developers.tidio.com/docs/openapi-authorization
- Tidio OpenAPI pagination: https://developers.tidio.com/docs/openapi-pagination
- Tidio OpenAPI rate limiting: https://developers.tidio.com/docs/openapi-rate-limiting
- Tidio contacts and contact messages: https://developers.tidio.com/reference/get_contacts and https://developers.tidio.com/reference/get_contacts-contactid-messages
- Tidio tickets and ticket details: https://developers.tidio.com/reference/get_tickets and https://developers.tidio.com/reference/get_tickets-ticketid
- Tidio webhook structure and signature verification: https://developers.tidio.com/docs/webhooks-structure and https://developers.tidio.com/docs/webhooks-signature-verification
