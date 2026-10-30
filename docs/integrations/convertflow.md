# ConvertFlow Native Lead Integration

ConvertFlow is `Native / partial` in the catalog, with the implemented local runtime classified as `native_runtime_complete_live_certification_pending`.

This slice covers ConvertFlow custom Webhook automation ingest for fields-submitted/contact/conversion style events. It does not claim a ConvertFlow REST submissions poller or automated historical export.

Official reference: [ConvertFlow Zapier integration](https://www.convertflow.com/integrations/zapier).

## Implemented Runtime

- Public receiver: `POST /api/public/lead-integrations/convertflow/webhooks`
- Route scope: `account_id` plus `campaign_id`
- Auth: route token resolved from `credentials_ref`
- Payloads: JSON contact, fields, campaign/CTA/form, and metadata objects
- Idempotency: `lead_webhook_events` claim/processed lifecycle
- Imports: canonical lead profile, list membership, and `lead.submitted` event
- Disconnect: row-preserving local disconnect with operator-managed ConvertFlow cleanup evidence

## Connection Payload

```json
{
  "provider": "convertflow",
  "name": "ConvertFlow Quiz CTA",
  "credentials_ref": "lead:convertflow:quiz-cta",
  "settings": {
    "account_id": "acct_123",
    "campaign_id": "cta_456",
    "site_id": "site_789",
    "campaign_name": "Quiz CTA",
    "default_tags": "convertflow,quiz",
    "list_id": "list_123"
  }
}
```

Store the route token in the credential vault:

```json
{
  "webhook_token": "generated-route-token"
}
```

The public API rejects raw route tokens, API keys, passwords, and secrets in integration settings.

## ConvertFlow Setup

Create or edit a ConvertFlow automation that sends a webhook when fields are submitted, a contact is created/updated, or a CTA/conversion event should be mirrored into Moosewave.

Point the webhook URL at:

```text
https://{postwave-public-host}/api/public/lead-integrations/convertflow/webhooks?account_id=acct_123&campaign_id=cta_456&token=generated-route-token
```

The token may also be supplied as `Authorization: Bearer ...`, `X-ConvertFlow-Webhook-Token`, `X-Postwave-Webhook-Token`, `webhook_token`, `route_token`, or `convertflow_token`.

## Payload Mapping

Moosewave accepts flat JSON payloads or nested payloads under:

- `contact`, `person`, `visitor`, `lead`, `subscriber`, or `customer`
- `fields`, `form_fields`, `custom_fields`, `answers`, or `properties`
- `campaign`, `cta`, `form`, `funnel`, `quiz`, or `survey`
- `meta`, `metadata`, or `event`

Core identity fields:

- `email`
- `first_name`, `firstName`
- `last_name`, `lastName`
- `name`, `full_name`
- `phone`, `phone_number`
- `company`

Campaign metadata comes from `cta.id`, `cta.title`, `campaign.name`, `form.name`, or the configured `campaign_name`.

## Disconnect Checklist

Disconnecting the Moosewave row:

- marks the local row `disconnected`
- makes future ConvertFlow custom Webhook deliveries fail closed before writes
- preserves webhook idempotency and sync-run audit history
- returns and persists `settings.provider_cleanup`

Operator actions still required before full availability:

- remove or disable the ConvertFlow webhook automation pointing at Moosewave
- rotate the route token if no longer used
- audit duplicate/manual webhook automations
- prove reconnect behavior
- prove data-delete/export handling
- record live ConvertFlow account delivery-shape evidence

## Live Certification Gates

Promotion from `native_runtime_complete_live_certification_pending` to `RuntimeAvailable` requires live ConvertFlow evidence for:

- account/dashboard setup
- fields-submitted/contact/conversion delivery shape
- route-token success and failure behavior
- duplicate delivery behavior
- webhook automation removal
- credential rotation
- reconnect
- data-delete/export behavior
- duplicate/manual automation audit
