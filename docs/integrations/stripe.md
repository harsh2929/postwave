# Stripe Native Integration

Moosewave's Stripe connector is a managed partial-native connector for payment-led commerce profiles, orders, charges, disputes, invoices, credit notes, subscriptions, refunds, and lifecycle events. It supports restricted-key credential references, webhook signing-secret references, cursor-paginated REST backfill, charge/payment-method evidence, dispute and credit-note evidence, full invoice line-item pagination, signed webhook ingest, customer delete evidence, provider-event evidence, retry cursors, scheduled continuation, and persisted operator-managed cleanup readiness evidence on disconnect.

The connector remains `Native / partial` until live Stripe account certification, signing-secret rotation validation, reconnect/disconnect validation, and provider-dashboard cleanup evidence are complete. The local runtime is complete for the current restricted-key REST, signed-webhook, retry, disconnect, and provider-event slice; Stripe Dashboard webhook endpoint deletion, restricted-key revocation, and signing-secret rotation remain operator-managed provider actions until live certification proves the full flow.

## Runtime Endpoints

- Public webhook callback: `/api/public/commerce/stripe/webhooks`
- Admin create/update: `/api/v1/commerce/integrations`
- Manual sync/backfill: `/api/v1/commerce/integrations/{id}/sync`
- Pause: `/api/v1/commerce/integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/commerce/integrations/{id}`

## Stripe Setup

1. Create a restricted key with read access to Customers, Checkout Sessions, PaymentIntents, Charges, Disputes, Invoices, Credit Notes, Subscriptions, Refunds, and Events.
2. Store the restricted key in the Moosewave secret vault and reference it with `credential_ref`.
3. Create a Stripe webhook endpoint that points to:
   - `https://<postwave-public-host>/api/public/commerce/stripe/webhooks`
4. Store the endpoint signing secret in the Moosewave secret vault and reference it with `webhook_secret_ref`.
5. Save the Stripe account ID, credential reference, and webhook secret reference on the commerce integration row.

Raw restricted keys, secret keys, endpoint secrets, and signing secrets are rejected in public integration settings. Store them only inside referenced secret payloads.

Example credential secret:

```json
{
  "restricted_key": "rk_live_..."
}
```

Example integration payload:

```json
{
  "provider": "stripe",
  "shop_domain": "acct_123",
  "status": "connected",
  "scopes": ["customers:read", "checkout_sessions:read", "payment_intents:read", "charges:read", "disputes:read", "invoices:read", "credit_notes:read", "subscriptions:read", "refunds:read", "events:read"],
  "settings": {
    "account_id": "acct_123",
    "credential_ref": "vault://integrations/stripe/restricted-key",
    "webhook_secret_ref": "vault://integrations/stripe/webhook-secret"
  }
}
```

## Sync Behavior

- Empty sync/backfill requests pull the next Stripe REST page using Moosewave's `stripe:` cursor state.
- Customers are pulled from `/v1/customers` and mapped into canonical commerce customers with normalized email, split names, phone/currency metadata, and raw provider evidence.
- Checkout Sessions are pulled from `/v1/checkout/sessions` and mapped into checkout customer evidence plus canonical orders.
- PaymentIntents are pulled from `/v1/payment_intents` and mapped into payment-backed canonical orders.
- Charges are pulled from `/v1/charges` and recorded as durable transaction provider-event evidence with payment method, billing, outcome, receipt, balance transaction, refund amount, dispute flag, payment intent, and customer identifiers.
- Disputes are pulled from `/v1/disputes` and recorded as durable dispute provider-event evidence with amount, status, reason, charge, payment intent, balance transactions, evidence details, and payment-method details.
- Invoices are pulled from `/v1/invoices`; if the embedded `lines` sublist is partial, Moosewave follows `/v1/invoices/{invoice_id}/lines` with `starting_after` pagination and merges the complete line list before order and provider-event mapping.
- Credit Notes are pulled from `/v1/credit_notes` and recorded as durable credit-note provider-event evidence with invoice/customer/refund linkage, amount/subtotal/total, status, reason, type, number, timestamps, and line evidence.
- Subscriptions are pulled from `/v1/subscriptions?status=all` and recorded as durable subscription provider-event evidence.
- Refunds are pulled from `/v1/refunds` and recorded as durable refund provider-event evidence.
- `429` and `5xx` responses produce durable retry cursors that persist the current object, `starting_after` cursor, attempt count, next attempt time, last status, and truncated error.
- Manual and scheduled continuation share `stripe_retry:` cursors. Empty manual `/sync` and `/backfill` requests skip Stripe calls while a retry cursor is not due, resume the embedded `stripe:` cursor when due, store `BACKFILL_FAILED` retry state on provider pull failures, and store `SYNC_FAILED` retry state when the provider page was fetched but local commerce sync fails.

## Webhook Behavior

- The public callback resolves the integration by event `account` or an explicit `account_id` query fallback.
- `Stripe-Signature` is verified against the raw request body using the signing secret from `webhook_secret_ref`.
- Customer create/update webhooks upsert canonical customers; customer delete webhooks delete customers by provider source ID and retain deletion evidence.
- PaymentIntent and Checkout Session webhooks upsert canonical orders.
- Charge webhooks record durable transaction provider-event evidence with payment-method and receipt metadata.
- Dispute webhooks record durable provider-event evidence for created, updated, closed, funds-withdrawn, and funds-reinstated states.
- Invoice lifecycle webhooks upsert invoice-backed orders and record provider-event evidence for created, finalized, paid, payment succeeded/failed, updated, voided, marked uncollectible, and deleted events.
- Credit Note webhooks record durable provider-event evidence for created, updated, and voided states.
- Refund and subscription lifecycle webhooks record provider-event evidence, including subscription pending-update and trial-ending events.
- Webhook IDs are claimed in the shared webhook ledger before dispatch so Stripe retries do not double-ingest.

## Disconnect Behavior

Disconnect marks the local Stripe commerce row `disconnected`, stops normal sync listing and scheduled/manual provider pulls, prevents signed Stripe webhook callbacks from resolving that row, and returns plus persists `settings.provider_cleanup` readiness evidence. Direct GET and child read endpoints can still expose the retained row and imported commerce evidence for audit/history, while normal list/runtime surfaces omit it. Moosewave does not delete Stripe Dashboard webhook endpoints or revoke restricted keys during API disconnect. Operators must revoke or rotate the restricted key, delete or disable the Stripe webhook endpoint, rotate the signing secret if the endpoint remains shared, and audit duplicate/manual Moosewave endpoints in Stripe Dashboard.

## Validation Checklist

- Confirm restricted-key scopes cover Customers, Checkout Sessions, PaymentIntents, Charges, Disputes, Invoices, Credit Notes, Subscriptions, Refunds, and Events.
- Run an empty backfill and confirm Customers, Checkout Sessions, PaymentIntents, Charges, Disputes, Invoices, Credit Notes, Subscriptions, and Refunds import in sequence.
- Create an invoice with more line items than Stripe embeds in the invoice object and confirm Moosewave calls `/v1/invoices/{invoice_id}/lines` until `has_more=false`.
- Confirm `Retry-After` on top-level list calls and invoice line-list calls writes a `stripe_retry:` cursor, and confirm manual retry-cursor not-due, resume, provider-failure, and sync-failure behavior.
- Deliver Customer, PaymentIntent, Checkout Session, Charge, Dispute, Invoice, Credit Note, Refund, and Subscription webhooks and confirm canonical writes/provider-event evidence.
- Replay the same webhook ID and confirm idempotent `200` handling without duplicate writes.
- Rotate the webhook signing secret, update the vault reference, and confirm the old signature fails and the new signature passes.
- Test Connect account routing by sending events with `account` and by using the `account_id` query fallback.
- Disconnect the integration and confirm local sync/webhook resolution stops, `settings.provider_cleanup` is recorded, and provider-dashboard restricted keys, webhook endpoints, and signing secrets are cleaned up manually.
- Open `/api/v1/integrations/stripe/health` and confirm the unified facade reports the Stripe-native runtime plus the remaining live-certification gap, not a generic provider-puller placeholder.

## Source Notes

Stripe list APIs use cursor pagination with `limit`, `starting_after`, `ending_before`, `data`, and `has_more`. Stripe charges expose payment-method, billing, outcome, receipt, balance-transaction, refund, dispute, payment-intent, and customer evidence used by the transaction provider events. Stripe disputes and credit notes have dedicated list APIs at `/v1/disputes` and `/v1/credit_notes`. Stripe invoice objects include only the first handful of line items, with a full paginated list available at `/v1/invoices/{invoice_id}/lines`. Stripe webhook signature verification requires the unmodified raw request body, `Stripe-Signature`, and the endpoint signing secret. Stripe's public event list is continually evolving, so Moosewave handles the supported event families explicitly and keeps unknown event types idempotent no-ops until mapped.
