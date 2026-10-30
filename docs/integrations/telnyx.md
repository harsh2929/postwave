# Telnyx

Status: Native / partial (`native_runtime_complete_live_certification_pending`).

Moosewave's Telnyx SMS surface is a first-party SMS runtime. It supports environment-backed Telnyx credentials, sender profiles, consent-gated sends, Ed25519-verified inbound and delivery callbacks, message/delivery ledgers, STOP/HELP/custom keyword handling, suppressions, quiet-hours deferral, and 10DLC brand/campaign submit-poll evidence. Live provider/carrier certification remains required before `RuntimeAvailable`.

## Setup

Configure the SMS provider environment with:

- `TELNYX_API_KEY`
- `TELNYX_PUBLIC_KEY`
- Optional `TELNYX_MESSAGING_PROFILE_ID`
- Optional `TELNYX_FROM_NUMBER`
- Optional `TELNYX_WEBHOOK_URL`

Create an SMS sender profile with provider `telnyx`, a phone number or messaging profile ID, sender type, country, registration evidence, and optional quiet-hours metadata. Raw Telnyx credentials are not accepted through the integrations catalog facade.

## Runtime

Campaigns, broadcasts, automations, and test sends run through the SMS gate before dispatch: consent, suppression, sender readiness, quiet hours, segment count, and tenant limits are checked before the provider call. Telnyx sends use `/v2/messages`, preserve provider message IDs/status/cost evidence, and honor Retry-After-aware provider errors.

Inbound and status callbacks are received at:

- `/api/public/sms/telnyx/{tenant_id}`
- `/api/public/sms/telnyx/{tenant_id}/status`

Callbacks verify Telnyx Ed25519 signatures, record inbound messages, update delivery state from `message.finalized`, and apply STOP/HELP/custom keyword behavior through the shared subscription and suppression ledgers. Telnyx/Bandwidth keyword auto-replies dispatch through the provider router instead of TwiML.

## Remaining Before RuntimeAvailable

- Live-certify messaging profile setup, number-to-campaign assignment, 10DLC states, callback delivery, carrier opt-out behavior, duplicate/manual callback behavior, throughput limits, credential rotation/revocation, provider-console cleanup, reconnect/pause/disconnect, data-delete behavior, and production deliverability/cost evidence.
