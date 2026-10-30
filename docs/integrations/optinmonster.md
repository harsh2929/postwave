# OptinMonster Integration

Status: Native / partial, local runtime complete, live OptinMonster certification pending.

OptinMonster is supported through its Webhook integration. Moosewave owns the public receiver, route-token verification, account/campaign routing, webhook idempotency, canonical profile/list/event import, lead sync run history, and local disconnect guards. OptinMonster-side Webhook setup and cleanup remain operator-managed until live certification proves the full flow.

Official OptinMonster setup reference:

- Webhook integrations require a Pro plan or higher and send JSON payloads with `lead`, `campaign`, `meta`, and `smart_tags` data: https://optinmonster.com/docs/how-to-connect-optinmonster-with-a-webhook/

## Setup

Create the Moosewave lead integration with:

```json
{
  "provider": "optinmonster",
  "name": "OptinMonster Summer Campaign",
  "credentials_ref": "secret://lead/optinmonster/summer",
  "settings": {
    "account_id": "acct_123",
    "campaign_id": "campaign_456",
    "campaign_name": "Summer Campaign",
    "default_tags": "optinmonster,summer",
    "list_id": "list_123"
  }
}
```

Store a route token in the credential reference as either a raw token or JSON:

```json
{
  "webhook_token": "generated-route-token"
}
```

Configure the OptinMonster Webhook integration URL as:

```text
https://app.postwave.example/api/public/lead-integrations/optinmonster/webhooks?account_id=acct_123&campaign_id=campaign_456&token=generated-route-token
```

If the token should not be in the URL, send it as a header instead:

```text
X-Postwave-Webhook-Token: generated-route-token
```

The receiver also accepts `Authorization: Bearer generated-route-token`, `X-Postwave-Token`, `X-OptinMonster-Webhook-Token`, `X-OptinMonster-Token`, or JSON fields named `token`, `webhook_token`, `route_token`, `postwave_token`, or `optinmonster_token`. Account and campaign routing can be supplied by query parameters, headers, or JSON fields named `account_id` and `campaign_id`.

## Supported Payloads

The public receiver supports OptinMonster JSON webhook payloads with:

- `lead` fields such as `id`, `email`, `name`, `first_name`, `last_name`, `phone`, and `company`.
- `campaign` fields such as `id`, `name`, or `title`.
- `meta` fields such as `submitted_at`, `created_at`, `timestamp`, `page_url`, and event metadata.
- `smart_tags` fields such as UTM values or campaign personalization values.

Mapped identity fields are inferred from field labels such as `email`, `name`, `first_name`, `last_name`, `phone`, and `company`. Operators can override mapping with `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`, and `submitted_at_field_key`.

## Disconnect

Disconnect marks the local OptinMonster row disconnected, preserves webhook/run audit history, and returns persisted `provider_cleanup` evidence. Moosewave stops accepting matching OptinMonster Webhook deliveries before local writes.

Operator-managed cleanup remains:

- Remove or disable the OptinMonster Webhook destination.
- Rotate the route token if it is no longer used.
- Audit duplicate/manual OptinMonster Webhook destinations.
- Record OptinMonster-side cleanup, reconnect, and data-delete evidence for live certification.

## Live Certification Gate

Promote OptinMonster to `RuntimeAvailable` only after live OptinMonster Pro account certification proves Webhook setup, JSON delivery shape, header/query/body token routing, duplicate delivery behavior, disconnect fail-closed behavior, destination cleanup, token rotation, reconnect, and data-delete handling.
