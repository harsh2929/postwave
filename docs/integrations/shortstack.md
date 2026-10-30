# ShortStack native integration

Status: local runtime complete, pending live ShortStack account certification.

Official setup references:

- https://help.shortstackapp.com/hc/en-us/articles/234443468-Form-Integrations
- https://help.shortstackapp.com/hc/en-us/articles/234467468-Securing-Webhook-Form-Integrations

## Implemented slice

Moosewave owns the public ShortStack Webhook form integration receiver for new entry deliveries:

```text
POST /api/public/lead-integrations/shortstack/webhooks
```

The receiver accepts ShortStack form integration payloads sent as `application/x-www-form-urlencoded` or `application/json`. It resolves the integration by `account_id` plus `campaign_id`, verifies the `X-SS-Signature` / `X-Ss-Signature` HMAC-SHA1 signature against the raw request body using the vault-backed ShortStack secret key, dedupes each delivery in `lead_webhook_events`, imports canonical profile/list/event rows, records webhook-mode lead sync runs, redacts secret-like provider evidence, and fails closed after disconnect.

Historical REST backfill is not claimed for this provider. Older ShortStack entries should be imported through canonical submissions until live certification proves an account-supported export or API path.

## Required settings

- `account_id`: ShortStack account identifier used to route deliveries.
- `campaign_id`: ShortStack campaign, contest, or giveaway identifier used to route deliveries.
- `credentials_ref`: secret reference containing the ShortStack Webhook form integration secret key.

Optional settings:

- `form_id`
- `form_name` or `campaign_name`
- `default_tags`
- `list_id`
- `email_field_key`, `first_name_field_key`, `last_name_field_key`, `full_name_field_key`, `phone_field_key`, `company_field_key`
- `submitted_at_field_key`

## Webhook URL

Configure a ShortStack Webhook form integration profile with either form-encoded or JSON content:

```text
https://{public_postwave_host}/api/public/lead-integrations/shortstack/webhooks?account_id={account_id}&campaign_id={campaign_id}
```

Add a ShortStack Secret Key to the profile and store the same value in the referenced `credentials_ref`. Include stable field mappings for identity fields plus `account_id`, `campaign_id`, and optionally `form_id`.

## Live certification checklist

- Create a real ShortStack form integration profile pointing at the Moosewave receiver.
- Configure a Secret Key and confirm the receiver accepts a valid `X-SS-Signature` and rejects invalid signatures.
- Submit at least one real entry with form-encoded content and one JSON delivery if the customer's profile uses JSON.
- Verify canonical profile, list, and event output.
- Confirm duplicate delivery idempotency and disconnected-row fail-closed behavior.
- Remove or disable the ShortStack Webhook form integration on disconnect.
- Rotate the Secret Key when no longer used.
- Record reconnect, duplicate integration audit, and data-delete evidence.

## Disconnect posture

Disconnect returns and persists `provider_cleanup` evidence. Moosewave stops local writes immediately, but ShortStack-side Webhook form integration removal, secret rotation, duplicate/manual integration audit, reconnect proof, and data-delete proof remain operator-managed until live certification is complete.
