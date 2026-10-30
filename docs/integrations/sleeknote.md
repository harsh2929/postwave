# Sleeknote Native Lead Integration

Sleeknote is `Native / partial` in the catalog, with the implemented local runtime classified as `native_runtime_complete_live_certification_pending`.

This slice covers Sleeknote Custom Integration delivery for new signup data. It does not claim a Sleeknote REST submissions poller or automated historical export.

Official reference: [Sleeknote Custom Integration](https://help.sleeknote.com/hc/en-us/articles/6974592329245-Custom-Integration).

## Implemented Runtime

- Public receiver: `GET|POST /api/public/lead-integrations/sleeknote/webhooks`
- Route scope: `account_id` plus `campaign_id`
- Auth: route token resolved from `credentials_ref`
- Payloads: query-string GET, `application/x-www-form-urlencoded` POST, and JSON signup payloads
- Idempotency: `lead_webhook_events` claim/processed lifecycle
- Imports: canonical lead profile, list membership, and `lead.submitted` event
- Disconnect: row-preserving local disconnect with operator-managed Sleeknote cleanup evidence

## Connection Payload

```json
{
  "provider": "sleeknote",
  "name": "Sleeknote Newsletter Campaign",
  "credentials_ref": "lead:sleeknote:newsletter",
  "settings": {
    "account_id": "acct_123",
    "campaign_id": "campaign_456",
    "site_id": "site_789",
    "campaign_name": "Newsletter",
    "default_tags": "sleeknote,newsletter",
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

## Sleeknote Setup

Create or edit a Sleeknote campaign Custom Integration that sends new signup data to Moosewave.

Point the Custom Integration URL at:

```text
https://{postwave-public-host}/api/public/lead-integrations/sleeknote/webhooks?account_id=acct_123&campaign_id=campaign_456&token=generated-route-token
```

The token may also be supplied as `Authorization: Bearer ...`, `X-Sleeknote-Webhook-Token`, `X-Postwave-Webhook-Token`, `webhook_token`, `route_token`, or `sleeknote_token`.

## Payload Mapping

Moosewave accepts Sleeknote's documented GET query-string delivery and form-encoded POST delivery. JSON payloads are also accepted for controlled bridge/testing setups.

Sleeknote-provided metadata:

- `guid`: delivery/submission identifier
- `SleeknoteId`: campaign identifier
- `CustomerId`: account/customer identifier
- `SignupPage`: page URL where the signup occurred
- `UserAgent`: submitting browser user agent

Core identity fields:

- `email`
- `first_name`, `firstName`
- `last_name`, `lastName`
- `name`, `full_name`
- `phone`, `phone_number`
- `company`

Optional identity mapping settings can point Moosewave at custom field names if the campaign maps form inputs differently.

## Disconnect Checklist

Disconnecting the Moosewave row:

- marks the local row `disconnected`
- makes future Sleeknote Custom Integration deliveries fail closed before writes
- preserves webhook idempotency and sync-run audit history
- returns and persists `settings.provider_cleanup`

Operator actions still required before full availability:

- remove or disable the Sleeknote Custom Integration URL pointing at Moosewave
- rotate the route token if no longer used
- audit duplicate/manual Custom Integration destinations
- prove reconnect behavior
- prove data-delete/export handling
- record live Sleeknote account delivery-shape evidence

## Live Certification Gates

Promotion from `native_runtime_complete_live_certification_pending` to `RuntimeAvailable` requires live Sleeknote evidence for:

- account/dashboard setup
- Custom Integration GET delivery shape
- Custom Integration form-encoded POST delivery shape
- route-token success and failure behavior
- duplicate delivery behavior
- Custom Integration removal
- credential rotation
- reconnect
- data-delete/export behavior
- duplicate/manual integration audit
