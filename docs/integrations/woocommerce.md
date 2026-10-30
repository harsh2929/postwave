# WooCommerce Native Integration

Moosewave's WooCommerce connector is a managed commerce integration backed by the WooCommerce WordPress REST API, managed WooCommerce webhooks, and Moosewave commerce sync state. The local runtime is complete for the current REST backfill, signed-webhook, retry, optional Subscriptions evidence, disconnect cleanup, and provider-event slice. The connector remains `Native / partial` until a live WooCommerce certification run proves key setup, pagination, webhook delivery, reconnect, disconnect, retry, and data-delete behavior against a real store.

## Runtime Endpoints

- Create or update connection: `POST /api/v1/commerce/integrations`
- Sync now: `POST /api/v1/commerce/integrations/{id}/sync`
- Backfill: `POST /api/v1/commerce/integrations/{id}/backfill`
- Pause: `POST /api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`
- Webhook callback: `POST /api/public/commerce/woocommerce/webhooks`
- Unified facade: `GET /api/v1/integrations/catalog`, `GET /api/v1/integrations/connections`, and `GET /api/v1/integrations/woocommerce/health`

## WooCommerce API Key Setup

WooCommerce REST API v3 requires WooCommerce 3.5+, WordPress 4.4+, and non-plain pretty permalinks. Create a dedicated REST API key in WordPress admin under WooCommerce settings and store the consumer key and consumer secret in the Moosewave credential/secret system. Save only the credential reference on the integration row.

Required setup fields:

- `provider`: `woocommerce`
- `settings.store_url`: canonical WordPress/WooCommerce store URL
- `settings.credential_ref`: secret reference containing the consumer key and consumer secret, for example `{ "consumer_key": "ck_...", "consumer_secret": "cs_..." }`

Optional setup fields:

- `settings.subscriptions_enabled`: enable only when WooCommerce Subscriptions is installed and the merchant wants subscription evidence

Example:

```json
{
  "provider": "woocommerce",
  "settings": {
    "store_url": "https://shop.example.com",
    "credential_ref": "vault://commerce/woocommerce/shop-example",
    "subscriptions_enabled": true
  }
}
```

Raw aliases such as `ck`, `cs`, `consumer_key`, or `consumer_secret` are rejected in public integration settings and are only accepted inside referenced secret payloads.

## Sync Behavior

Manual sync and backfill accept canonical rows, or an empty body to pull the next provider page through the saved credential reference.

- Customers: `GET /wp-json/wc/v3/customers`
- Products: `GET /wp-json/wc/v3/products`
- Product variations: `GET /wp-json/wc/v3/products/{product_id}/variations`
- Orders: `GET /wp-json/wc/v3/orders`
- Refunds: `GET /wp-json/wc/v3/refunds`
- Subscriptions: `GET /wp-json/wc/v3/subscriptions` when `subscriptions_enabled` is true

Moosewave uses `per_page` and `page` cursor checkpoints and reads `X-WP-TotalPages` to advance through collection pages. Product variation pages are followed separately for variable products so canonical product variants, inventory snapshots, and price history can be updated.

Orders preserve coupon lines, embedded refunds, payment attribution, transaction IDs, customer notes, line-item SKU/tax/total details, and raw provider evidence. The global refunds endpoint adds cross-order refund provider-event evidence with parent-order attribution. Subscription snapshots remain provider-event evidence until Moosewave has a shared canonical subscription model.

Manual and scheduled backfill failures persist a `woocommerce_retry:` cursor with the object, page cursor, attempt count, next attempt time, last status, and truncated error. Empty manual sync/backfill requests skip provider calls while a retry cursor is not due, unwrap the original `woocommerce:` cursor when retry is due, and write a fresh retry cursor if either the provider pull or canonical sync transaction fails. Transient provider failures use `Retry-After` when available and otherwise fall back to bounded exponential backoff.

If a scheduled target resolves to a row that has since been marked `disconnected`, the worker skips the WooCommerce API call, canonical sync, and cursor write.

## Webhook Behavior

Moosewave reconciles managed WooCommerce webhooks through `/wp-json/wc/v3/webhooks` and stores endpoint/subscription evidence on reconnect. Core managed topics include coupon, customer, product, and order created/updated/deleted events. Subscription created/updated/deleted topics are registered only when `subscriptions_enabled` is true.

WooCommerce signs webhook payloads with `X-WC-Webhook-Signature`, a base64 HMAC-SHA256 hash over the raw body using the configured webhook secret. The callback also uses `X-WC-Webhook-Source`, `X-WC-Webhook-ID`, and `X-WC-Webhook-Delivery-ID` for store resolution and idempotency.

Core customer/product/order webhooks map through the same canonical commerce upsert path as REST backfill. Delete events write durable delete evidence. Coupon, refund, and subscription events are stored as provider-event evidence until Moosewave has dedicated canonical coupon/payment/subscription tables.

Disconnect marks the local integration row `disconnected`, stops normal sync listing, runtime use, and public WooCommerce webhook lookup, and returns plus persists `settings.provider_cleanup` evidence. When stored endpoint metadata is present, Moosewave deletes only Moosewave-managed webhooks matching that endpoint and managed topics with `force=true`; when older/manual rows lack endpoint metadata, Moosewave records skipped cleanup evidence instead. WordPress admin key revocation and legacy or manually created webhooks remain provider-console cleanup actions until live certification proves the full operator flow.

## Validation Checklist

- Store URL normalization rejects unsafe local/internal hosts outside tests.
- Credential references resolve to consumer key/secret pairs; raw keys are never stored in public settings.
- Customers, products, product variations, orders, refunds, and optional subscriptions paginate with `per_page`, `page`, and `X-WP-TotalPages`.
- Webhook reconciliation creates missing hooks, reactivates disabled hooks, stores endpoint evidence, and avoids non-Moosewave hooks.
- `X-WC-Webhook-Signature` verification rejects tampered bodies and accepts valid raw-body HMAC signatures.
- Duplicate webhook deliveries do not double-process canonical rows or provider events.
- Disconnect removes owned webhooks with `force=true` when stored endpoint evidence exists, preserves the local audit row, records `settings.provider_cleanup`, and prevents disconnected rows from resolving future public callbacks.
- Subscription extension coverage is enabled only when the merchant has WooCommerce Subscriptions installed.
- Manual and scheduled retry/backoff behavior is validated against real transient 5xx, 401, and rate-limit conditions.

## Source Notes

- WooCommerce REST API docs identify v3 as the current WP REST API integration version and list WooCommerce/WordPress/permalink requirements.
- WooCommerce API-key docs describe creating consumer key/secret credentials from WooCommerce settings and revoking them from WordPress admin.
- WooCommerce REST API docs describe `per_page`, 1-based `page`, and `X-WP-Total` / `X-WP-TotalPages` pagination.
- WooCommerce v3 docs list the Customers, Products, Product Variations, Orders, Refunds, and Webhooks endpoints used by this connector.
- WooCommerce webhook docs define core coupon/customer/order/product topics, `X-WC-Webhook-Signature`, source/topic/resource/event headers, delivery IDs, and disabling after repeated failed deliveries.
- WooCommerce Subscriptions REST API docs describe v3 support for WooCommerce Subscriptions 3.1+, WooCommerce 3.7+, WordPress 4.4+, and subscription fields such as status, billing period/interval, dates, payment metadata, coupon lines, and line items.
