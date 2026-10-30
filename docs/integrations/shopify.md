# Shopify Native Integration

Moosewave's Shopify connector is the deepest native commerce connector. It is a
managed partial-native connector for storefront customers, products, orders, and
lifecycle events, built on in-app OAuth, Admin GraphQL bulk import, registered
and signature-verified webhooks (including mandatory privacy webhooks), encrypted
install secrets, scheduled backfill, cart-recovery, discount-code capture, and
returned/persisted disconnect `provider_cleanup` evidence for Moosewave-managed
webhook cleanup.

The connector remains `Native / partial` until live Shopify store certification
(OAuth install, bulk import, webhook delivery, privacy webhooks, reconnect,
disconnect cleanup, and app-uninstall) is complete. See
[commerce-live-certification.md](commerce-live-certification.md).

## Runtime Endpoints

- OAuth start (authenticated): `/api/v1/commerce/shopify/oauth/start`
- OAuth callback (public): `/api/public/commerce/shopify/oauth/callback`
- Webhook callback (public): `/api/public/commerce/shopify/webhooks`
- Privacy webhook callback (public): `/api/public/commerce/shopify/privacy`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## Shopify App Setup

1. Create a Shopify app (custom or public) with Admin API scopes for
   `read_customers`, `read_products`, and `read_orders` (add `read_marketing_events`
   / discount scopes if cart-recovery and discount-code capture are enabled).
2. Set the app's allowed redirection URL to:
   - `https://<postwave-public-host>/api/public/commerce/shopify/oauth/callback`
3. Configure the app's API secret in the Moosewave secret vault; the install
   access token is minted via OAuth and stored **encrypted** (there is no
   `_credentials.go` static key path for Shopify).
4. Subscribe the mandatory GDPR/CCPA privacy webhooks
   (`customers/redact`, `customers/data_request`, `shop/redact`) to:
   - `https://<postwave-public-host>/api/public/commerce/shopify/privacy`

## How It Works

- **OAuth install**: `StartShopifyOAuth` builds a signed, expiring state; the
  public callback verifies the request HMAC (`VerifyShopifyOAuthHMAC`), exchanges
  the code at `/admin/oauth/access_token`, encrypts and stores the token, and
  reconciles webhooks via the Admin GraphQL `ShopifyAdminGraphQLWebhookRegistrar`.
- **Webhooks**: inbound deliveries are verified with base64 HMAC-SHA256 over the
  raw body (`VerifyShopifyWebhookHMAC`); privacy topics are handled by
  `ShopifyPrivacyWebhook`.
- **Backfill**: `ShopifyAdminGraphQLBulkOperator` launches an async bulk
  operation, polls for completion, and imports the resulting JSONL with resumable
  line offsets (`shopify_bulk_import.go`). The provider catalog and managed
  webhook registrar include `bulk_operations/finish`, so Shopify can continue a
  completed async operation through the public webhook path as well as scheduled
  polling. If a scheduled cursor-page or async bulk target resolves to a row
  that has since been marked `disconnected`, Moosewave skips Shopify calls,
  bulk polling/import, canonical sync, and cursor writes.
- **Disconnect**: `CleanupWebhooks` removes Moosewave-owned subscriptions before
  the integration row is marked `disconnected`, returns `provider_cleanup`, and
  persists the same evidence to integration settings. Disconnected rows no
  longer resolve public Shopify webhooks or public back-in-stock widget requests;
  app uninstall, token invalidation, and dashboard cleanup evidence remain part
  of live certification/operator cleanup.

## Live Certification

The opt-in Go live tests live in `apps/api/internal/commerce/shopify_live_test.go`
and are skipped unless `COMMERCE_LIVE_CERTIFICATION=1` is set. Read-path run:

```sh
cd apps/api
COMMERCE_LIVE_CERTIFICATION=1 \
COMMERCE_LIVE_CERTIFICATION_REPORT=../../artifacts/shopify-live-certification.jsonl \
SHOPIFY_ACCESS_TOKEN=shpat_... \
SHOPIFY_SHOP_DOMAIN=example.myshopify.com \
go test -count=1 -run 'TestShopifyLiveCertification(WebhookSignature|BackfillReadPath)' ./internal/commerce
```

Append the manual evidence rows (`manual_oauth_install`,
`manual_privacy_webhooks`, `manual_app_uninstall`, and the shared
`manual_*` set), then run the promotion gate:

```sh
COMMERCE_LIVE_CERTIFICATION_VALIDATE_REPORT=1 \
COMMERCE_LIVE_CERTIFICATION_REPORT=../../artifacts/shopify-live-certification.jsonl \
go test -count=1 -run 'TestShopifyLiveCertificationReportCompleteness' ./internal/commerce
```

Only after a green completeness run, promote Shopify per the
[promotion gate](commerce-live-certification.md#promotion-gate).

## Verification

```sh
cd apps/api
go test -count=1 ./internal/commerce ./internal/integrations/livecert .
```
