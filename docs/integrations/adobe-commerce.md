# Adobe Commerce Native Integration

Moosewave's Adobe Commerce connector is a managed commerce integration for Adobe Commerce on Cloud/PaaS, on-premises Magento Open Source/Adobe Commerce, and Adobe Commerce as a Cloud Service token-mode installs. It supports credential-reference bearer tokens, PaaS/on-prem `/rest/<store-view-code>/V1/...` routing, SaaS API-base routing with the `Store` header, cursor-paginated REST backfills, merchant-configured webhook ingest, credit-memo refund evidence, scheduled bounded backfills with retry cursors, and unified Integrations facade health/contract metadata.

Catalog status remains `Native / partial`, but the unified connector contract now reports `native_runtime_complete_live_certification_pending` because the local auth, REST pull, webhook ingest, retry, lifecycle, and operator-managed cleanup posture is complete for the implemented Adobe Commerce slice. `RuntimeAvailable` promotion still requires live PaaS/on-prem and SaaS merchant certification plus provider-side cleanup evidence.

## Runtime Endpoints

- Public webhook callback: `/api/public/commerce/adobe-commerce/webhooks`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## Adobe Commerce Setup

1. Create an Adobe Commerce integration/admin token or provision an Adobe Commerce as a Cloud Service IMS access token.
2. Grant read access for Customers, Catalog Products, Sales Orders, Credit Memos, and Web API resources.
3. Store the bearer token in the Moosewave secret vault.
4. For PaaS/on-prem/Magento Open Source, set `base_url` to the store host and optionally set `store_view_code`.
5. For Adobe Commerce as a Cloud Service, set `deployment_mode` to `saas`, set `api_base_url` to the SaaS REST endpoint, and set `store_view_code` when Moosewave should send a specific `Store` header.
6. Configure merchant-managed Adobe Commerce Webhooks, Adobe I/O Events, or a Magento module to send customer/product/order/credit-memo events to:
   - `https://<postwave-public-host>/api/public/commerce/adobe-commerce/webhooks`
7. Include the store base URL in one of the configured headers/query fields/payload fields accepted by Moosewave, such as `X-Adobe-Commerce-Base-Url`, `X-Magento-Base-Url`, `base_url`, or equivalent payload evidence.
8. Store the webhook shared secret in a Moosewave secret reference and configure the webhook to send it through a Moosewave/Adobe/Magento shared-secret header or Bearer token.

Example credential secret:

```json
{
  "access_token": "ADOBE_COMMERCE_BEARER_TOKEN",
  "deployment_mode": "paas",
  "api_base_url": "https://store.example.com"
}
```

Example integration payload:

```json
{
  "provider": "adobe-commerce",
  "shop_domain": "https://store.example.com",
  "status": "connected",
  "scopes": [
    "Magento_Customer::customer",
    "Magento_Catalog::products",
    "Magento_Sales::sales",
    "Magento_Webapi::webapi"
  ],
  "settings": {
    "base_url": "https://store.example.com",
    "credential_ref": "vault://integrations/adobe-commerce/primary",
    "store_view_code": "default",
    "website_id": "1",
    "event_auth_ref": "vault://integrations/adobe-commerce/webhook-secret",
    "deployment_mode": "paas"
  }
}
```

SaaS-mode example settings:

```json
{
  "base_url": "https://store.example.com",
  "credential_ref": "vault://integrations/adobe-commerce/ims-token",
  "deployment_mode": "saas",
  "api_base_url": "https://<server>.api.commerce.adobe.com/<tenant-id>",
  "store_view_code": "default"
}
```

## Sync Behavior

- Customers: `GET /V1/customers/search`
- Products: `GET /V1/products`
- Orders: `GET /V1/orders`
- Credit memos/refunds: `GET /V1/creditmemos`

Moosewave sends `Authorization: Bearer <access_token>` to every REST request. PaaS/on-prem paths are built as `/rest/{store_view_code}/V1/...` or `/rest/V1/...`. SaaS-mode paths use the configured `api_base_url` without `/rest`, and Moosewave sends `Store: <store_view_code>` when a store view is configured.

Backfills use `searchCriteria[currentPage]`, `searchCriteria[pageSize]`, and ascending entity sorting. Customer snapshots map to canonical commerce customers. Product snapshots map to canonical products. Order snapshots map to canonical orders. Credit memo snapshots map to idempotent `refund_created` provider-event evidence until Moosewave has a shared canonical payment/refund ledger.

If a scheduled target resolves to a row that has since been marked `disconnected`, the worker skips Adobe Commerce API calls, canonical sync, and cursor writes.

## Webhook Behavior

Adobe Commerce Webhooks can be configured through Admin, REST subscription endpoints, `webhooks.xml`, or a Magento module depending on the deployment. Moosewave currently supports merchant-configured webhook deliveries that include enough entity payload data to upsert customers, products, and orders or to record credit-memo refund evidence.

Moosewave accepts a configured shared-secret or Bearer credential through Moosewave/Adobe/Magento headers, verifies it against `event_auth_ref` or the credential secret, claims webhook idempotency, and records processed/failed state through the shared webhook ledger.

Managed subscription creation/deletion remains a certification gap. Until a packaged Magento module or SaaS Admin flow is live-validated, operators must create and delete provider-side webhook definitions in Adobe Commerce Admin or module configuration.

## Validation Checklist

- Create a Magento Open Source or Adobe Commerce test install and confirm the credential reference can read Customers, Products, Orders, and Credit Memos.
- For SaaS, confirm IMS token generation and `commerce.accs` scope outside Moosewave, then store the access token by reference.
- Run an empty backfill request and confirm customers, products, orders, and credit memo refund events import in sequence.
- Confirm `searchCriteria[currentPage]`, `searchCriteria[pageSize]`, and ascending sort orders paginate correctly for large stores.
- Confirm PaaS/on-prem `/rest/{store_view_code}/V1/...` routing and SaaS `Store` header routing both work with configured tenants.
- Force an Adobe Commerce `429` or `5xx` response with `Retry-After` and confirm Moosewave stores an `adobe_commerce_retry:` cursor with attempts, next attempt time, last status, and last error.
- Send merchant-configured customer, product, order, and credit memo webhooks with the shared-secret/Bearer header and confirm Moosewave verifies and ingests them.
- Replay the same webhook and confirm Moosewave returns `200` without ingesting duplicate data.
- Open `/api/v1/integrations/adobe-commerce/health` and confirm the unified facade reports Adobe-specific REST and webhook runtime, not a generic commerce foundation.
- Disconnect the integration and confirm Moosewave stops local sync, returns/persists `provider_cleanup` readiness evidence, and leaves access-token revocation, shared-secret rotation, and Adobe/Magento webhook definition cleanup to Admin/module configuration.

## Source Notes

Adobe's current REST overview states Adobe Commerce on Cloud/PaaS, on-premises Adobe Commerce, and Magento Open Source share the same REST API framework with endpoint URLs shaped as `https://<host>/rest/<store-view-code>/<endpoint>`. Adobe Commerce as a Cloud Service differs: REST endpoints omit `/rest`, the store scope is sent through the `Store` header, and requests require IMS access tokens. Adobe's search docs define `searchCriteria[sortOrders]`, `searchCriteria[pageSize]`, and `searchCriteria[currentPage]`, including examples against `/V1/orders` and SaaS endpoints. Adobe's SaaS authentication docs require bearer access tokens and list required IMS scopes including `commerce.accs`; the server-to-server guide describes client-credential token generation. Adobe's webhook API docs expose subscribed webhook list/subscribe/unsubscribe endpoints, note that `Magento_AdobeCommerceWebhooksSubscriber` must be enabled for subscription APIs, and expose `GET /V1/webhooks/supportedList` for SaaS-supported webhook methods. Adobe's hook-content docs describe discovering PaaS methods with `bin/magento webhooks:list:all` / `bin/magento webhooks:info` and SaaS methods through Admin or `GET /V1/webhooks/supportedList`.
