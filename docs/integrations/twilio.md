# Twilio

Status: Native / partial (`native_runtime_complete_live_certification_pending`).

Moosewave's Twilio SMS surface is a first-party SMS runtime. It supports environment-backed Twilio credentials, sender profiles, consent-gated sends, signed inbound and status callbacks, message/delivery ledgers, STOP/HELP/custom keyword handling, suppressions, quiet-hours deferral, and A2P brand/campaign submit-poll evidence. Live provider/carrier certification remains required before `RuntimeAvailable`.

## Setup

Configure the SMS provider environment with:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- Optional `TWILIO_MESSAGING_SERVICE_SID`
- Optional `TWILIO_FROM_NUMBER`
- Optional `TWILIO_WEBHOOK_AUTH_TOKEN` when callback verification uses a separate token

Create an SMS sender profile with provider `twilio`, a phone number or Messaging Service SID, sender type, country, registration evidence, and optional quiet-hours metadata. Raw Twilio credentials are not accepted through the integrations catalog facade.

## Runtime

Campaigns, broadcasts, automations, and test sends run through the SMS gate before dispatch: consent, suppression, sender readiness, quiet hours, segment count, and tenant limits are checked before the provider call. Twilio sends use the Messages API and preserve provider message IDs, status, pricing evidence, and Retry-After-aware provider errors.

Inbound and status callbacks are received at:

- `/api/public/sms/twilio/{tenant_id}`
- `/api/public/sms/twilio/{tenant_id}/status`

Callbacks verify Twilio signatures, record inbound messages, update delivery state, and apply STOP/HELP/custom keyword behavior through the shared subscription and suppression ledgers.

## Remaining Before RuntimeAvailable

- Live-certify Messaging Service setup, sender assignment, A2P registration states, callback delivery, carrier opt-out behavior, duplicate/manual callback behavior, throughput limits, credential rotation/revocation, provider-console cleanup, reconnect/pause/disconnect, data-delete behavior, and production deliverability/cost evidence.
