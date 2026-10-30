# Ninja Forms native integration

Status: local runtime complete, pending live WordPress/Ninja Forms certification.

Official setup reference: https://ninjaforms.com/docs/webhooks/

## Implemented slice

Moosewave owns the public Ninja Forms Webhooks add-on receiver for submission deliveries:

- `GET /api/public/lead-integrations/ninja-forms/webhooks`
- `POST /api/public/lead-integrations/ninja-forms/webhooks`

The receiver accepts Ninja Forms Webhooks action payloads sent by GET or POST, including form-encoded and JSON payloads. It resolves the integration by WordPress `site_url` plus `form_id`, verifies a vault-backed route token, dedupes each delivery in `lead_webhook_events`, imports canonical profile/list/event rows, records webhook-mode lead sync runs, redacts token-like provider evidence, and fails closed after disconnect.

Historical REST backfill is not claimed for this provider. Older Ninja Forms submissions should be imported through canonical submissions until live certification proves an account-supported export or API path.

## Required Settings

- `site_url`: WordPress site URL hosting the Ninja Forms form.
- `form_id`: Ninja Forms form identifier used to route deliveries.
- `credentials_ref`: secret reference containing the Moosewave route token configured in the Ninja Forms Webhooks action.

Optional settings:

- `form_name`
- `default_tags`
- `list_id`
- `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`
- `submitted_at_field_key`

## Webhook URL

Configure the Ninja Forms Webhooks action with the Moosewave receiver URL:

```text
https://{public_postwave_host}/api/public/lead-integrations/ninja-forms/webhooks?site_url={wordpress_site_url}&form_id={form_id}&token={route_token}
```

The token can also be sent in `Authorization: Bearer`, `X-Postwave-Webhook-Token`, `X-Postwave-Token`, `X-NinjaForms-Webhook-Token`, or body fields such as `token`, `webhook_token`, `route_token`, `postwave_token`, and `ninja_forms_token`.

## Live Certification Checklist

- Install and enable the Ninja Forms Webhooks add-on on a real WordPress site.
- Configure the Moosewave receiver URL as a Ninja Forms Webhooks action using GET or POST.
- Submit a test form using the same payload shape the customer will use.
- Capture production GET/POST/form/JSON delivery evidence.
- Verify canonical profile, list, and event output.
- Confirm route-token success and failure behavior.
- Confirm duplicate delivery idempotency and disconnected-row fail-closed behavior.
- Remove or disable the Ninja Forms Webhooks action on disconnect.
- Rotate the route token when no longer used.
- Record reconnect, duplicate Webhooks action audit, historical export/import, and data-delete evidence.

## Disconnect Posture

Disconnect returns and persists `provider_cleanup` evidence. Moosewave stops local writes immediately, but WordPress/Ninja Forms-side Webhooks action removal, route-token rotation, duplicate/manual action audit, reconnect proof, and data-delete proof remain operator-managed until live certification is complete.
