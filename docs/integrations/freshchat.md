# Freshchat Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

Freshchat is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, Bearer-auth Users REST page pulls, per-user conversation ID discovery, conversation detail and Messages REST hydration, signed webhook sparse conversation refresh, optional channel filtering, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `freshchat:` page checkpoints, `freshchat_retry:` retry cursors, canonical support ticket/message/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Token rotation/revocation proof, reconnect certification, provider-side webhook cleanup posture, duplicate/manual webhook audit, data-delete posture, and live workspace certification remain open before full availability.

## Setup

Create the support integration with:

- `provider`: `freshchat`
- `settings.account_domain`: Freshchat or Freshworks account host, such as `acme`, `acme.freshchat.com`, or `acme.myfreshworks.com`.
- `credentials_ref`: vault reference containing a bearer token or JSON with `token`, `api_key`, `access_token`, or `bearer_token`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: users per API page; capped at Freshchat's 100 item page size.
- `channel_id`: optional local filter applied after conversation detail hydration.
- `freshchat_webhook_public_key_ref`: vault reference containing the Freshchat webhook RSA public key.
- `freshchat_webhook_id`: optional route token used to narrow signed public webhook routing.

Raw bearer tokens and webhook public-key material should be stored in the credential vault and passed only as references in production settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls Freshchat data through the documented read graph:

`GET /v2/users?page=N&items_per_page=M`

`GET /v2/users/{user_id}/conversations`

`GET /v2/conversations/{conversation_id}`

`GET /v2/conversations/{conversation_id}/messages?page=N&items_per_page=50`

User email is required before Moosewave writes canonical support rows. User pages without email evidence are skipped rather than creating phone-only support identities. Conversation IDs are de-duplicated inside a user page before detail/message hydration. Conversation status, channel, assigned agent/group, priority property, user reference/restore IDs, phone evidence, message actor/source/type, HTML/text body parts, attachment counts, and provider timestamps are preserved as support metadata. Cursors use `freshchat:<page>` and complete at `freshchat:complete`.

The scheduled support worker scans stale connected/error Freshchat rows and resumes up to the configured page budget. Provider failures store `freshchat_retry:` cursors with attempt count, next attempt time, status, error snippet, and the underlying user-page cursor. Provider `Retry-After` values are preserved for retry timing.

## Webhook Behavior

Freshchat webhooks route to:

`POST [historical public callback path redacted]`

The route resolves the active support row by normalized Freshchat/Freshworks account domain and exact route token when configured. The handler verifies `X-Freshchat-Signature` using Freshchat's documented `SHA256withRSA` signature over the raw payload and the configured RSA public key.

Freshchat webhook payloads commonly contain only `conversation_id` and `user_id`. The webhook handler therefore claims the delivery through durable support webhook idempotency, sparse-refreshes the user, conversation, and messages through the REST runtime, then writes canonical tickets/messages/profiles/events with `run_mode=webhook` and `freshchat_webhook_event` evidence.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, prevents signed public webhook routing from resolving the row, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. Freshchat-side token rotation/revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed unless a future provider API pass proves a managed lifecycle path.

## Validation Checklist

- Connect with `account_domain` and a vault credential token.
- Run an empty sync and confirm `/v2/users`, per-user conversation lookup, conversation detail, message pagination, ticket/message/profile/event writes, run history, and `freshchat:` cursor updates.
- Configure `channel_id` and confirm conversations from other channels are skipped after detail hydration without stopping user-page cursor progress.
- Send a Freshchat webhook signed with `X-Freshchat-Signature` and confirm sparse user/conversation/message refresh, durable replay suppression, `run_mode=webhook`, and `freshchat_webhook_event` metadata.
- Force a transient provider failure with `Retry-After` and confirm a `freshchat_retry:` cursor is stored and later resumes the embedded page cursor.
- Disconnect and confirm local stop effects plus provider cleanup guidance are persisted without raw credential material.
- Live-certify Freshchat user pagination, conversation/message hydration, webhooks, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.

## References

- Freshchat API documentation: https://developers.freshchat.com/api/
- Freshchat webhook payload/signature documentation: https://crmsupport.freshworks.com/support/solutions/articles/50000004461-freshchat-webhooks-payload-structure-and-authentication
