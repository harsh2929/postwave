# HighLevel Native CRM Integration

Last updated: 2026-07-02

## Runtime Status

HighLevel is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `highlevel:` cursor checkpoints, `highLevel_retry:` retry cursors, canonical CRM contact/profile mapping, opt-in opportunity, calendar, appointment, and conversation REST event pulls, route-token public webhook ingest for contact/opportunity/appointment/conversation/message callbacks, CRM sync/webhook run history, local disconnect stops, local deletion for Moosewave-owned HighLevel OAuth credential envelopes, and persisted `provider_cleanup` evidence on disconnect.

Provider webhook registration/cleanup proof, provider credential revocation/rotation proof, reconnect certification, data-delete behavior, and live location validation remain open before HighLevel can move to `RuntimeAvailable`.

## Setup

- `provider`: `highlevel`
- `settings.location_id`: HighLevel location identifier.
- `credentials_ref`: vault reference containing HighLevel OAuth/API credential material.
- Optional: `api_base_url`, `page_size`, `company_id`, `pipeline_id`, `calendar_id`, `calendar_start_time`, `calendar_end_time`, `sync_opportunities`, `sync_calendars`, `sync_appointments`, `sync_conversations`, `webhook_route_token`, `default_tags`, `list_ids`.

Raw access tokens and webhook secrets are not accepted in settings.

## Sync Behavior

Empty `/sync` or `/backfill` calls read HighLevel contacts for the configured location. The cursor stores contacts page state as `highlevel:{encoded}`. When `sync_opportunities`, `sync_calendars`, `sync_appointments`, or `sync_conversations` are enabled, the connector advances through opt-in `opportunities`, `calendars`, `appointments`, and `conversations` cursor objects before completing at `highlevel:complete`. Opportunity pulls use `/opportunities/search`, appointment pulls use `/calendars/events`, calendar inventory pulls use `/calendars/`, and conversation pulls use `/conversations/search`. Opportunity, appointment, and conversation records resolve embedded or fetched contacts before emitting CRM automation events. Manual and scheduled continuation share `highLevel_retry:` cursors: not-due retries skip provider calls, due retries resume the embedded HighLevel cursor, provider failures record Retry-After-aware `BACKFILL_FAILED` evidence, and fully failed local writes record `SYNC_FAILED` retry evidence.

Public HighLevel callbacks are received at `/api/public/crm-integrations/highlevel/webhooks/{webhook_route_token}`. Route tokens resolve the integration before tenant context exists, location IDs fail closed on mismatch, duplicate bodies are claimed through `crm_webhook_events`, and disconnected rows return not-found before mutation. Non-delete contact callbacks hydrate `/contacts/{id}` and upsert canonical profiles. Non-delete opportunity, appointment, conversation, and message callbacks hydrate `/opportunities/{id}`, `/calendars/events/appointments/{eventId}`, or `/conversations/{conversationId}` when IDs are present, resolve the contact, and emit CRM automation events. Delete callbacks are acknowledged without mutation until data-delete behavior is live-certified.

## Disconnect

Disconnect returns and persists `provider_cleanup` evidence for the HighLevel location, stops local manual and scheduled contact pulls, deletes local Moosewave-owned `crm:highlevel:*` credential envelopes when present, and preserves CRM sync history. HighLevel OAuth/API credential rotation or revocation, duplicate/manual webhook cleanup, and workflow cleanup remain HighLevel console/operator actions until a provider cleanup runtime is certified.

## Validation Checklist

- Connect with `location_id` and `credentials_ref`.
- Run empty sync/backfill and confirm canonical contacts, opt-in opportunity/appointment/conversation events, run history, and a `highlevel:` cursor.
- POST route-token ContactUpdate, OpportunityStatusUpdate, AppointmentUpdate, ConversationUpdate, and InboundMessage callbacks and confirm sparse hydration, durable webhook idempotency, CRM profile/event mapping, and location mismatch fail-closed behavior.
- Force a transient provider error and confirm manual and scheduled retries resume the stored cursor without restarting attempt history.
- Force a local profile write failure and confirm `SYNC_FAILED` retry evidence is persisted.
- Disconnect and confirm future pulls skip the row, `provider_cleanup` evidence is persisted, and Moosewave-owned HighLevel credential envelopes are deleted.
