# KickoffLabs native integration

Status: local runtime complete, pending live KickoffLabs account certification.

Official setup references:

- https://dev.kickofflabs.com/webhooks/
- https://support.kickofflabs.com/documentation/integrations/integrating-kickofflabs-with-make

## Implemented slice

Moosewave owns the public KickoffLabs outbound Webhook receiver for lead, referral, and reward event deliveries:

- `GET /api/public/lead-integrations/kickofflabs/webhooks`
- `POST /api/public/lead-integrations/kickofflabs/webhooks`

The receiver accepts KickoffLabs outbound webhook payloads sent by GET or POST, including form-encoded and JSON payloads. It resolves the integration by `account_id` plus `campaign_id`, optionally enforces `page_id`, verifies a vault-backed route token, dedupes each delivery in `lead_webhook_events`, imports canonical profile/list/event rows, records webhook-mode lead sync runs, redacts token-like provider evidence, and fails closed after disconnect.

Historical REST backfill is not claimed for this provider. Older KickoffLabs leads, referrals, and rewards should be imported through canonical submissions until live certification proves an account-supported export or API path.

## Required settings

- `account_id`: KickoffLabs account identifier used to route deliveries.
- `campaign_id`: KickoffLabs campaign identifier used to route lead, referral, and reward events.
- `credentials_ref`: secret reference containing the Moosewave route token configured on the KickoffLabs outbound Webhook URL.

Optional settings:

- `page_id`
- `campaign_name` or `page_name`
- `default_tags`
- `list_id`
- `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`
- `submitted_at_field_key`

## Webhook URL

Configure KickoffLabs' outbound webhook destination with the Moosewave receiver URL:

```text
https://{public_postwave_host}/api/public/lead-integrations/kickofflabs/webhooks?account_id={account_id}&campaign_id={campaign_id}&token={route_token}
```

The token can also be sent in `Authorization: Bearer`, `X-Postwave-Webhook-Token`, `X-Postwave-Token`, `X-KickoffLabs-Webhook-Token`, or body fields such as `token`, `webhook_token`, `route_token`, `postwave_token`, and `kickofflabs_token`.

## Live certification checklist

- Create a real KickoffLabs campaign and configure the Moosewave outbound Webhook URL.
- Trigger at least one supported lead event, including a new lead or referral event where available.
- Capture the production GET/POST/JSON or form delivery shape used by the account.
- Verify canonical profile, list, and event output.
- Confirm route-token success and failure behavior.
- Confirm duplicate delivery idempotency and disconnected-row fail-closed behavior.
- Remove or disable the KickoffLabs outbound Webhook destination on disconnect.
- Rotate the route token when no longer used.
- Record reconnect, duplicate destination audit, historical export/import, and data-delete evidence.

## Disconnect posture

Disconnect returns and persists `provider_cleanup` evidence. Moosewave stops local writes immediately, but KickoffLabs-side outbound Webhook removal, route-token rotation, duplicate/manual webhook audit, reconnect proof, and data-delete proof remain operator-managed until live certification is complete.
