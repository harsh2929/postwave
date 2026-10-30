# Yotpo Native Integration

Catalog status: `Native / partial`.

Moosewave's Yotpo connector is native runtime-complete with live brand certification pending for product review backfill and tokenized webhook review ingest. It supports app-key/secret credential references, Yotpo token exchange, paged Reviews REST pulls, scheduled retry-aware continuation, optional commerce product/order UUID lookup plus resolved review `customer_id` linkage and customer evidence, official `review_create`/`review_updated` payload mapping, integration-scoped `WebhookMessageId` duplicate-delivery protection with body-hash conflict checks, canonical review/reviewer/event mapping, review sync history, persisted operator-managed `provider_cleanup` readiness evidence on disconnect, a local cleanup acknowledgment endpoint for operator attestation, and Retry-After-aware provider errors.

The connector remains `RuntimePartial` in the catalog until real Yotpo brands are certified for review pagination, webhook delivery/signature behavior, provider-side cleanup posture, credential rotation, reconnect, disconnect, and data-delete behavior. Yotpo webhook target/filter/subscription management and signed verification remain live-certification gates; the current webhook path is Moosewave's per-integration tokenized public ingest URL.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/yotpo/connect/start`, `POST /api/v1/integrations/yotpo/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/yotpo/sync`, `POST /api/v1/integrations/yotpo/backfill`, `POST /api/v1/integrations/yotpo/pause`, `DELETE /api/v1/integrations/yotpo`
- Admin create/update: `POST /api/v1/review-integrations`
- Admin webhook-ingest providers: `GET /api/v1/review-integrations/webhook-ingest/providers`
- Admin webhook-ingest endpoints: `GET /api/v1/review-integrations/webhook-ingest`
- Admin webhook-ingest provision/rotate: `POST /api/v1/review-integrations/webhook-ingest`, `POST /api/v1/review-integrations/webhook-ingest/{id}/rotate`
- Manual sync: `POST /api/v1/review-integrations/{id}/sync`
- Backfill: `POST /api/v1/review-integrations/{id}/backfill`
- Tokenized webhook ingest: `POST /api/public/review-integrations/yotpo/ingest/{token}`
- Pause: `POST /api/v1/review-integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/review-integrations/{id}`

## Yotpo Setup

1. Find the Yotpo app key and secret for the brand.
2. Store them in a Moosewave credential reference as JSON with `app_key` and `secret`.
3. Create the integration with `store_id` as the visible store/account label and `credentials_ref` pointing at the secret.
4. Optionally set `api_base_url`, `page_size`, and `commerce_integration_id`.
5. Use the provisioned tokenized ingest URL for Yotpo `review_create` and `review_updated` webhooks if push delivery is needed.
6. Optionally provide `webhook_secret_ref` when provisioning the tokenized webhook-ingest endpoint; the referenced secret is compared against `Authorization: Bearer` or `X-Webhook-Secret` and fails closed if it cannot be resolved.
7. Do not treat this as Yotpo-native signed verification or managed webhook registration; those are not public for this connector until certification work lands.

Example integration payload:

```json
{
  "provider": "yotpo",
  "name": "Yotpo reviews",
  "status": "connected",
  "credentials_ref": "vault://integrations/yotpo/brand",
  "settings": {
    "store_id": "brand-store",
    "credentials_ref": "vault://integrations/yotpo/brand",
    "page_size": 50,
    "commerce_integration_id": "00000000-0000-0000-0000-000000000000"
  }
}
```

Example credential secret:

```json
{
  "app_key": "YOTPO_APP_KEY",
  "secret": "YOTPO_SECRET"
}
```

## Sync Behavior

The Yotpo backfiller reads:

- `POST /oauth/token` for client-credentials token exchange.
- `GET /v1/apps/{app_key}/reviews` for product reviews.

Requests use the exchanged `utoken`, `count`, and `page`. `page_size` is capped at 100. Empty `/sync` and `/backfill` calls pull the next page and store stable `yotpo:` cursors. When the request body omits a cursor, manual sync/backfill falls back to the stored `sync_cursor`. If that cursor is a not-yet-due `yotpo_retry:` cursor, Moosewave returns the same cursor without calling Yotpo or writing a run; due retry cursors unwrap to the underlying Yotpo page cursor. Provider failures persist fresh `BACKFILL_FAILED` retry cursors, and local sync failures after a provider page was pulled persist `SYNC_FAILED` retry cursors for the pre-fetch cursor rather than advancing past an unwritten page. Scheduled continuation over-fetches stale candidates so not-yet-due retry cursors do not starve runnable rows, re-checks disconnected state before provider calls and before local sink writes, runs bounded 10-page ticks, records scheduled review sync runs, and stores `yotpo_retry:` cursors with attempt count, next attempt time, status, error evidence, and the underlying Yotpo page cursor.

The runtime maps Yotpo review IDs, reviewer name/email, score, title/content, verified-buyer evidence, provider `created_at`, provider product evidence, order evidence, and customer evidence into canonical Moosewave review rows. Reviews REST pages default to canonical `approved` status unless a certified status field is added later; tokenized webhook updates can map deleted or archived payloads to `archived`. When `commerce_integration_id` is configured, Yotpo product, order, and customer metadata is resolved against existing `commerce_products`, `commerce_orders`, and `commerce_customers` by UUID, source ID, reviewer email, or already-authoritative order line items before review/profile/event sinks run. Product/order matches fill review `product_id` / `order_id`; if direct product lookup misses after order resolution, Moosewave can resolve the product from the matched order's line items when product/variant/source/SKU evidence points to exactly one line item or the resolved order has one line item. Customer matches fill review `customer_id` plus `resolved_customer_id` metadata and profile/event properties. Missing or ambiguous direct matches stay metadata-only and do not create commerce rows.

Review payload product evidence does not create or refresh `commerce_products`, even when a payload contains a product title. Unresolved product lookup misses are tagged with `product_refresh_required`, `product_refresh_reason=commerce_product_lookup_miss`, the target commerce integration, and product candidate IDs so a commerce-owned refresh path can act later. Broader product refresh still needs either a certified Yotpo product source or a commerce-provider-owned targeted refresh contract so catalog ownership, price, inventory, and variant state stay authoritative.

## Webhook Ingest Behavior

The tokenized public ingest endpoint accepts official Yotpo `review_create` and `review_updated` JSON payloads, using either the payload's root `event` field or Yotpo's `X-Yotpo-Webhooks-Event-Type` header to identify the event type. It maps `data.id`, `data.customer_email`, `data.reviewer_display_name`, `data.score`, `data.title`, `data.content`, `data.verified_buyer`, `data.created_at`, `data.updated_at`, `data.archived`, and `data.deleted` into canonical review rows. It preserves `data.external_product_id`, `data.product_id`, `data.external_order_id`, `data.order_id`, `data.external_customer_id`, and `data.customer_id` / nested customer IDs in metadata; product, order, and customer evidence can fill UUID-backed fields only through the configured commerce lookup described above. `review_updated` emits `review.updated`; deleted or archived payloads land as canonical `archived` reviews. Non-review Yotpo events, such as review-request eligibility notifications, are ignored by the review mapper.

The ingest path rejects provider/token path mismatches before body processing, fails closed if a configured shared-secret reference cannot be resolved, compares that optional shared secret in constant time, rejects conflicting body/header event types, and claims `WebhookMessageId` deliveries before processing so provider retries do not duplicate reviews/events once a message is processed. Delivery claims are scoped to the owning integration; same-message replays with a different body hash fail with `409 webhook_body_mismatch`, while in-progress deliveries return `503` plus `Retry-After`. The provisioning endpoint accepts `webhook_secret_ref` as a vault reference and rejects raw secret-looking values.

This is not yet signed provider-managed webhook support. Yotpo documents JSON payloads and delivery headers including `WebhookMessageId` and `X-Yotpo-Webhooks-Event-Type`; this connector still needs live certification for any signature material and provider target/filter/subscription cleanup posture.

## Disconnect And Cleanup

`DELETE /api/v1/review-integrations/{id}` marks the local Yotpo row disconnected, stops scheduled review pulls, rejects manual sync/backfill, direct admin ingest, and pause with `409 integration_disconnected`, prevents tokenized review webhook-ingest routing from resolving that row, preserves review sync/webhook audit history, and returns plus persists `settings.provider_cleanup` readiness evidence. Scheduled, manual, webhook, and connect-time backfill paths re-check disconnected state before local sink writes; stale run-recording paths preserve disconnected row status, cursor, timestamp, and error fields instead of reviving the row. Reconnecting a disconnected named Yotpo row replaces stale settings, clears old cleanup evidence, and resets cursor/timestamp/error state.

That evidence records `status=operator_action_required`, the Yotpo store/account label, local Moosewave stop effects, credential/tokenized-ingest/webhook-secret presence booleans only, and checklist actions for Yotpo app-secret or API credential rotation, provider-console webhook target/filter/subscription cleanup, tokenized ingest URL removal, and duplicate/manual webhook audit. Moosewave does not call a Yotpo cleanup API on review disconnect yet, and the evidence never includes raw credential refs, webhook secret refs, or tokenized ingest tokens.

After an operator completes the Yotpo-side checklist, call:

```text
POST /api/v1/review-integrations/{id}/provider-cleanup/acknowledge
```

The request accepts `completed_actions`, `notes`, and optional `acknowledged_by`, then merges `status=operator_acknowledged`, `acknowledged_at`, `completed_actions`, and `operator_notes` into the existing `settings.provider_cleanup`. Supported action keys are `app_secret_or_api_credentials_rotated`, `webhook_target_filter_or_subscription_removed_or_disabled`, `tokenized_ingest_urls_removed`, `duplicate_or_manual_webhook_targets_audited`, and `provider_console_cleanup_reviewed_no_action_due`. This is Moosewave-side operator attestation only; it does not call Yotpo APIs or prove provider-managed cleanup.

## Remaining Native Gaps

- Yotpo-native signed webhook verification if signature material is available during certification, managed target/filter/subscription lifecycle, and provider-side review refresh behavior.
- Managed provider-side cleanup automation or certified operator-managed proof for Yotpo webhook target/filter/subscription cleanup; the current cleanup posture is documented/operator-managed and can be locally acknowledged after operator cleanup.
- Broader product refresh behavior remains optional future product scope beyond lookup-only product/order/order-line matching; review payload product evidence alone is intentionally not treated as an authoritative catalog write.
- Live brand certification for auth, pagination, 429/Retry-After behavior, reconnect, disconnect, credential rotation, and data-delete behavior.

## Validation Checklist

- Create a Yotpo integration using a credential secret with `app_key` and `secret`.
- Run empty `/sync` and `/backfill` requests and confirm token exchange, review page fetch, stable `yotpo:` cursor output, and canonical review/profile/event imports.
- Validate `page_size` at 25, 50, and 100.
- Configure `commerce_integration_id` for a store with existing commerce products/orders/customers and confirm Yotpo product/order/customer metadata resolves to Moosewave review `product_id`, review `order_id`, review `customer_id`, and `resolved_customer_id` metadata/profile/event evidence; replay with a direct product miss but a single or explicitly matched resolved order line item and confirm `product_resolution=commerce_order_line_items`; replay with missing or ambiguous commerce rows and confirm the review still imports metadata-only with product-refresh handoff metadata without creating or refreshing `commerce_products`.
- Validate Retry-After handling on simulated or live 429 responses for both token exchange and review pulls, and confirm scheduled failures store a `yotpo_retry:` cursor.
- Validate manual empty `/sync` and `/backfill` with a stored `yotpo_retry:` cursor: not-due cursors should skip Yotpo calls, due cursors should resume the embedded page cursor, and repeated provider failure should increment retry attempts instead of resetting them.
- Validate a provider-pulled page where local review/profile/event writes all fail and confirm the persisted cursor is `SYNC_FAILED` for the pre-fetch page cursor.
- Post a documented `review_create` and `review_updated` body to the provisioned tokenized ingest URL and confirm canonical review/profile/event imports.
- Replay the same `WebhookMessageId` and confirm the second identical delivery is acknowledged as a duplicate without importing another review/event; replay the same ID with a different body and confirm `409 webhook_body_mismatch`.
- Confirm `webhook_secret_ref` is accepted only on tokenized webhook-ingest provisioning as a vault reference, and is not advertised as signed/provider-managed Yotpo webhook verification.
- Rotate the Yotpo app secret and verify the credential reference update path.
- Disconnect and confirm the response plus saved settings include `provider_cleanup` readiness evidence while Yotpo-side credential and webhook target/filter/subscription cleanup remains operator-managed.
- After provider-console cleanup, call `POST /api/v1/review-integrations/{id}/provider-cleanup/acknowledge` and confirm saved `provider_cleanup` records `status=operator_acknowledged` without exposing raw credential refs or tokenized ingest tokens.
- After disconnect, confirm manual sync/backfill returns `409 integration_disconnected`, direct admin ingest and pause are also rejected, the public tokenized webhook URL returns not found, and scheduled continuation does not call Yotpo or mutate the disconnected row.

## Source Notes

- Yotpo app key and secret: `https://apidocs.yotpo.com/reference/finding-your-app-key-and-api-secret.md`
- Yotpo retrieve all reviews: `https://apidocs.yotpo.com/reference/retrieve-all-reviews.md`
- Yotpo webhooks overview: `https://develop.yotpo.com/reference/about-webhooks.md`
- Yotpo events: `https://develop.yotpo.com/reference/yotpo-events.md`
