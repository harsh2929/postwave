# Wix Stores Native Integration

Moosewave's Wix Stores connector is a self-managed Wix app integration for commerce customers, products, orders, adjacent Wix commerce events, and app lifecycle events. It supports app-instance OAuth token minting, Contacts backfill, Catalog V1/V3 product backfill, eCommerce order search, signed JWT webhook ingest, install/remove lifecycle handling, ID-only webhook fetch fallback, delete event routing, provider-event evidence for Wix payments/refunds, pricing plans, bookings, and events/tickets, retry cursors, reconnect recovery, and durable webhook idempotency. The local native runtime is complete; `RuntimeAvailable` still requires live Wix dev-store certification evidence.

## Runtime Endpoints

- Public webhook callback: `/api/public/commerce/wix-stores/webhooks`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## Wix App Setup

1. Create or open the Moosewave Wix app in the Wix app dashboard.
2. Capture the app OAuth values: app ID, app secret, and the installed app `instanceId`.
3. In the Wix app dashboard Webhooks section, copy the public key and store it in the Moosewave secret vault.
4. Subscribe the app to the commerce and lifecycle events Moosewave handles:
   - `wix.app.v1.instance.installed`
   - `wix.app.v1.instance.removed`
   - `wix.contacts.v4.contact.created`
   - `wix.contacts.v4.contact.updated`
   - `wix.contacts.v4.contact.deleted`
   - Wix Stores Catalog V1 product created/changed/deleted events for Catalog V1 sites
   - Wix Stores Catalog V3 product created/updated/deleted events for Catalog V3 sites
   - `wix.ecom.v1.order.created`
   - `wix.ecom.v1.order.updated`
   - `wix.ecom.v1.order.canceled`
   - `wix.ecom.v1.order.committed`
   - Wix payment/refund events exposed to the app, such as payment created/updated and refund created/updated/failed
   - Wix Pricing Plans order/subscription events, such as order purchased, updated, canceled, or expired
   - Wix Bookings booking or reservation created/updated/canceled events
   - Wix Events ticket/order/registration/guest events
5. Configure every subscribed webhook callback URL as:
   - `https://<postwave-public-host>/api/public/commerce/wix-stores/webhooks`
6. Grant app permissions for Contacts read access, Stores catalog/product read access, eCommerce orders read access, Pricing Plans read access, Bookings read access, Events read access, Payments read access when applicable, and Manage Your App.
7. Store credentials in a secret reference, not in integration settings.

Example credential secret:

```json
{
  "client_id": "WIX_APP_ID",
  "client_secret": "WIX_APP_SECRET",
  "instance_id": "WIX_APP_INSTANCE_ID",
  "app_id": "WIX_APP_ID"
}
```

Example integration payload:

```json
{
  "provider": "wix-stores",
  "shop_domain": "WIX_SITE_ID",
  "status": "connected",
  "scopes": ["stores.read", "orders.read", "contacts.read", "manage-your-app"],
  "settings": {
    "site_id": "WIX_SITE_ID",
    "instance_id": "WIX_APP_INSTANCE_ID",
    "store_id": "WIX_STORES_APP_OR_STORE_ID",
    "credential_ref": "vault://integrations/wix-stores/primary",
    "webhook_public_key_ref": "vault://integrations/wix-stores/webhook-public-key",
    "catalog_version": "auto"
  }
}
```

## Validation Checklist

- Install the Wix app on a dev store and confirm Moosewave records the installed lifecycle evidence.
- Run an empty backfill request and confirm contacts, products, and orders import in sequence.
- Disconnect the row and confirm stale scheduled backfill targets skip Wix API calls, canonical sync, and cursor writes.
- Confirm the product path uses Catalog V3 or Catalog V1 based on `/stores/v3/provision/version`.
- Confirm Catalog V1 product backfill calls `/stores-reader/v1/products/query` with `query.paging.limit/offset`; Catalog V3 product backfill calls `/stores/v3/products/query` with cursor paging.
- Create or update a product and confirm an ID-only webhook fetches the full product before upsert.
- Delete a contact and product and confirm Moosewave records delete evidence without trying to fetch an already-deleted entity.
- Create or update an order and confirm totals, currency, line items, and buyer email map correctly.
- Cancel an order and confirm the signed webhook upserts the latest fetched order state.
- Send Wix payment/refund, pricing-plan, booking, and events/ticket webhooks and confirm Moosewave records idempotent provider-event evidence with provider raw payloads.
- Open `/api/v1/integrations/wix-stores/health` and confirm the unified facade reports `native_runtime_complete_live_certification_pending` through the contract, with Wix app uninstall, signed delete evidence, and provider-event evidence surfaced in privacy/data-delete metadata.
- Replay the same webhook and confirm Moosewave returns `200` without ingesting a duplicate event.
- Uninstall the app and confirm Moosewave moves the integration to `needs_auth`.
- Reinstall the app and confirm a signed app-installed webhook moves the integration back to `connected`.
- While the integration is `needs_auth`, send a non-lifecycle order/contact/product webhook and confirm Moosewave verifies and dedupes it but does not upsert data.
- Rotate the Wix webhook public key in the vault and repeat webhook delivery.

## Source Notes

Wix documents app REST authentication through app ID, app secret, and app instance ID at `POST https://www.wixapis.com/oauth2/token`; Moosewave accepts both direct token responses and Wix gateway-style `body` wrappers. Wix's Catalog Versioning endpoint is `GET /stores/v3/provision/version`; Catalog V3 product query is `POST /stores/v3/products/query`; Catalog V1 product query is `POST /stores-reader/v1/products/query` with standard `limit`/`offset` pagination; and eCommerce order search is `POST /ecom/v1/orders/search`. Wix documents Catalog V1 and V3 product webhooks, including created/updated or changed/deleted events, and eCommerce order cancellation/commit webhooks. Wix Pricing Plans includes plan orders/subscriptions, Wix Events includes ticketing orders/tickets/guests, and Wix Bookings can be bundled with Pricing Plans. Wix self-managed webhooks are delivered as signed JWT payloads and must be verified with the app dashboard public key. Wix documents duplicate, delayed, and resent webhook delivery behavior, so Moosewave claims each commerce webhook before dispatching it.
