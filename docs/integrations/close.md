# Close Native CRM Integration

Last updated: 2026-07-02

## Runtime Status

Close is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `close:` offset cursor checkpoints, canonical CRM contact/profile mapping, route-token signed webhook ingest for Close event-log callbacks, durable `crm_webhook_events` idempotency, CRM sync/webhook run history, local disconnect stops, scheduled retry continuation via `close_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Live workspace certification, provider-console webhook registration/cleanup proof, API-key and `signature_key` rotation proof, reconnect certification, duplicate/manual webhook audit, data-delete behavior, and provider-side cleanup proof remain open before full availability.

## Setup

- `provider`: `close`
- `settings.organization_id`: Close organization identifier.
- `credentials_ref`: vault reference containing a Close API key or JSON credential payload. For signed webhook ingest, the JSON payload also stores the Close webhook subscription `signature_key` as `webhook_signature_key`, `signature_key`, or `close_webhook_signature_key`.
- Optional: `page_size`, `lead_status_id`, `default_tags`, `list_ids`, `webhook_route_token`.

Raw API keys and signature keys are not accepted in public settings.

## Sync Behavior

Empty `/sync` or `/backfill` calls read Close contacts from `/api/v1/contact/` with `_skip` and `_limit` pagination. The cursor advances as `close:{offset}` and completes at `close:complete`. Contacts without an email are skipped.

Close webhooks are received at:

- `/api/public/crm-integrations/close/webhooks/{webhook_route_token}`

The handler resolves only one active Close integration by `webhook_route_token` or `close_webhook_route_token`, verifies `close-sig-hash` and `close-sig-timestamp` using HMAC-SHA256 over `timestamp + raw_body` with the vault-backed Close subscription `signature_key`, then claims delivery IDs in `crm_webhook_events`. Contact callbacks upsert CRM profiles. Opportunity, task, and activity callbacks become CRM timeline events when the payload contains email/phone identity or a `contact_id` that can be hydrated through `/api/v1/contact/{id}/`.

## Disconnect

Disconnect returns and persists `provider_cleanup` evidence for the Close organization, stops local manual and scheduled contact pulls, causes route-token webhook lookups to fail closed for disconnected rows, and preserves CRM sync/webhook history. Close API-key rotation/revocation, webhook subscription deletion, duplicate/manual webhook cleanup, signature-key rotation, and workflow cleanup remain Close console/operator actions until a provider cleanup runtime is certified.

## Validation Checklist

- Connect with `organization_id` and `credentials_ref`.
- Run empty sync/backfill and confirm canonical contacts, tags/list IDs, run history, and a `close:` cursor.
- Configure a Close webhook subscription to the route-token URL, persist the returned `signature_key` in the credential secret, then confirm valid signed contact/opportunity callbacks record webhook-mode CRM sync runs and duplicate deliveries are idempotent.
- Confirm raw `webhook_signature_ref`/`webhook_secret_ref` settings are stripped from public setup while `webhook_route_token` is retained.
- Disconnect and confirm manual pulls and public webhooks are rejected for the disconnected row and `provider_cleanup` evidence is persisted.
