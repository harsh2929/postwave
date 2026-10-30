# Bandwidth

Status: Native / partial (`native_runtime_complete_live_certification_pending`).

Moosewave's Bandwidth SMS surface is a first-party SMS runtime. It supports environment-backed Bandwidth credentials, sender profiles, consent-gated sends, token/basic-auth verified app callbacks, message/delivery ledgers, STOP/HELP/custom keyword handling, suppressions, quiet-hours deferral, and CSP/10DLC brand/campaign submit-poll evidence. Live provider/carrier certification remains required before `RuntimeAvailable`.

## Setup

Configure the SMS provider environment with:

- `BANDWIDTH_ACCOUNT_ID`
- `BANDWIDTH_API_USERNAME`
- `BANDWIDTH_API_PASSWORD`
- `BANDWIDTH_APPLICATION_ID`
- Optional `BANDWIDTH_FROM_NUMBER`
- Optional `BANDWIDTH_WEBHOOK_TOKEN`, or `BANDWIDTH_WEBHOOK_USERNAME` plus `BANDWIDTH_WEBHOOK_PASSWORD`

Create an SMS sender profile with provider `bandwidth`, a phone number and application ID, sender type, country, registration evidence, and optional quiet-hours metadata. Raw Bandwidth credentials are not accepted through the integrations catalog facade.

## Runtime

Campaigns, broadcasts, automations, and test sends run through the SMS gate before dispatch: consent, suppression, sender readiness, quiet hours, segment count, and tenant limits are checked before the provider call. Bandwidth sends use `/api/v2/users/{account_id}/messages`, preserve provider message IDs/status evidence, and honor Retry-After-aware provider errors.

Inbound and status callbacks are received at:

- `/api/public/sms/bandwidth/{tenant_id}`
- `/api/public/sms/bandwidth/{tenant_id}/status`

Callbacks verify the configured Bandwidth token or basic-auth credentials, record inbound messages, update delivery state for sent/delivered/failed callbacks, and apply STOP/HELP/custom keyword behavior through the shared subscription and suppression ledgers. Telnyx/Bandwidth keyword auto-replies dispatch through the provider router.

## Remaining Before RuntimeAvailable

- Live-certify application setup, number-to-campaign assignment, CSP/10DLC states, callback delivery, carrier opt-out behavior, duplicate/manual callback behavior, throughput limits, credential rotation/revocation, provider-console cleanup, reconnect/pause/disconnect, data-delete behavior, and production deliverability/cost evidence.
