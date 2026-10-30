# Carrd Integration

Status: Native / partial, local runtime complete, live Carrd certification pending.

Carrd is supported through Carrd Custom URL forms. Moosewave owns the public receiver, route-token verification, site/form routing, webhook idempotency, canonical profile/list/event import, lead sync run history, and local disconnect guards. Carrd-side Custom URL setup and cleanup remain operator-managed until live certification proves the full flow.

Official Carrd setup references:

- Custom forms require Pro Plus or higher: https://carrd.co/docs/forms/setting-up-a-custom-form
- Custom URL forms can send to a URL with AJAX, POST, or GET; AJAX can send default, JSON, or XML payloads and can include custom headers: https://carrd.co/docs/forms/setting-up-a-custom-url-form

## Setup

Create the Moosewave lead integration with:

```json
{
  "provider": "carrd",
  "name": "Carrd Newsletter",
  "credentials_ref": "secret://lead/carrd/newsletter",
  "settings": {
    "site_id": "site_123",
    "form_id": "newsletter",
    "form_name": "Newsletter",
    "default_tags": "carrd,newsletter",
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

Configure the Carrd form as a Custom URL form pointing to:

```text
https://app.postwave.example/api/public/lead-integrations/carrd/webhooks?site_id=site_123&form_id=newsletter&token=generated-route-token
```

If the token should not be in the URL, configure a custom header instead:

```text
X-Postwave-Webhook-Token: generated-route-token
```

The receiver also accepts `Authorization: Bearer generated-route-token`, `X-Postwave-Token`, `X-Carrd-Webhook-Token`, or hidden fields named `token`, `webhook_token`, `route_token`, `postwave_token`, or `carrd_token`. Site and form routing can be supplied by query parameters, headers, or hidden fields named `site_id` and `form_id`.

## Supported Payloads

The public receiver supports:

- GET submissions with fields in the query string.
- POST `application/x-www-form-urlencoded` submissions.
- AJAX JSON submissions.
- AJAX XML submissions.
- Multipart submissions, including file metadata without storing file bodies.

Mapped identity fields are inferred from field labels such as `email`, `name`, `first_name`, `last_name`, `phone`, and `company`. Operators can override mapping with `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`, and `submitted_at_field_key`.

## Disconnect

Disconnect marks the local Carrd row disconnected, preserves webhook/run audit history, and returns persisted `provider_cleanup` evidence. Moosewave stops accepting matching Carrd Custom URL deliveries before local writes.

Operator-managed cleanup remains:

- Remove or change the Carrd Custom URL destination.
- Rotate the route token if it is no longer used.
- Audit duplicate/manual Carrd destinations.
- Record Carrd-side cleanup, reconnect, and data-delete evidence for live certification.

## Live Certification Gate

Promote Carrd to `RuntimeAvailable` only after live Carrd Pro Plus certification proves Custom URL setup, GET/POST/AJAX JSON/XML delivery, header/query/hidden-field token routing, duplicate delivery behavior, disconnect fail-closed behavior, destination cleanup, token rotation, reconnect, and data-delete handling.
