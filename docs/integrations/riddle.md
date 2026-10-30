# Riddle Integration

Last updated: 2026-07-04

## Runtime Status

Riddle is a Moosewave-managed native lead-capture integration at `native_runtime_complete_live_certification_pending` for the implemented Webhook receiver slice. Catalog status remains `Native / partial` until live Riddle account certification evidence is attached and reviewed.

Implemented locally:

- Public POST receiver: `/api/public/lead-integrations/riddle/webhooks`
- Route resolution by `account_id` plus Riddle `quiz_id` / `riddleId`
- Vault-backed Riddle signature key or Moosewave route-token verification
- JSON lead/result payload ingest for Riddle lead form webhook deliveries
- Durable lead webhook idempotency through `lead_webhook_events`
- Canonical profile, event, and optional list import
- Redacted provider evidence for token, signature, secret, password, and authorization fields
- Webhook-mode sync run history
- Disconnected-row fail-closed behavior
- Operator-managed provider cleanup evidence on disconnect

## Official Provider Evidence

Official Riddle documentation: https://www.riddle.com/help/leads/send-leads-to-a-webhook

The Riddle help page documents sending leads to a webhook as JSON and describes a signature key for authenticating webhook responses. The local runtime supports the documented JSON shape including `uniqueId`, `riddleId`, `identifier`, `createdAt`, and nested `data.form`, `data.riddle`, and `data.result` objects. It also supports legacy/help-center field names observed in Riddle examples, including `GUID`, `UUID`, `id`, `riddleData`, `lead2Data`, `questionData`, `resultData`, and `apiInfo`.

## Setup Contract

Create a lead integration with:

- `provider`: `riddle`
- `account_id`: Riddle account identifier used for webhook routing
- `quiz_id`: Riddle quiz, poll, assessment, or form identifier
- `credentials_ref`: vault reference containing either the Riddle signature key or a Moosewave route token

Optional settings:

- `campaign_id`
- `riddle_id`
- `riddle_name`
- `quiz_name`
- `default_tags`
- `list_id`
- `email_field_key`
- `first_name_field_key`
- `last_name_field_key`
- `full_name_field_key`
- `phone_field_key`
- `company_field_key`
- `submitted_at_field_key`

## Webhook Configuration

Configure the Riddle webhook destination URL as:

```text
https://{postwave-public-host}/api/public/lead-integrations/riddle/webhooks?account_id={account_id}
```

When using route-token auth, append the token in the URL:

```text
https://{postwave-public-host}/api/public/lead-integrations/riddle/webhooks?account_id={account_id}&token={route_token}
```

When using signature-key auth, store the Riddle signature key in `credentials_ref`. The receiver accepts signature material from common webhook signature headers, including `X-Riddle-Signature`, `X-Riddle-Signature-SHA256`, `X-Webhook-Signature`, `X-Signature`, and `X-Hub-Signature-256`.

## Live Certification Gates

Before promoting Riddle to `RuntimeAvailable`, collect evidence for:

- Live Riddle account and quiz/form ownership
- Webhook destination setup in Riddle
- Production JSON delivery shape for lead/result payloads
- Signature-key success and failure behavior, or route-token success and failure behavior
- Duplicate-delivery idempotency behavior
- Riddle Webhook destination removal on disconnect
- Signature key or route-token rotation
- Duplicate/manual webhook destination audit
- Reconnect behavior
- Historical export/import behavior
- Data-delete and export behavior
- Live Riddle certification approval
