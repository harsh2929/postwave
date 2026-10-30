# Poptin Native Lead Integration

Poptin is `Native / partial` in the catalog, with the implemented local runtime classified as `native_runtime_complete_live_certification_pending`.

This slice covers Poptin Webhooks integration delivery for popup/form leads. It does not claim a Poptin REST leads poller or automated historical export.

Official reference: [Poptin Webhooks integration](https://help.poptin.com/en/article/how-to-integrate-your-poptin-with-webhooks-1sl77wj/).

## Implemented Runtime

- Public receiver: `GET|POST /api/public/lead-integrations/poptin/webhooks`
- Route scope: `account_id` plus `popup_id`
- Auth: route token resolved from `credentials_ref`
- Payloads: query-string GET, `application/x-www-form-urlencoded` POST, and JSON popup lead payloads
- Idempotency: `lead_webhook_events` claim/processed lifecycle
- Imports: canonical lead profile, list membership, and `lead.submitted` event
- Disconnect: row-preserving local disconnect with operator-managed Poptin cleanup evidence

## Connection Payload

```json
{
  "provider": "poptin",
  "name": "Poptin Sale Popup",
  "credentials_ref": "lead:poptin:sale-popup",
  "settings": {
    "account_id": "acct_123",
    "popup_id": "popup_456",
    "site_id": "site_789",
    "popup_name": "Sale Popup",
    "default_tags": "poptin,popup",
    "list_id": "list_123"
  }
}
```

Store the route token in the credential vault:

```json
{
  "webhook_token": "generated-route-token"
}
```

The public API rejects raw route tokens, API keys, passwords, and secrets in integration settings.

## Poptin Setup

Create or edit a Poptin Webhooks integration and send new popup/form lead data to Moosewave.

Point the Webhooks URL at:

```text
https://{postwave-public-host}/api/public/lead-integrations/poptin/webhooks?account_id=acct_123&popup_id=popup_456&token=generated-route-token
```

The token may also be supplied as `Authorization: Bearer ...`, `X-Poptin-Webhook-Token`, `X-Postwave-Webhook-Token`, `webhook_token`, `route_token`, or `poptin_token`.

## Payload Mapping

Moosewave accepts Poptin webhook data as query-string GET, form-encoded POST, or JSON payloads. Live certification must capture the exact production delivery shape for the tenant's Poptin plan and integration configuration.

Core identity fields:

- `email`
- `first_name`, `firstName`
- `last_name`, `lastName`
- `name`, `full_name`
- `phone`, `phone_number`
- `company`

Optional identity mapping settings can point Moosewave at custom Poptin field names if the popup uses custom fields.

## Disconnect Checklist

Disconnecting the Moosewave row:

- marks the local row `disconnected`
- makes future Poptin Webhooks deliveries fail closed before writes
- preserves webhook idempotency and sync-run audit history
- returns and persists `settings.provider_cleanup`

Operator actions still required before full availability:

- remove or disable the Poptin Webhooks integration URL pointing at Moosewave
- rotate the route token if no longer used
- audit duplicate/manual Webhooks integrations
- prove reconnect behavior
- prove data-delete/export handling
- record live Poptin account delivery-shape evidence

## Live Certification Gates

Promotion from `native_runtime_complete_live_certification_pending` to `RuntimeAvailable` requires live Poptin evidence for:

- account/dashboard setup
- Webhooks integration delivery shape
- route-token success and failure behavior
- duplicate delivery behavior
- Webhooks integration removal
- credential rotation
- reconnect
- data-delete/export behavior
- duplicate/manual integration audit
