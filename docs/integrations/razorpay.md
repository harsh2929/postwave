# Razorpay Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave's Razorpay connector is a managed commerce/payments integration for Razorpay customers, orders, payments, refunds, and signed webhooks. The local runtime is complete for the implemented Razorpay slice: credential-reference Basic Auth, count/skip REST pagination, optional UNIX timestamp backfill bounds, scheduled bounded backfills with retry cursors, raw-body `X-Razorpay-Signature` verification, `x-razorpay-event-id` idempotency, payment-backed order snapshots, refund provider-event evidence, persisted operator-managed `provider_cleanup` readiness evidence on disconnect, and unified Integrations facade health/contract metadata.

## Runtime Endpoints

- Public webhook callback: `/api/public/commerce/razorpay/webhooks`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## Razorpay Dashboard Setup

1. Create or open the Razorpay account in the Razorpay Dashboard.
2. Generate a key ID and key secret for the correct Test or Live mode.
3. Store the key ID/key secret pair in the Moosewave secret vault.
4. Configure a Razorpay payment webhook for:
   - `payment.authorized`
   - `payment.captured`
   - `payment.failed`
   - `order.paid`
   - `refund.created`
   - `refund.processed`
   - `refund.failed`
   - `refund.speed_changed`
5. Configure the webhook URL as:
   - `https://<postwave-public-host>/api/public/commerce/razorpay/webhooks`
6. Set a webhook secret in Razorpay and store that secret in a Moosewave secret reference.
7. Store credentials and signing secrets in secret references, not in integration settings.

Example credential secret:

```json
{
  "key_id": "RAZORPAY_KEY_ID",
  "key_secret": "RAZORPAY_KEY_SECRET"
}
```

Moosewave also accepts key-value secret payloads and a raw `key_id:key_secret` secret payload for migration compatibility.

Example integration payload:

```json
{
  "provider": "razorpay",
  "shop_domain": "ACCOUNT_ID",
  "status": "connected",
  "scopes": ["customers:read", "orders:read", "payments:read", "webhooks:read"],
  "settings": {
    "account_id": "ACCOUNT_ID",
    "credential_ref": "vault://integrations/razorpay/primary",
    "webhook_secret_ref": "vault://integrations/razorpay/webhook-secret",
    "settlement_currency": "INR",
    "backfill_from": "1767225600",
    "backfill_to": "1798761599"
  }
}
```

## Sync Behavior

- Customers: `GET /v1/customers`
- Orders: `GET /v1/orders`
- Payments: `GET /v1/payments`
- Refunds: `GET /v1/refunds`

Moosewave sends Razorpay Basic Auth with the stored key ID and key secret. REST backfills use `count=100`, `skip` cursor pagination, bounded response bodies, and optional `from` / `to` UNIX timestamp filters when configured. Customers map to canonical commerce customers. Orders and payments map to canonical order snapshots until Moosewave has a shared payment ledger. Refunds are recorded as idempotent provider-event evidence.

If a scheduled target resolves to a row that has since been marked `disconnected`, the worker skips Razorpay API calls, canonical sync, and cursor writes.

## Webhook Behavior

Razorpay sends a raw JSON request body with `X-Razorpay-Signature`; Moosewave verifies HMAC-SHA256 using the stored webhook secret and the exact raw request body. Moosewave claims idempotency with `x-razorpay-event-id` when present and falls back to a deterministic local event key for deliveries that omit it.

Payment and order webhooks upsert canonical order snapshots. Refund webhooks write refund provider-event evidence. Webhook secret rotation needs special handling because Razorpay retries older deliveries with the old secret.

## Validation Checklist

- Create a Razorpay test account install and confirm the credential reference can read Customers, Orders, Payments, and Refunds.
- Run an empty backfill request and confirm customers, orders, payments, and refunds import in sequence.
- Confirm `count=100` plus `skip` advances across accounts with more than 100 rows.
- Confirm optional `backfill_from` and `backfill_to` UNIX timestamps are accepted for each enabled object type.
- Force a Razorpay `429` or `5xx` response with `Retry-After` and confirm Moosewave stores a `razorpay_retry:` cursor with attempts, next attempt time, last status, and last error.
- Send signed payment, order, and refund webhooks and confirm Moosewave verifies `X-Razorpay-Signature` using the raw body.
- Replay the same webhook with the same `x-razorpay-event-id` and confirm Moosewave returns `200` without ingesting duplicate data.
- Rotate the webhook secret and confirm older retried requests are validated with the old secret during the rotation window.
- Open `/api/v1/integrations/razorpay/health` and confirm the unified facade reports Razorpay-specific Customers/Orders/Payments/Refunds runtime, not a generic commerce foundation.
- Disconnect the integration and confirm Moosewave stops local sync, returns/persists `provider_cleanup` readiness evidence, and leaves Razorpay key revocation, webhook endpoint cleanup, duplicate endpoint audit, and signing-secret rotation to the Razorpay Dashboard.

## Source Notes

Razorpay's current API authentication docs require Basic Auth with key ID and key secret. Customer, order, payment, and refund list endpoints use `count` and `skip` pagination, with a maximum page size of 100 for the object families Moosewave pulls. Orders, payments, and refunds document `from` and `to` UNIX timestamp filters, and the customer list schema accepts only supported list query parameters. Razorpay webhook validation requires `X-Razorpay-Signature` HMAC-SHA256 over the raw webhook body and the configured webhook secret. Razorpay webhook docs also call out duplicate deliveries via `x-razorpay-event-id`, non-guaranteed event ordering, retry behavior, and the need to validate older retried requests with the old secret after secret rotation.
