# Landingi native integration

Status: local runtime complete, pending live Landingi account certification.

Official setup reference: https://landingi.com/help/webhook-integration/

## Implemented slice

Moosewave owns the public Landingi Webhook receiver for new lead deliveries:

- `GET /api/public/lead-integrations/landingi/webhooks`
- `POST /api/public/lead-integrations/landingi/webhooks`

The receiver accepts Landingi webhook payloads sent by GET or POST, including form-encoded and JSON payloads. It resolves the integration by `account_id` plus `page_id`, optionally enforces `form_id`, verifies a vault-backed route token, dedupes each delivery in `lead_webhook_events`, imports canonical profile/list/event rows, records webhook-mode lead sync runs, redacts token-like provider evidence, and fails closed after disconnect.

Historical REST backfill is not claimed for this provider. Older Landingi leads should be imported through canonical submissions until live certification proves an account-supported export or API path.

## Required settings

- `account_id`: Landingi account identifier used to route deliveries.
- `page_id`: Landingi landing page identifier used to route deliveries.
- `credentials_ref`: secret reference containing the Moosewave route token configured on the Landingi Webhook URL or request header.

Optional settings:

- `form_id`
- `page_name` or `form_name`
- `default_tags`
- `list_id`
- `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`
- `submitted_at_field_key`

## Webhook URL

Configure Landingi's Webhook integration with either GET or POST:

```text
https://{public_postwave_host}/api/public/lead-integrations/landingi/webhooks?account_id={account_id}&page_id={page_id}&token={route_token}
```

The token can also be sent in `Authorization: Bearer`, `X-Postwave-Webhook-Token`, `X-Postwave-Token`, `X-Landingi-Webhook-Token`, or body fields such as `token`, `webhook_token`, `route_token`, `postwave_token`, and `landingi_token`.

## Live certification checklist

- Create a real Landingi landing page form and configure the Moosewave Webhook URL.
- Submit a test lead using the same HTTP method and payload shape the customer will use.
- Verify canonical profile, list, and event output.
- Confirm route-token success and failure behavior.
- Confirm duplicate delivery idempotency and disconnected-row fail-closed behavior.
- Remove or disable the Landingi Webhook integration on disconnect.
- Rotate the route token when no longer used.
- Record reconnect, duplicate integration audit, and data-delete evidence.

## Disconnect posture

Disconnect returns and persists `provider_cleanup` evidence. Moosewave stops local writes immediately, but Landingi-side Webhook integration removal, route-token rotation, duplicate/manual integration audit, reconnect proof, and data-delete proof remain operator-managed until live certification is complete.
