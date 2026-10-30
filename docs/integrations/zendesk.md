# Zendesk

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Moosewave's Zendesk connector is a managed partial-native support integration for ticket history, opt-in Incremental Export pulls, signed ticket/comment callbacks, and sparse ticket-id callback refresh. It supports credential-reference storage, explicit `/sync` and `/backfill` provider pulls, scheduled bounded continuation, Zendesk-signed webhook ingest with durable delivery idempotency, canonical support ticket/profile/event mapping, support sync history, and persisted `provider_cleanup` evidence with best-effort deletion of the stored Zendesk webhook ID on disconnect.

The connector remains partial until real Zendesk workspaces are certified for Incremental Export behavior, webhook delivery/signature behavior, stored-webhook deletion, credential rotation, reconnect, disconnect, and data-delete behavior. Zendesk trigger/automation cleanup, duplicate/manual target audit, and OAuth/API-token revocation remain operator-managed.

## Setup

Create a support integration with:

- `provider`: `zendesk`
- `settings.subdomain`: Zendesk subdomain, for example `acme`
- `credentials_ref`: vault reference containing either an OAuth access token or `{ "email": "...", "api_token": "..." }`

Optional settings:

- `api_base_url`: explicit API host override for tests or regional routing
- `page_size`: Tickets API page size, capped at 100
- `incremental_export_enabled`: set to `true` to use Zendesk Incremental Export instead of the Tickets list cursor
- `incremental_start_time`: initial Incremental Export start time as Unix seconds or RFC3339; required when incremental export is enabled and no `zendesk_incremental:` cursor exists
- `incremental_page_size`: Incremental Export page size, capped at 1000
- `webhook_secret_ref`: vault reference containing the Zendesk webhook signing secret
- `zendesk_webhook_id`: optional Zendesk webhook id used to constrain public webhook routing
- `backfill_on_connect`: set to `false` to opt out of automatic bounded history import

Raw access tokens, API tokens, and webhook secrets are not accepted in public integration settings.

## Runtime

Empty `/sync` and `/backfill` calls pull from `GET /api/v2/tickets.json` with `include=users` by default. The puller maps requester emails from side-loaded users, stores stable `zendesk://ticket/{id}` source IDs, and persists `zendesk:` cursor checkpoints.

When `incremental_export_enabled` is true, empty `/sync` and `/backfill` calls use `GET /api/v2/incremental/tickets/cursor` with `include=users`. The first request sends `start_time` from `incremental_start_time`; continuation requests send Zendesk's `after_cursor` as `cursor`. Moosewave stores these checkpoints as `zendesk_incremental:` cursors, caps `per_page` at 1000, and stops the current scheduled tick after a page that returns `end_of_stream=true` so the worker does not spin on a caught-up export stream.

Scheduled continuation scans a widened candidate window of stale connected, active, or errored Zendesk rows, skips not-due `zendesk_retry:` cursors before spending the runnable target limit, runs bounded 10-page ticks, records scheduled support sync runs, and stores `zendesk_retry:` cursors with attempt count, next attempt time, status, error evidence, and the underlying Zendesk cursor.

Manual empty `/sync` and `/backfill` calls use the stored `sync_cursor` when no cursor is supplied and understand the same `zendesk_retry:` cursor envelope as scheduled continuation. Not-due retry cursors return the stored cursor without calling Zendesk or writing a sync run; due retry cursors resume the underlying `zendesk:` or `zendesk_incremental:` cursor. Provider failures persist `BACKFILL_FAILED` retry state, and local sync-run failures attempt `SYNC_FAILED` retry state for the pre-fetch cursor.

Signed callbacks land at:

```text
POST [historical public callback path redacted]
```

Configure a Zendesk webhook or trigger to send a JSON body containing ticket/requester fields and, for comments, a `comment` object. Moosewave resolves the integration by `settings.subdomain` and optional `zendesk_webhook_id`; when a delivery supplies a webhook id it must match exactly, and unscoped deliveries only match unscoped rows. Moosewave fetches `webhook_secret_ref`, verifies `X-Zendesk-Webhook-Signature` over `X-Zendesk-Webhook-Signature-Timestamp + raw_body`, claims the subdomain/webhook delivery in `support_webhook_events` using Zendesk invocation/request headers when present and a body-hash fallback otherwise, then maps ticket/comment payloads to canonical support rows. When a signed callback contains only a ticket id, Moosewave refreshes `GET /api/v2/tickets/{id}.json?include=users` with the configured Zendesk credentials and maps the side-loaded requester before acknowledging the delivery. Processed replays return `200 OK` without refetching; in-progress duplicates return `503` with `Retry-After`; missing/deleted tickets are marked processed and ignored.

## Disconnect And Cleanup

`DELETE /api/v1/support-integrations/{id}` marks the local Zendesk row disconnected, stops scheduled provider pulls, makes manual `/sync`, `/backfill`, and admin `/ingest` return `409 integration_disconnected`, prevents signed Zendesk callback routing from resolving that row, preserves sync/webhook audit history, and returns plus persists `settings.provider_cleanup` evidence. Stale run recording cannot revive the disconnected row or mutate its cursor/timestamp/error fields. Reconnect/upsert from a disconnected row clears the old cursor and sync timestamp and replaces stale routing settings with the new normalized settings.

When `zendesk_webhook_id` is stored and the Zendesk cleaner is configured, Moosewave calls `DELETE /api/v2/webhooks/{id}` before the local disconnect write. A `204` records `webhook_cleanup_status=deleted`; a `404` records `already_absent`; provider failures do not block local disconnect and are recorded as `failed_operator_cleanup_required`. Missing webhook IDs are recorded as `skipped_missing_webhook_id`.

The evidence records the Zendesk subdomain and webhook ID when known, local Moosewave stop effects, the managed webhook cleanup result, and checklist actions for Zendesk OAuth/API-token revocation or rotation, trigger/automation target cleanup, and duplicate/manual webhook audit. The evidence never includes raw credential refs or webhook secret refs.

## Validation Checklist

- Create a Zendesk integration using OAuth and API-token credentials.
- Confirm empty `/sync` or `/backfill` imports ticket rows and support profile/events.
- Enable `incremental_export_enabled` with an `incremental_start_time`, confirm the first pull sends `start_time`, the next pull sends `cursor`, and caught-up pages store a `zendesk_incremental:` checkpoint without looping.
- Configure `webhook_secret_ref`, send a signed ticket/comment callback to `[historical public callback path redacted]`, and confirm invalid signatures return `401`.
- Send a signed sparse ticket-id callback and confirm Moosewave refreshes the ticket through `/api/v2/tickets/{id}.json?include=users`, replays do not refetch, transient refresh failures return retryable `503`, and missing/deleted tickets are processed without a sync run.
- Force a `429` or `5xx` response with `Retry-After` and confirm Moosewave stores a `zendesk_retry:` cursor; confirm a not-due retry cursor skips provider calls in manual pulls and does not starve due scheduled targets, and confirm a due retry cursor resumes the embedded provider cursor without resetting attempts.
- Disconnect and confirm the response plus saved settings include `provider_cleanup` evidence. With `zendesk_webhook_id` configured, confirm the stored webhook is deleted or recorded already absent; credential revocation, trigger cleanup, and duplicate/manual target audit remain operator-managed.
- Live-certify reconnect, disconnect, credential rotation/revocation, and data-delete behavior before promotion.

## References

- Zendesk Tickets API: https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/
- Zendesk side-loading: https://developer.zendesk.com/documentation/api-basics/working-with-data/side_loading/
- Zendesk Incremental Exports API: https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/
- Zendesk Webhooks API: https://developer.zendesk.com/api-reference/webhooks/webhooks-api/webhooks/
