# Privy Native Lead Integration

Privy is `Native / partial` in the catalog, with the implemented local runtime classified as `native_runtime_complete_live_certification_pending`.

This slice covers Privy custom Webhook signup/contact ingest. It does not claim a Privy REST poller or automated historical export.

Official reference: [Privy account customizations](https://help.privy.com/docs/learn/account-settings-and-billing/business-settings/customizations).

## Implemented Runtime

- Public receiver: `POST /api/public/lead-integrations/privy/webhooks`
- Route scope: `account_id` plus `campaign_id`
- Auth: HTTP Basic auth resolved from `credentials_ref`
- Payloads: signup/contact JSON with optional `campaign` object and `custom_fields`
- Idempotency: `lead_webhook_events` claim/processed lifecycle
- Imports: canonical lead profile, list membership, and `lead.submitted` event
- Disconnect: row-preserving local disconnect with operator-managed Privy cleanup evidence

## Connection Payload

```json
{
  "provider": "privy",
  "name": "Privy Summer Popup",
  "credentials_ref": "lead:privy:summer-popup",
  "settings": {
    "account_id": "acct_123",
    "campaign_id": "display_456",
    "campaign_name": "Summer Popup",
    "default_tags": "privy,popup",
    "list_id": "list_123"
  }
}
```

Store the Basic auth material in the credential vault:

```json
{
  "username": "postwave",
  "password": "generated-basic-password"
}
```

The public API rejects raw usernames, passwords, tokens, API keys, and secrets in integration settings.

## Privy Setup

In Privy, add a custom Webhook destination for signup events and point it at:

```text
https://{postwave-public-host}/api/public/lead-integrations/privy/webhooks?account_id=acct_123&campaign_id=display_456
```

Configure HTTP Basic auth with the same username/password stored in `credentials_ref`. Moosewave verifies the `Authorization: Basic ...` header before claiming or writing any lead data.

## Payload Mapping

Moosewave accepts flat signup payloads or nested payloads under `contact`, `customer`, `signup`, `user`, `data`, or `lead`.

Core identity fields:

- `email`
- `first_name`, `firstName`
- `last_name`, `lastName`
- `name`, `full_name`
- `phone`, `phone_number`
- `company`

Nested `custom_fields`, `customFields`, `properties`, or `attributes` are flattened into `privy_field.*` evidence and can provide identity values.

Campaign metadata comes from `campaign.id`, `campaign.title`, `campaign.name`, or the configured `campaign_name`.

## Disconnect Checklist

Disconnecting the Moosewave row:

- marks the local row `disconnected`
- makes future Privy custom Webhook deliveries fail closed before writes
- preserves webhook idempotency and sync-run audit history
- returns and persists `settings.provider_cleanup`

Operator actions still required before full availability:

- remove or disable the Privy custom Webhook destination
- rotate the Basic auth credentials if no longer used
- audit duplicate/manual Webhook destinations
- prove reconnect behavior
- prove data-delete/export handling
- record live Privy account delivery-shape evidence

## Live Certification Gates

Promotion from `native_runtime_complete_live_certification_pending` to `RuntimeAvailable` requires live Privy evidence for:

- account/dashboard setup
- signup/contact delivery shape, including campaign metadata
- Basic auth success and failure behavior
- duplicate delivery behavior
- custom Webhook destination removal
- credential rotation
- reconnect
- data-delete/export behavior
- duplicate/manual destination audit
