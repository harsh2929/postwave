# Ada Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Ada is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, Ada bearer API-key auth, Data Export conversation pulls, created-window checkpoints, per-conversation message hydration through Data Export messages, end-user email enrichment, signed webhook ingest using Ada's Svix/Webhooks Standard headers, sparse conversation refresh, optional channel/handoff filtering, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `ada:` checkpoints, `ada_retry:` retry cursors, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

API-key rotation/revocation proof, duplicate/manual webhook audit, Native Social limitations, reconnect certification, data-delete posture, provider-side webhook cleanup posture, and live AI Agent certification remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `ada`
- `settings.ai_agent_domain`: Ada AI Agent domain, for example `example.ada.support`. This is the public webhook route identity.
- `credentials_ref`: vault reference containing JSON with `access_token`, `bearer_token`, `token`, or `api_key`.

Optional settings:

- `bot_id`: compatibility alias for `ai_agent_domain` on older installs.
- `ada_webhook_secret_ref`: vault reference containing the Ada webhook signing secret returned from the webhook secret endpoint.
- `ada_webhook_id`: optional Ada webhook endpoint id used to narrow public webhook routing.
- `api_base_url`: test API host override. Defaults to `https://{ai_agent_domain}/api`.
- `created_since` / `created_to`: explicit Data Export window. Ada requires ISO-8601 UTC timestamps and documents a 60-day maximum query window.
- `page_size` / `message_page_size`: Data Export page sizes, clamped to Ada's 100-10000 documented range.
- `channel`: optional channel filter.
- `handoff_integration`: optional handoff integration filter.

Raw API tokens and webhook secrets should stay in the credential vault and be passed only as references in production settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls:

`GET /v2/export/conversations?created_since=...&created_to=...&page_size=...`

`GET /v2/end-users/{end_user_id}` when the conversation export row does not include an email

`GET /v2/export/messages?conversation_id=...&created_since=...&created_to=...&page_size=...`

Conversation rows with email evidence become canonical support tickets. Message rows become canonical support messages with `end_user` mapped inbound, `human_agent` mapped outbound agent, and `ai_agent` mapped outbound AI. Ada `meta.next_page_uri` values are stored in encoded `ada:` cursors; completion is `ada:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `ada_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded Ada cursor. Provider `Retry-After` values are preserved for retry timing.

## Webhook Behavior

Ada webhooks route to:

`POST [historical public callback path redacted]`

or:

`POST [historical public callback path redacted]`

The handler resolves the support row by `ai_agent_domain` and optional webhook endpoint id, verifies `webhook-id`, `webhook-timestamp`, and `webhook-signature` using the Ada/Svix signing secret, claims deliveries durably, and sparse-refreshes the conversation through the Conversations API. Fully identified payloads with email evidence can fall back to direct mapping if the refresh target is gone.

Webhook deliveries record `run_mode=webhook`, replay suppression evidence, `ada_webhook_event`, `ada_ai_agent_domain`, and the scrubbed raw payload on ticket properties.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, prevents signed public webhook routing from resolving the row, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Ada-side API-key rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `ai_agent_domain` and a vault API-token JSON.
- Run an empty sync and confirm conversation export, end-user enrichment, message hydration, ticket/message/profile/event writes, run history, and `ada:` cursor updates.
- Configure `handoff_integration` or `channel` and confirm unrelated rows are skipped without stopping cursor progress.
- Send an Ada webhook signed with `webhook-id`, `webhook-timestamp`, and `webhook-signature` and confirm sparse refresh, durable replay suppression, `run_mode=webhook`, and `ada_webhook_event` metadata.
- Force a transient provider failure with `Retry-After` and confirm an `ada_retry:` cursor is stored and later resumes the embedded cursor.
- Disconnect and confirm local stop effects plus provider cleanup guidance are persisted without raw credential material.
- Live-certify Ada Data Export access, pagination, signed webhooks, reconnect, disconnect, credential rotation, Native Social limitations, and data-delete behavior before promotion.

## References

- Ada authentication: https://docs.ada.cx/reference/introduction/authentication
- Ada pagination: https://docs.ada.cx/reference/introduction/pagination
- Ada limits: https://docs.ada.cx/reference/introduction/limits
- Ada Data Export overview: https://docs.ada.cx/reference/data-export/overview
- Ada Data Export conversations: https://docs.ada.cx/data-export-conversation-object/get-conversations
- Ada Data Export messages: https://docs.ada.cx/data-export-message-object/get-messages
- Ada Conversations API: https://docs.ada.cx/reference/conversations/overview
- Ada conversation message webhook: https://docs.ada.cx/reference/conversations/conversation-message-webhook
- Ada webhook secret endpoint: https://docs.ada.cx/reference/webhooks/get-webhook-secret
