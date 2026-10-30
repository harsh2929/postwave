# Wisepops Integration

Status: Native / partial, local runtime complete, live Wisepops certification pending.

Wisepops is supported through signed Webhooks. Moosewave owns the public receiver, raw-body HMAC-SHA256 verification, account/campaign routing, webhook idempotency, canonical profile/list/event import, lead sync run history, and local disconnect guards. Wisepops-side hook setup and cleanup remain operator-managed until live certification proves the full flow.

Official Wisepops setup reference:

- Wisepops Webhooks send collected contact payloads to configured endpoints and sign requests with `X-Wisepops-Signature` using the site API key: https://support.wisepops.com/en/articles/9897509-webhooks

## Setup

Create the Moosewave lead integration with:

```json
{
  "provider": "wisepops",
  "name": "Wisepops Summer Popup",
  "credentials_ref": "secret://lead/wisepops/summer",
  "settings": {
    "account_id": "acct_123",
    "campaign_id": "campaign_456",
    "campaign_name": "Summer Popup",
    "hook_id": "hook_123",
    "default_tags": "wisepops,summer",
    "list_id": "list_123"
  }
}
```

Store the Wisepops API key used for webhook signature verification in the credential reference as either a raw key or JSON:

```json
{
  "api_key": "wisepops-site-api-key"
}
```

Configure the Wisepops webhook hook URL as:

```text
https://app.postwave.example/api/public/lead-integrations/wisepops/webhooks?account_id=acct_123&campaign_id=campaign_456
```

Wisepops must send `X-Wisepops-Signature`. Moosewave verifies the signature against the exact raw request body before importing any contact data.

## Supported Payloads

The public receiver supports Wisepops JSON webhook payloads shaped as either:

- A top-level array of collected contacts.
- A wrapper object containing `contacts`, `leads`, `items`, or `data`.
- A single contact object.

Mapped identity fields are inferred from contact fields such as `email`, `name`, `first_name`, `last_name`, `phone`, and `company`. Operators can override mapping with `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`, and `submitted_at_field_key`.

## Disconnect

Disconnect marks the local Wisepops row disconnected, preserves webhook/run audit history, and returns persisted `provider_cleanup` evidence. Moosewave stops accepting matching Wisepops signed Webhook deliveries before local writes.

Operator-managed cleanup remains:

- Remove or disable the Wisepops webhook hook.
- Rotate the Wisepops API key if it is no longer used.
- Audit duplicate/manual Wisepops hooks.
- Record Wisepops-side cleanup, reconnect, and data-delete evidence for live certification.

## Live Certification Gate

Promote Wisepops to `RuntimeAvailable` only after live Wisepops certification proves hook setup, contact-array delivery shape, HMAC signature behavior, duplicate delivery behavior, disconnect fail-closed behavior, hook cleanup, API-key rotation, reconnect, and data-delete handling.
