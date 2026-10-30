# Hello Bar native integration

Status: local runtime complete, pending live Hello Bar account certification.

Official setup reference: https://support.hellobar.com/support/solutions/articles/44001406920-how-to-sync-your-webhook-with-hello-bar

## Implemented slice

Moosewave owns the public Hello Bar Webhook receiver for new lead/subscriber deliveries:

- `GET /api/public/lead-integrations/hello-bar/webhooks`
- `POST /api/public/lead-integrations/hello-bar/webhooks`

The receiver accepts Hello Bar's Webhooks integration in either GET or POST mode, including form-encoded and JSON payloads. It resolves the integration by `site_id` plus `campaign_id`/`bar_id`, verifies a vault-backed route token, dedupes each delivery in `lead_webhook_events`, imports canonical profile/list/event rows, records webhook-mode lead sync runs, redacts token-like provider evidence, and fails closed after disconnect.

Historical REST backfill is not claimed for this provider. Older Hello Bar leads should be imported through canonical submissions until live certification proves an account-supported export or API path.

## Required settings

- `site_id`: Hello Bar site identifier used to route deliveries.
- `campaign_id`: Hello Bar bar, popup, form, or campaign identifier used to route deliveries.
- `credentials_ref`: secret reference containing the Moosewave route token configured on the Hello Bar Webhook URL.

Optional settings:

- `account_id`
- `bar_name`, `campaign_name`, or `form_name`
- `default_tags`
- `list_id`
- `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`
- `submitted_at_field_key`

## Webhook URL

Configure the Hello Bar Webhooks contact-list tool with either GET or POST:

```text
https://{public_postwave_host}/api/public/lead-integrations/hello-bar/webhooks?site_id={site_id}&campaign_id={campaign_id}&token={route_token}
```

The token can also be sent in `Authorization: Bearer`, `X-Postwave-Webhook-Token`, `X-Postwave-Token`, `X-HelloBar-Webhook-Token`, or body fields such as `token`, `webhook_token`, `route_token`, `postwave_token`, and `hello_bar_token`.

## Live certification checklist

- Create a real Hello Bar contact list and attach the Moosewave Webhook URL.
- Run Hello Bar's test request and capture sanitized evidence for both the delivered method and payload field names.
- Submit at least one real popup/bar lead and verify canonical profile, list, and event output.
- Confirm duplicate delivery idempotency and disconnected-row fail-closed behavior.
- Remove or disable the Hello Bar Webhook URL on disconnect.
- Rotate the route token when no longer used.
- Record reconnect, duplicate destination audit, and data-delete evidence.

## Disconnect posture

Disconnect returns and persists `provider_cleanup` evidence. Moosewave stops local writes immediately, but Hello Bar-side Webhook removal, route-token rotation, duplicate/manual webhook audit, reconnect proof, and data-delete proof remain operator-managed until live certification is complete.
