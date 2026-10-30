# BigCommerce Native Integration

Moosewave's BigCommerce connector is a managed commerce integration backed by BigCommerce Admin REST APIs, managed `/v3/hooks`, and Moosewave commerce sync state. The connector remains `Native / partial` until a live BigCommerce certification run proves API-account scopes, webhook delivery, reconnect, disconnect, and data-delete behavior against a real store.

## Runtime Endpoints

- Create or update connection: `POST /api/v1/commerce/integrations`
- Sync now: `POST /api/v1/commerce/integrations/{id}/sync`
- Backfill: `POST /api/v1/commerce/integrations/{id}/backfill`
- Pause: `POST /api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`
- Webhook callback: `POST /api/public/commerce/bigcommerce/webhooks`
- Unified facade: `GET /api/v1/integrations/catalog`, `GET /api/v1/integrations/connections`, and `GET /api/v1/integrations/bigcommerce/health`

## BigCommerce API Account Setup

Create a dedicated BigCommerce API account for Moosewave. Store the access token in the existing Moosewave credential/secret system and save only the credential reference on the integration row. BigCommerce store-level access tokens are static, so rotate by deleting or replacing the API account in the BigCommerce control panel.

Required setup fields:

- `provider`: `bigcommerce`
- `settings.store_hash`: the raw BigCommerce store hash, or a BigCommerce API URL containing `/stores/{store_hash}`
- `settings.credential_ref`: secret reference containing the access token, for example `{ "access_token": "..." }`

Optional setup fields:

- `settings.channel_id`: limits order backfill where a channel-specific view is required
- `settings.webhook_auth_ref`: reference for the Moosewave-owned webhook callback secret
- `settings.api_base_url`: test-only override; production defaults to `https://api.bigcommerce.com`

Example:

```json
{
  "provider": "bigcommerce",
  "settings": {
    "store_hash": "abc123",
    "credential_ref": "vault://commerce/bigcommerce/abc123",
    "channel_id": "1",
    "webhook_auth_ref": "vault://commerce/bigcommerce/abc123/webhook"
  }
}
```

The API account must be able to read customers, products, and orders. Managed hook reconciliation also requires the account to create, update, and delete the Moosewave-owned `/v3/hooks` records. Keep the account scoped to the minimum permissions needed for those tasks.

## Sync Behavior

Manual sync and backfill accept canonical rows, or an empty body to pull the next provider page through the saved credential reference.

- Customers: `GET /stores/{store_hash}/v3/customers`
- Products: `GET /stores/{store_hash}/v3/catalog/products`, including product images
- Variants: `GET /stores/{store_hash}/v3/catalog/products/{product_id}/variants`
- Orders: `GET /stores/{store_hash}/v2/orders`
- Order products: `GET /stores/{store_hash}/v2/orders/{order_id}/products`
- Order coupons: `GET /stores/{store_hash}/v2/orders/{order_id}/coupons`

Customer and product responses use the V3 `data` plus `meta.pagination` envelope. Orders use the V2 array response. Moosewave stores BigCommerce-specific cursor state separately from Shopify, WooCommerce, Adobe Commerce, Stripe, Square, PayPal, and Razorpay so scheduled workers cannot cross provider state machines.

Backfill failures persist a `bigcommerce_retry:` cursor with the object, page cursor, attempt count, next attempt time, last status, and truncated error. BigCommerce `429` responses use `X-Rate-Limit-Time-Reset-Ms` when available and otherwise fall back to bounded exponential backoff. Manual and scheduled due retries resume the stored object/page cursor and preserve the previous attempt history when another provider or sync failure occurs.

If a scheduled target resolves to a row that has since been marked `disconnected`, the worker skips the BigCommerce API call, canonical sync, and cursor write. Disconnected rows also reject pause, cart-recovery link creation, back-in-stock subscription creation, price-drop watcher creation, provider-event writes, and lifecycle evaluation with `409 integration_disconnected`; preserved audit/reporting reads remain available.

## Webhook Behavior

Moosewave reconciles managed BigCommerce hooks through `/v3/hooks` for customer, product, inventory, order, status, refund, and transaction events. Hook creation includes a Moosewave-owned `X-Postwave-Webhook-Secret` custom header, and the public callback rejects requests that do not present the expected header. Reconnects for the same tenant and store hash reuse the existing local webhook secret before hook reconciliation so a provider hook that is reused instead of recreated continues to match the callback secret. The provider catalog reports this verification mode as `postwave_custom_header_secret`.

BigCommerce webhook callbacks are lightweight. The callback payload usually identifies the changed resource through fields such as `producer: stores/{store_hash}`, `scope`, `hash`, `created_at`, and a small `data` object. Moosewave uses the store hash to find the connection, claims webhook idempotency, then fetches the full Admin API record before canonical upsert for customer, product, inventory, order, and order-status changes.

Delete and archive routes write canonical delete evidence. Refund and transaction routes refresh the parent order and write provider-event evidence for refund and transaction analytics.

## Validation Checklist

- API account resolves from `credential_ref`; raw access tokens never appear in public settings.
- `store_hash` normalization accepts raw hashes and BigCommerce API URLs.
- Customer, product, variant, order, order-products, and order-coupons pagination pass against a live store.
- `X-Rate-Limit-Time-Reset-Ms` and transient `429` behavior create bounded retry cursors.
- Managed `/v3/hooks` are created, reactivated, and deleted only when Moosewave owns the endpoint and scope.
- Callback requests are rejected without the `X-Postwave-Webhook-Secret` header.
- Duplicate callback payloads do not double-process canonical rows or provider events.
- Disconnect marks the Moosewave row `disconnected`, preserves audit evidence, returns and persists provider cleanup evidence, and deletes owned hooks only when endpoint/scope ownership is proven.
- BigCommerce API account deletion/revocation is documented as a control panel action.

## Source Notes

- BigCommerce API-account docs describe API account types, static store-level access tokens, access-token handling, and least-privilege scope guidance.
- BigCommerce rate-limit docs describe case-insensitive rate-limit headers, `429` handling, and `X-Rate-Limit-Time-Reset-Ms`.
- BigCommerce webhook docs describe creating `/v3/hooks` with `scope`, `destination`, `is_active`, and optional custom headers.
- BigCommerce event docs show lightweight payloads with `scope`, `store_id`, `data`, `hash`, `created_at`, and `producer`.
- BigCommerce Admin API docs list V3 Customers, V3 Catalog Products, V2 Orders, V2 Order Products, and V2 Order Coupons endpoints used by this connector.
