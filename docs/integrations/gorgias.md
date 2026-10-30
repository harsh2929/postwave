# Gorgias

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Moosewave's Gorgias connector is a managed partial-native support integration for ticket history, authenticated HTTP integration callbacks, sparse ticket-id callback refresh, bounded commerce evidence preservation, and lookup-only commerce order/customer/product UUID enrichment when `commerce_integration_id` points at an existing commerce integration. It supports credential-reference storage, explicit `/sync` and `/backfill` provider pulls, scheduled bounded continuation, vault-backed callback authentication with durable delivery idempotency, canonical support ticket/profile/event mapping, support sync history, and persisted `provider_cleanup` evidence with best-effort stored HTTP integration deletion on disconnect.

The connector remains partial until real Gorgias helpdesks are certified for the exact official `hmac_secret` signature header/canonical-string behavior, stored HTTP integration deletion behavior, rule/duplicate integration cleanup posture, credential rotation, reconnect, disconnect, live cursor/retry behavior, and data-delete behavior.

## Setup

Create a support integration with:

- `provider`: `gorgias`
- `settings.account_domain`: Gorgias account domain or subdomain, for example `acme.gorgias.com` or `acme`
- `credentials_ref`: vault reference containing `{ "email": "...", "api_key": "..." }`

Optional settings:

- `commerce_integration_id`: existing Moosewave commerce integration used for lookup-only order/customer/product UUID enrichment
- `shop_domain`: Shopify domain label for commerce evidence
- `api_base_url`: explicit API host override for tests or regional routing
- `page_size`: ticket page size, capped at 100
- `webhook_secret_ref`: vault reference containing the callback shared secret used in a Gorgias HTTP integration header
- `gorgias_http_integration_id`: optional Gorgias HTTP integration ID used to constrain callback routing
- `backfill_on_connect`: set to `false` to opt out of automatic bounded history import

Raw API-key material and webhook secrets are not accepted in public integration settings.

## Runtime

Empty `/sync` and `/backfill` calls pull from `GET /api/tickets` using email/API-key Basic auth, `limit`, `cursor`, and `updated_datetime:desc` ordering. The puller maps embedded customer email/name evidence, preserves bounded payload-present commerce evidence, stores stable `gorgias://ticket/{id}` source IDs, enriches commerce UUIDs when `commerce_integration_id` is configured, and persists `gorgias:` cursor checkpoints.

Commerce evidence extraction remains lookup-only and commerce-row preserving. When ticket or callback payloads include direct order fields, line items, or `customer.integrations` blocks, Moosewave copies stable non-secret evidence such as Shopify order/customer IDs, order number/status/total/currency/timestamps, line-item product/variant/SKU candidates, and Recharge subscription ID/status into ticket/message properties. When `commerce_integration_id` is configured, Moosewave resolves that evidence against existing `commerce_orders`, `commerce_customers`, `commerce_products`, and `commerce_product_variants`, including single-order-line product fallback. It does not copy raw integration blobs, credentials, or webhook secrets, and it does not create or refresh commerce rows; unresolved matches carry refresh-required handoff metadata for the commerce integration owner.

Connect-time history import, when enabled, reloads the support row before each provider page and stops before Gorgias calls, canonical writes, or run recording if the row has been disconnected.

Scheduled continuation scans a widened 1,000-row candidate window of stale connected, active, or errored Gorgias rows, skips not-due `gorgias_retry:` cursors before spending the runnable target limit, runs bounded 10-page ticks, records scheduled support sync runs, and stores `gorgias_retry:` cursors with attempt count, next attempt time, status, error evidence, and the underlying Gorgias cursor.

Manual empty `/sync` and `/backfill` calls use the stored `sync_cursor` when no cursor is supplied and understand the same `gorgias_retry:` cursor envelope as scheduled continuation. Not-due retry cursors return the stored cursor without calling Gorgias or writing a sync run; due retry cursors resume the underlying `gorgias:` cursor. Provider failures persist `BACKFILL_FAILED` retry state, and local sync-run failures attempt `SYNC_FAILED` retry state for the pre-fetch cursor.

Authenticated HTTP integration callbacks land at:

```text
POST [historical public callback path redacted]
```

Configure a Gorgias HTTP integration with `POST`, JSON content, trigger events such as `ticket-created`, `ticket-updated`, and `ticket-message-created`, and a custom header such as `X-Gorgias-Webhook-Secret: <vault secret value>`. Moosewave resolves the integration by `settings.account_domain` and optional `gorgias_http_integration_id`; when a delivery supplies an integration id it must match exactly, and unscoped deliveries only match unscoped rows. Moosewave fetches `webhook_secret_ref`, rejects unauthenticated deliveries, claims the account-domain/integration/body-hash delivery in `support_webhook_events`, decodes numeric IDs without float rounding, and maps ticket/message JSON payloads to canonical support rows. When an authenticated callback contains only a ticket id, Moosewave refreshes `GET /api/tickets/{id}` with the configured Gorgias credentials and maps the embedded customer before acknowledging the delivery. Processed replays return `200 OK` without refetching; in-progress duplicates return `503` with `Retry-After`; missing/deleted tickets are marked processed and ignored.

The callback verifier also accepts common SHA-256 HMAC header shapes for certification testing, but Moosewave does not yet claim Gorgias' official `hmac_secret` signing contract until a live helpdesk delivery proves the exact signature header and canonical string.

## Disconnect And Cleanup

`DELETE /api/v1/support-integrations/{id}` marks the local Gorgias row disconnected, stops scheduled ticket pulls, makes manual `/sync`, `/backfill`, admin `/ingest`, and pause return `409 integration_disconnected`, prevents authenticated HTTP integration callback routing from resolving that row, preserves support sync/webhook audit history, and returns plus persists `settings.provider_cleanup` readiness evidence. Stale run recording cannot revive the disconnected row or mutate its cursor/timestamp/error fields. Reconnect/upsert from a disconnected row clears the old cursor and sync timestamp and replaces stale routing settings with the new normalized settings.

That evidence records `status=operator_action_required`, the account domain and HTTP integration ID when known, local Moosewave stop effects, credential/webhook-secret presence booleans including `gorgias_webhook_secret_ref`, and checklist actions for Gorgias API-key revocation or rotation, HTTP integration callback target deletion, and duplicate/manual HTTP integration audit. When `gorgias_http_integration_id` is stored and a cleaner is configured, Moosewave calls `DELETE /api/integrations/{id}` before the local disconnect is saved; `204` records `webhook_cleanup_status=deleted`, `404` records `already_absent`, and provider failures record `failed_operator_cleanup_required` without blocking the local disconnect. API-key revocation, rules that still reference the integration, duplicate/manual HTTP integration audit, and live cleanup proof remain operator-managed.

## Validation Checklist

- Create a Gorgias integration with email/API-key credentials.
- Confirm empty `/sync` or `/backfill` imports ticket rows and support profile/events.
- Configure `webhook_secret_ref`, send an authenticated HTTP integration callback to `[historical public callback path redacted]`, and confirm invalid secrets return `401`.
- Include Shopify or Recharge order context in a REST fixture or authenticated callback and confirm stable non-secret evidence appears in ticket/message properties without raw integration blobs or credential fields.
- Configure `commerce_integration_id` with existing commerce rows and confirm ticket/message/event properties include resolved order/customer/product UUIDs; confirm unresolved candidates carry refresh-required handoff metadata without creating commerce rows.
- Send an authenticated sparse ticket-id callback and confirm Moosewave refreshes the ticket through `/api/tickets/{id}`, replays do not refetch, transient refresh failures return retryable `503`, and missing/deleted tickets are processed without a sync run.
- Force a `429` or `5xx` response with `Retry-After` and confirm Moosewave stores a `gorgias_retry:` cursor; confirm a not-due retry cursor skips provider calls in manual pulls and is skipped by the widened scheduled candidate scan, and confirm a due retry cursor resumes the embedded provider cursor without resetting attempts.
- Send a sparse callback with a large numeric ticket ID and confirm the exact ID is used for `/api/tickets/{id}` refresh and canonical source IDs.
- Live-confirm Gorgias `hmac_secret` header/canonical-string behavior before claiming official signed callback support.
- Disconnect and confirm the response plus saved settings include `provider_cleanup` evidence; with a stored `gorgias_http_integration_id`, confirm the cleanup status records deleted/already-absent or a non-secret provider failure while Gorgias-side API-key, rule-reference, and duplicate/manual cleanup remain operator-managed.
- Live-certify reconnect, disconnect, API-key rotation/revocation, and data-delete behavior before promotion.

## References

- Gorgias Retrieve Ticket API: https://developers.gorgias.com/reference/get-ticket
- Gorgias Delete Integration API: https://developers.gorgias.com/reference/delete-integration
