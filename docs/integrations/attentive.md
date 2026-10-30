# Attentive

Status: Native / partial (`native_runtime_complete_live_certification_pending`).

Moosewave's Attentive connector is a managed CRM/SMS runtime. It supports credential-reference setup, manual and scheduled cursor-paged Attentive subscriber pulls, phone-keyed identity for SMS-only subscribers, route-token public webhook ingest for SMS subscription, unsubscribe, inbound-message, sent, click, and custom-attribute events, durable webhook idempotency, and operator-managed `provider_cleanup` evidence on disconnect.

## Setup

Create a CRM integration with:

- `provider`: `attentive`
- `credentials_ref`: vault reference containing Attentive API-key material

Optional settings:

- `api_base_url`: explicit API host override for tests or regional gateways
- `page_size`: subscriber page size, capped at 1000
- `default_tags`: tags to stamp onto imported subscribers
- `list_ids`: Moosewave list IDs to stamp onto imported subscribers
- `webhook_route_token` or `attentive_webhook_route_token`: opaque token used in `/api/public/crm-integrations/attentive/webhooks/{webhook_token}`

The credential vault payload should include the Attentive API key and, when webhooks are enabled, the Attentive webhook signing key as `webhook_secret`, `webhook_signing_key`, `webhook_signing_token`, or `signing_key`. Raw API keys and webhook secrets are not accepted in public integration settings.

## Runtime

Empty `/sync` or `/backfill` calls route to the Attentive REST backfiller. The puller calls `/subscribers` with bearer API-key auth, follows Attentive cursor tokens, persists `attentive:` cursor checkpoints, maps email and phone-only subscribers to canonical contacts, and preserves Attentive subscriber ID, phone number, and SMS channel evidence in contact properties.

Manual and scheduled continuation share `attentive_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying `attentive:` cursor. Empty manual requests skip Attentive calls while a retry cursor is not due, resume the embedded cursor when due, and store `BACKFILL_FAILED` retry state on provider pull failures.

Attentive webhooks are received at the route-token URL, verify `x-attentive-hmac-sha256` over the raw body against the vault-backed signing key, claim deliveries in `crm_webhook_events`, and map `sms.subscribed`, `sms.unsubscribed`, `sms.inbound_message`, `sms.sent`, `sms.message_link_click`, and `custom_attribute.set` into CRM contacts/events. Phone-only webhook events create or resolve phone-keyed subscribers through the shared identify path before event tracking.

## Disconnect

Disconnect returns and persists `provider_cleanup` evidence, stops local manual/scheduled subscriber pulls and public webhook routing, and preserves CRM sync/webhook history. Attentive API-key rotation/revocation, duplicate/manual webhook cleanup, journeys, subscriber exports, keyword automations, and opt-in workflow cleanup remain Attentive console/operator actions until live provider certification proves the cleanup path.

## Remaining Before RuntimeAvailable

- Live-certify Attentive auth, pagination, rate limits, HMAC webhook delivery, duplicate delivery behavior, reconnect, disconnect cleanup, credential/signing-key rotation, data-delete behavior, and provider-console webhook cleanup proof.
