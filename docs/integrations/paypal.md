# PayPal Native Integration

Moosewave's PayPal connector is a managed commerce/payments integration for PayPal Transaction Search reporting, checkout/order/capture/sale webhooks, refunds, subscription/invoice provider-event evidence, and catalog-product change evidence. It supports credential-reference OAuth client credentials, sandbox/live environment selection, RFC3339 reporting windows, scheduled bounded backfills with retry cursors, PayPal Verify Webhook Signature API validation, allowlisted sparse webhook resource hydration, durable webhook idempotency, customer/order/refund mapping, and unified Integrations facade health/contract metadata.

## Runtime Endpoints

- Public webhook callback: `/api/public/commerce/paypal/webhooks`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## PayPal App Setup

1. Create or open the PayPal REST app in the PayPal Developer Dashboard.
2. Copy the REST app client ID and client secret for the correct sandbox or live environment.
3. Store the client ID/client secret pair in the Moosewave secret vault.
4. Confirm the app/account can access Transaction Search reporting for the merchant. Third-party merchant reporting requires PayPal partner-network permissions.
5. Configure a PayPal webhook for:
   - `CHECKOUT.ORDER.APPROVED`
   - `CHECKOUT.ORDER.COMPLETED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.PENDING`
   - `PAYMENT.CAPTURE.DECLINED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.CAPTURE.REVERSED`
   - `PAYMENT.REFUND.PENDING`
   - `PAYMENT.REFUND.FAILED`
   - `PAYMENT.SALE.COMPLETED`
   - `PAYMENT.SALE.PENDING`
   - `PAYMENT.SALE.DENIED`
   - `PAYMENT.SALE.REFUNDED`
   - `PAYMENT.SALE.REVERSED`
   - `BILLING.SUBSCRIPTION.CREATED`
   - `BILLING.SUBSCRIPTION.ACTIVATED`
   - `BILLING.SUBSCRIPTION.UPDATED`
   - `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
   - `BILLING.SUBSCRIPTION.CANCELLED`
   - `BILLING.SUBSCRIPTION.SUSPENDED`
   - `BILLING.SUBSCRIPTION.EXPIRED`
   - `INVOICING.INVOICE.CREATED`
   - `INVOICING.INVOICE.SCHEDULED`
   - `INVOICING.INVOICE.UPDATED`
   - `INVOICING.INVOICE.PAID`
   - `INVOICING.INVOICE.REFUNDED`
   - `INVOICING.INVOICE.CANCELLED`
   - `CATALOG.PRODUCT.CREATED`
   - `CATALOG.PRODUCT.UPDATED`
   - `CATALOG.PRODUCT.DELETED`
6. Configure the webhook URL as:
   - `https://<postwave-public-host>/api/public/commerce/paypal/webhooks`
7. Copy the PayPal webhook ID into the integration settings. Moosewave uses it when calling PayPal's Verify Webhook Signature API.
8. Store credentials in secret references, not in integration settings.

Example credential secret:

```json
{
  "client_id": "PAYPAL_CLIENT_ID",
  "client_secret": "PAYPAL_CLIENT_SECRET",
  "environment": "sandbox",
  "webhook_id": "PAYPAL_WEBHOOK_ID"
}
```

Moosewave also accepts key-value secret payloads and a raw `client_id:client_secret` secret payload for migration compatibility. The `webhook_id` can live in the credential secret or integration settings.

Example integration payload:

```json
{
  "provider": "paypal",
  "shop_domain": "MERCHANT_ID",
  "status": "connected",
  "scopes": [
    "https://uri.paypal.com/services/payments/payment/authcapture",
    "https://uri.paypal.com/services/reporting/search/read",
    "https://uri.paypal.com/services/subscriptions",
    "https://uri.paypal.com/services/applications/webhooks"
  ],
  "settings": {
    "merchant_id": "MERCHANT_ID",
    "credential_ref": "vault://integrations/paypal/primary",
    "environment": "sandbox",
    "webhook_id": "PAYPAL_WEBHOOK_ID",
    "backfill_start": "2026-06-01T00:00:00Z",
    "backfill_end": "2026-06-18T00:00:00Z",
    "reporting_window_days": "31"
  }
}
```

## Sync Behavior

- OAuth token exchange: `POST /v1/oauth2/token` with Basic Auth and `grant_type=client_credentials`
- Transaction Search: `GET /v1/reporting/transactions`
- Verify webhook signature: `POST /v1/notifications/verify-webhook-signature`
- Sparse webhook resource hydration: `GET /v2/checkout/orders/{id}`, `GET /v2/payments/captures/{id}`, `GET /v2/payments/refunds/{id}`, `GET /v1/billing/subscriptions/{id}`, and `GET /v2/invoicing/invoices/{id}`

Moosewave exchanges the stored client ID/client secret for an access token, then sends `Authorization: Bearer <access_token>` to PayPal REST APIs. Transaction Search pulls use `fields=all`, `page_size`, `page`, `start_date`, `end_date`, and `PayPal-Enforce-ISO8601-Format: true`. Backfill cursors split history into PayPal's 31-day maximum reporting windows and advance page-by-page.

Transaction Search payer rows map to canonical commerce customers. Positive transaction rows map to canonical order snapshots. Refund and reversal rows are recorded as idempotent provider-event evidence. Subscription, invoice, and catalog-product webhooks remain provider-event evidence until Moosewave has shared canonical subscription/invoice/product-ledger tables for those payment-provider event families.

Manual and scheduled continuation share `paypal_retry:` cursors. Empty manual `/sync` and `/backfill` requests skip PayPal calls while a retry cursor is not due, resume the embedded PayPal reporting cursor when due, and preserve the previous attempt history when provider-pull or local sync failure stores the next retry cursor.

The scheduled worker scans a wider candidate window and skips not-due `paypal_retry:` cursors before consuming the configured processing limit. If a scheduled target resolves to a row that has since been marked `disconnected`, the worker skips the PayPal API call, canonical sync, and cursor write.

## Disconnect Cleanup

Disconnect marks the local commerce integration `disconnected`, stops manual and scheduled PayPal Transaction Search pulls, prevents PayPal webhook callbacks from resolving the row, and preserves sync/webhook/provider-event audit history. The API response and persisted integration settings include `provider_cleanup` readiness evidence with the PayPal merchant ID, stored webhook ID when present, credential-reference presence, local stop effects, and PayPal Developer Dashboard actions.

Disconnected rows reject pause, cart-recovery link creation, back-in-stock subscription creation, price-drop watcher creation, provider-event writes, and lifecycle evaluation with `409 integration_disconnected`; preserved audit/reporting reads remain available.

Moosewave does not delete PayPal Developer Dashboard webhooks or revoke REST app credentials during API disconnect. Operators still need to delete or disable the PayPal webhook, rotate or revoke the REST app client secret if it is no longer used, audit duplicate Moosewave webhook URLs, and remove the REST app only after confirming no other workflows use it.

## Webhook Behavior

PayPal sends webhook payloads with transmission headers such as `PAYPAL-AUTH-ALGO`, `PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-SIG`, and `PAYPAL-TRANSMISSION-TIME`. Moosewave sends those headers, the configured webhook ID, and the full raw webhook event object to PayPal's Verify Webhook Signature API. A `verification_status` of `SUCCESS` is required before dispatch; PayPal Verify API 429/5xx failures return a retryable response instead of being reported as invalid signatures.

After signature verification and idempotency claim, sparse allowlisted webhook resources are hydrated by constructing PayPal REST paths from the event type and resource ID. The webhook must still contain merchant evidence or use an explicit merchant routing query so Moosewave can resolve the integration before verification and hydration. Moosewave does not follow webhook `links.href` values. Checkout order webhooks can fetch Orders v2, capture webhooks can fetch Payments v2 captures and merge related Orders v2 payer/item evidence when PayPal exposes a related order ID, refund webhooks can fetch Payments v2 refunds when the resource is refund-shaped, subscription webhooks can fetch Subscriptions v1, and invoice webhooks can fetch Invoicing v2. Hydrated merchant evidence must match the resolved integration merchant when PayPal returns a merchant/payee/invoicer ID; mismatches fail the webhook for retry instead of writing cross-merchant evidence.

Checkout/order, payment capture, and sale completed/pending/denied webhooks upsert canonical order snapshots where the PayPal resource contains enough order/capture/sale evidence. Payment refund and reversal webhooks write refund provider-event evidence. Subscription, invoice, and catalog-product webhooks write durable provider-event evidence, with catalog product created/updated/deleted topics classified separately. Legacy `PAYMENT.SALE.*` and `CATALOG.PRODUCT.*` webhooks are not REST-hydrated because sale fetches require deprecated Payments v1 APIs and catalog product fetches need separate product-catalog certification. Invoice and subscription provider-event IDs prefer the PayPal webhook event ID when available so repeated resource updates do not collapse into one evidence row.

## Validation Checklist

- Create a PayPal sandbox REST app and confirm the credential reference can exchange a client-credential access token.
- Confirm the merchant/app has Transaction Search permissions, especially for third-party merchant reporting.
- Run an empty backfill request and confirm Transaction Search imports customers, orders, and refund provider events in sequence.
- Confirm `backfill_start`, `backfill_end`, and `reporting_window_days` produce 31-day-or-smaller reporting windows.
- Confirm PayPal's three-hour Transaction Search availability delay is reflected in operator expectations during live testing.
- Force a PayPal `429` or `5xx` response with `Retry-After` and confirm Moosewave stores a `paypal_retry:` cursor with attempts, next attempt time, last status, and last error; confirm manual/scheduled retry-cursor not-due, resume, provider-failure, sync-failure, and due-attempt preservation behavior.
- Send signed checkout/order, capture, sale, refund, subscription, subscription-payment-failed, and invoice webhooks and confirm Moosewave verifies them through PayPal's Verify Webhook Signature API.
- Send sparse signed checkout/capture/refund/subscription/invoice webhooks with merchant evidence or explicit merchant routing plus a trusted resource ID and confirm Moosewave hydrates the allowlisted PayPal REST resource before dispatch, preserves the canonical source ID, rejects ID-only payloads that cannot resolve a merchant, and fails on a mismatched hydrated merchant ID.
- Replay the same webhook transmission/event and confirm Moosewave returns `200` without ingesting duplicate data.
- Open `/api/v1/integrations/paypal/health` and confirm the unified facade reports PayPal-specific Transaction Search and webhook verification runtime, not a generic commerce foundation.
- Disconnect the integration and confirm Moosewave returns/persists `provider_cleanup` evidence while PayPal REST app credentials, webhook ID cleanup, and dashboard webhook subscription deletion are handled in the PayPal Developer Dashboard.

## Source Notes

PayPal's current REST authentication docs require exchanging the client ID/client secret for an OAuth access token at `/v1/oauth2/token`, then sending the token as `Authorization: Bearer ACCESS-TOKEN` until it expires. PayPal's Transaction Search API uses `GET /v1/reporting/transactions`, notes up to a three-hour delay for executed transactions to appear, lists the previous three years of transactions, and supports `fields`, `page_size`, `page`, `start_date`, `end_date`, and the `PayPal-Enforce-ISO8601-Format` header. PayPal documents Transaction Search as partner-network gated when used on behalf of third parties. PayPal's Webhooks API verifies signatures with `POST /v1/notifications/verify-webhook-signature`, transmission headers, `webhook_id`, and `webhook_event`, returning `verification_status` as `SUCCESS` or `FAILURE`. PayPal's webhook event-name docs list supported Payments, Orders, Sales, Subscriptions, and Invoicing events used by this connector. PayPal's Orders v2, Payments v2 Captures/Refunds, Subscriptions v1, and Invoicing v2 APIs provide the allowlisted resource reads used to hydrate sparse signed webhook deliveries.
