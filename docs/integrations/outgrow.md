# Outgrow Native Lead Integration

Status: local runtime complete, live certification pending.

Official source: https://support.outgrow.co/docs/webhooks

## Runtime Scope

Moosewave owns the public Outgrow Webhook receiver for the implemented lead-capture slice:

- Public endpoint: `POST /api/public/lead-integrations/outgrow/webhooks`
- Routing: `account_id` plus `campaign_id`; `calculator_id`, `quiz_id`, or `experience_id` may be used as optional content filters.
- Auth: vault-backed `credentials_ref` containing either a Moosewave route token or Basic auth username/password.
- Payloads: JSON/form fields for Outgrow lead creation, visits, and calculated results.
- Storage: canonical profile, list, and lead-event imports with webhook-mode run history.
- Safety: durable webhook idempotency, disconnected-row fail-closed behavior, and redacted provider evidence.

Outgrow's official webhook documentation states that webhook notifications are sent as HTTP `POST` requests with response data in a JSON request body. The local receiver also accepts form-encoded payloads so operator-created destinations can be validated safely during certification.

## Setup

Create the lead integration with:

- `account_id`
- `campaign_id`
- `credentials_ref`
- optional `calculator_id` or `quiz_id`
- optional identity field mappings such as `email_field_key`, `first_name_field_key`, and `company_field_key`
- optional `default_tags` and `list_id`

Configure the Outgrow Webhook destination URL with static routing parameters:

```text
https://{postwave-public-host}/api/public/lead-integrations/outgrow/webhooks?account_id={account_id}&campaign_id={campaign_id}
```

Use either:

- Basic auth credentials that match the referenced secret, or
- a route token sent as `token`, `webhook_token`, `route_token`, `Authorization: Bearer ...`, or `X-Postwave-Webhook-Token`.

## Certification Checklist

Before this can move from `RuntimePartial` to `RuntimeAvailable`, capture live Outgrow evidence for:

- Webhook setup in a real Outgrow account.
- Lead, visit, and result delivery shapes.
- Valid and invalid Basic auth or route-token behavior.
- Duplicate delivery idempotency.
- Webhook destination removal on disconnect.
- Credential rotation.
- Reconnect behavior.
- Historical export/manual import path.
- Data-delete proof.
- Duplicate/manual webhook destination audit.
