# Postscript

Status: Native / partial (`native_runtime_complete_live_certification_pending`).

Moosewave's Postscript connector is a managed CRM/SMS runtime. It supports credential-reference setup, manual and scheduled cursor-paged Postscript subscriber pulls, phone-keyed identity for SMS-only subscribers, route-token public webhook ingest for incoming messages and subscriber lifecycle events, durable webhook idempotency, and operator-managed `provider_cleanup` evidence on disconnect.

## Setup

Create a CRM integration with:

- `provider`: `postscript`
- `credentials_ref`: vault reference containing Postscript API-key material

Optional settings:

- `api_base_url`: explicit API host override for tests or regional gateways
- `page_size`: subscriber page size, capped at 500
- `default_tags`: tags to stamp onto imported subscribers
- `list_ids`: Moosewave list IDs to stamp onto imported subscribers
- `webhook_route_token`: opaque token used in `/api/public/crm-integrations/postscript/webhooks/{webhook_token}`

The credential vault payload should include the Postscript API key and, when webhooks are enabled, the Postscript webhook signing token as `webhook_signing_token`, `webhook_signature`, `webhook_token`, or `signing_token`. Raw API keys and webhook secrets are not accepted in public integration settings.

## Runtime

Empty `/sync` or `/backfill` calls route to the Postscript REST backfiller. The puller calls `/subscribers` with bearer API-key auth, follows Postscript cursor tokens, persists `postscript:` cursor checkpoints, maps email and phone-only subscribers to canonical contacts, and preserves Postscript subscriber ID, phone number, and SMS channel evidence in contact properties.

Manual and scheduled continuation share `postscript_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying `postscript:` cursor. Empty manual requests skip Postscript calls while a retry cursor is not due, resume the embedded cursor when due, and store `BACKFILL_FAILED` retry state on provider pull failures.

Postscript webhooks are received at the route-token URL, verify the `Postscript-Signature` header against the vault-backed signing token, claim deliveries in `crm_webhook_events`, and map `shop.incoming_message`, `shop.subscriber.opt_in`, and `shop.subscriber.opt_out` into CRM contacts/events. Phone-only webhook events create or resolve phone-keyed subscribers through the shared identify path before event tracking.

## Disconnect

Disconnect returns and persists `provider_cleanup` evidence, stops local manual/scheduled subscriber pulls and public webhook routing, and preserves CRM sync/webhook history. Postscript API-key rotation/revocation, duplicate/manual webhook cleanup, subscriber exports, keyword automations, and opt-in workflow cleanup remain Postscript console/operator actions until live provider certification proves the cleanup path.

## Remaining Before RuntimeAvailable

- Live-certify Postscript auth, pagination, rate limits, signed webhook delivery, duplicate delivery behavior, reconnect, disconnect cleanup, credential/signing-token rotation, data-delete behavior, and provider-console webhook cleanup proof.
