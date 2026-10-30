# Square Native Integration

Moosewave's Square connector is a managed commerce/payments integration for Square customers, Catalog ITEM products and variations, catalog item deletions, orders, payments, refunds, and signed webhooks. It supports credential-reference auth for Square OAuth seller tokens or app tokens, active-location discovery, cursor-paginated REST backfill, manual and scheduled bounded backfills with retry cursors, raw-body webhook verification using Square's exact notification URL, catalog-version product refresh, customer/product delete evidence, payment-backed order snapshots, refund provider-event evidence, and unified Integrations facade health/contract metadata.

## Runtime Endpoints

- Public webhook callback: `/api/public/commerce/square/webhooks`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## Square App Setup

1. Create or open the Moosewave Square app in the Square Developer Console.
2. Grant read scopes for Customers, Orders, Payments, Items, and merchant profile/location metadata.
3. Store the seller OAuth access token or app token in the Moosewave secret vault.
4. Configure a Square webhook subscription for:
   - `customer.created`
   - `customer.updated`
   - `customer.deleted`
   - `payment.created`
   - `payment.updated`
   - `refund.created`
   - `refund.updated`
   - `catalog.version.updated`
5. Configure the exact webhook notification URL as:
   - `https://<postwave-public-host>/api/public/commerce/square/webhooks`
6. Copy the Square webhook signature key into a Moosewave secret reference.
7. Store credentials and signature keys in secret references, not in integration settings.

Example credential secret:

```json
{
  "access_token": "SQUARE_OAUTH_OR_APP_TOKEN"
}
```

Example integration payload:

```json
{
  "provider": "square",
  "shop_domain": "MERCHANT_ID",
  "status": "connected",
  "scopes": ["CUSTOMERS_READ", "ORDERS_READ", "PAYMENTS_READ", "ITEMS_READ", "MERCHANT_PROFILE_READ"],
  "settings": {
    "merchant_id": "MERCHANT_ID",
    "credential_ref": "vault://integrations/square/primary",
    "location_ids": "LOCATION_ID_1,LOCATION_ID_2",
    "webhook_notification_url": "https://api.postwave.example/api/public/commerce/square/webhooks",
    "webhook_signature_ref": "vault://integrations/square/webhook-signature"
  }
}
```

## Sync Behavior

- Customers: `POST /v2/customers/search`
- Catalog products: `POST /v2/catalog/search` with `object_types: ["ITEM"]`, `include_related_objects: true`, and `include_deleted_objects: true`
- Locations: `GET /v2/locations` when no `location_id` or `location_ids` selector is configured
- Orders: `POST /v2/orders/search`
- Payments: `GET /v2/payments`
- Refunds: `GET /v2/refunds`

Square Catalog ITEM snapshots map to Moosewave products, nested ITEM_VARIATION objects map to product variants, related IMAGE objects populate product images, and deleted ITEM objects tombstone local products with provider deletion evidence. Square payment snapshots are represented as canonical order snapshots until Moosewave has a shared canonical payment ledger, and Square refunds are recorded as idempotent provider-event evidence.

Signed `catalog.version.updated` webhooks trigger one bounded Catalog ITEM refresh page through the existing Square backfiller. Product rows and deleted ITEM tombstones are synced when the page has payload; empty pages store the returned `square:` catalog cursor for scheduled continuation without creating duplicate sync rows.

Manual empty `/sync` or `/backfill` calls also honor stored `square_retry:` cursors. If a retry cursor is not due, Moosewave returns the cursor without calling Square; if the retry is due, Moosewave resumes the underlying `square:` cursor and preserves the previous attempt history when provider-pull or local sync failure stores the next retry cursor.

The scheduled worker scans a wider candidate window and skips not-due `square_retry:` cursors before consuming the configured processing limit. If a scheduled target resolves to a row that has since been marked `disconnected`, the worker skips the Square API call, canonical sync, and cursor write.

## Disconnect Cleanup

Disconnect marks the local Square commerce integration `disconnected`, stops
manual and scheduled provider pulls, prevents signed Square webhooks from
resolving the row, preserves sync/webhook/provider-event history, and returns
plus persists `settings.provider_cleanup` readiness evidence.
Disconnected rows reject pause, cart-recovery link creation, back-in-stock
subscription creation, price-drop watcher creation, provider-event writes, and
lifecycle evaluation with `409 integration_disconnected`; preserved
audit/reporting reads remain available.

Moosewave does not currently delete Square Developer Console webhook
subscriptions, revoke Square OAuth seller tokens, rotate app tokens, or rotate
webhook signature keys during disconnect. The returned cleanup evidence lists
the Square merchant ID, configured webhook notification URL, credential/signature
reference presence, local stop effects, and operator-managed Square Developer
Console actions.

## Validation Checklist

- Create a Square sandbox seller install and confirm the credential reference can read Customers, Catalog, Orders, Payments, Refunds, and Locations.
- Run an empty backfill request and confirm customers, catalog products, orders, payments, and refunds import in sequence.
- Confirm Catalog Search returns ITEM objects with nested variations, related IMAGE objects, and deleted ITEM tombstones when `include_deleted_objects` is enabled.
- Confirm configured `location_ids` are used for Orders Search and omitted location selectors trigger active-location discovery.
- Force a Square `429` or `5xx` response with `Retry-After` from scheduled and manual backfill paths and confirm Moosewave stores a `square_retry:` cursor with attempts, next attempt time, last status, and last error, including incremented attempts after a due retry fails again.
- Send signed customer, payment, and refund webhooks and confirm Moosewave verifies `x-square-hmacsha256-signature` using the exact notification URL plus raw body.
- Send a signed `catalog.version.updated` webhook and confirm Moosewave starts a bounded Catalog ITEM refresh from the `catalog_products` cursor, stores the returned cursor, and lets the scheduled worker continue if more product pages remain.
- Replay the same webhook and confirm Moosewave returns `200` without ingesting duplicate data.
- Delete a customer and confirm Moosewave records delete evidence by Square source ID.
- Open `/api/v1/integrations/square/health` and confirm the unified facade reports Square-specific Customers/Catalog/Orders/Payments/Refunds runtime, not a generic commerce foundation.
- Disconnect the integration and confirm Moosewave marks the local row disconnected, returns/persists `provider_cleanup` readiness evidence, and stops local sync/webhook resolution while Square OAuth token revocation, app-token cleanup, webhook subscription cleanup, duplicate notification URL audit, and signature-key rotation are handled in the Square Developer Console.

## Source Notes

Square's current Catalog Search Objects endpoint is `POST /v2/catalog/search`, requires `ITEMS_READ`, supports a pagination `cursor`, accepts `object_types`, can include related objects, and can include deleted objects. Square's current List Catalog endpoint documents API version `2026-05-20`, `ITEMS_READ`, `types`, and `cursor` pagination, with page size currently set to 100. Square's Catalog API overview describes catalog items as the seller item library and item variations as related product variants. Square's catalog sync guidance recommends `catalog.version.updated` or periodic `SearchCatalogObjects` calls for catalog-change synchronization; Moosewave now uses the signed event as a bounded product-refresh trigger. Square's webhook validation docs require HMAC-SHA256 over the signature key, exact notification URL, and raw body, compared against `x-square-hmacsha256-signature` with constant-time comparison.
