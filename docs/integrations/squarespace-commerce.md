# Squarespace Commerce Native Integration

Moosewave's Squarespace Commerce connector is a managed partial-native connector for commerce contacts, products, orders, and webhook events. It supports API-key or OAuth credential references, required User-Agent propagation, cursor-paginated REST backfill, product-detail enrichment from the Products API, signed webhook ingest, order fetch fallback, contact delete evidence, extension-uninstall lifecycle handling, durable webhook idempotency, retry cursors, scheduled continuation, and unified Integrations facade health/contract metadata.

Catalog status remains `Native / partial`, but the unified connector contract now reports `native_runtime_complete_live_certification_pending` because the local auth, REST pull, webhook ingest, retry, lifecycle, and operator-managed cleanup posture is complete for the implemented Squarespace Commerce slice. `RuntimeAvailable` promotion still requires live merchant-site certification and OAuth-only webhook subscription cleanup evidence.

## Runtime Endpoints

- Public webhook callback: `/api/public/commerce/squarespace/webhooks`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## Squarespace Setup

1. Create or select a Squarespace API key or OAuth app with the commerce scopes needed for contacts, products, orders, and webhook subscriptions.
2. Store the API key or OAuth token bundle in the Moosewave secret vault and reference it with `credential_ref`.
3. Store the Squarespace webhook subscription secret in the Moosewave secret vault and reference it with `webhook_secret_ref`.
4. Configure the webhook endpoint as:
   - `https://<postwave-public-host>/api/public/commerce/squarespace/webhooks`
5. Subscribe to the events Moosewave handles:
   - `order.create`
   - `order.update`
   - `contact.create`
   - `contact.update`
   - `contact.delete`
   - `extension.uninstall`
6. Save `site_id`, `credential_ref`, optional `webhook_secret_ref`, optional `api_base_url`, and an operator-approved User-Agent on the commerce integration row.

Example credential secret:

```json
{
  "access_token": "SQUARESPACE_API_KEY_OR_OAUTH_ACCESS_TOKEN",
  "api_base_url": "https://api.squarespace.com",
  "user_agent": "Moosewave Squarespace Commerce Integration"
}
```

Example integration payload:

```json
{
  "provider": "squarespace-commerce",
  "shop_domain": "example.squarespace.com",
  "status": "connected",
  "scopes": ["website.contacts.read", "website.products.read", "website.orders.read"],
  "settings": {
    "site_id": "SQUARESPACE_WEBSITE_ID",
    "credential_ref": "vault://integrations/squarespace/primary",
    "webhook_secret_ref": "vault://integrations/squarespace/webhook-secret",
    "user_agent": "Moosewave Squarespace Commerce Integration"
  }
}
```

## Sync Behavior

- Empty sync/backfill requests pull the next REST page using Moosewave's `squarespace:` cursor state.
- Contacts are pulled from `/v1/contacts` and mapped into canonical commerce customers with normalized email, names, marketing consent, default shipping address evidence, and raw provider payloads.
- Products are pulled from `/v2/commerce/products`; when list snapshots omit useful variants, pricing, or images, Moosewave calls `/v2/commerce/products/{productIdCsvs}` and merges the returned detail data before canonical mapping.
- Orders are pulled from `/1.0/commerce/orders` and mapped with customer email, payment/fulfillment status, totals, currency, line-item evidence, timestamps, and raw provider payloads.
- `429` and `5xx` responses produce durable retry cursors that persist the current object, provider cursor, attempt count, next attempt time, last status, and truncated error.
- If a scheduled target resolves to a row that has since been marked `disconnected`, the worker skips Squarespace API calls, canonical sync, and cursor writes.

## Webhook Behavior

- The public callback resolves the integration by `websiteId`.
- `Squarespace-Signature` is verified with HMAC-SHA256 over the raw request payload using the hex webhook secret from `webhook_secret_ref`.
- `order.create` and `order.update` payloads carry `data.orderId`, so Moosewave fetches the full order before canonical upsert.
- `contact.create` and `contact.update` payloads carry contact data and upsert canonical customers.
- `contact.delete` payloads delete customers by provider source ID and retain deletion evidence.
- `extension.uninstall` moves the integration away from active sync.
- Webhook IDs are claimed in the shared webhook ledger before dispatch so retries do not double-ingest.

## Validation Checklist

- Create a dev merchant site and confirm API-key and OAuth credential references both resolve without raw secrets in settings.
- Run an empty backfill and confirm contacts, products, and orders import in sequence.
- Confirm product-list pages that lack variants/images call `/v2/commerce/products/{productIdCsvs}` before mapping product price and image data.
- Confirm `Retry-After` on Contacts, Products, Orders, and product-detail calls writes a `squarespace_retry:` cursor.
- Create or update an order and confirm the webhook fetches the full order by ID before upsert.
- Create, update, and delete a contact and confirm upsert/delete evidence.
- Replay the same webhook ID and confirm idempotent `200` handling without duplicate writes.
- Rotate the webhook secret, update the vault reference, and confirm the old signature fails and the new signature passes.
- Uninstall or revoke the Squarespace extension and confirm the integration stops active sync.
- Disconnect the integration and confirm Moosewave stops local sync, returns/persists `provider_cleanup` readiness evidence, and leaves API-key/OAuth revocation, webhook-secret rotation, and OAuth-only webhook subscription cleanup to the operator certification runbook.
- Open `/api/v1/integrations/squarespace-commerce/health` and confirm the unified facade reports the Squarespace-native runtime plus the remaining live-certification gap, not a generic provider-puller placeholder.

## Source Notes

Squarespace Commerce API requests require `Authorization` and `User-Agent` headers. Current docs list Contacts at `GET /v1/contacts`, Contacts query at `POST /v1/contacts/query`, Products list at `GET /v2/commerce/products`, Products detail at `GET /v2/commerce/products/{productIdCsvs}`, and Orders list at `GET /1.0/commerce/orders`. Webhook subscription management is OAuth-only; API keys are not supported for create/delete/rotate operations. Squarespace only returns webhook secrets when creating a subscription or rotating a secret, so Moosewave stores the secret through the existing vault reference pattern instead of raw integration settings.
