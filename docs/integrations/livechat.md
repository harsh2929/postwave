# LiveChat Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-01

## Runtime Status

LiveChat is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, Bearer-auth Archives REST backfill, optional group-scoped archive pulls, payload-secret authenticated webhook ingest, opt-in managed LiveChat Configuration API webhook registration and unregister cleanup for Moosewave-owned webhooks, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `livechat:` page checkpoints, `livechat_retry:` retry cursors, canonical support ticket/message/profile/event mapping, support sync run history, and persisted `provider_cleanup` evidence on disconnect.

Credential rotation/revocation proof, reconnect certification, managed webhook lifecycle live certification, duplicate/manual webhook audit, and live account validation remain open.

## Setup

Create the support integration with:

- `provider`: `livechat`
- `settings.account_id`: LiveChat account identifier for ownership and cleanup evidence.
- `credentials_ref`: vault reference containing a bearer token or JSON with `access_token`, `token`, or `api_key`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: archive page size.
- `group_id` or comma-separated `group_ids`: optional LiveChat group filter sent as `filters.group_ids` on archive pulls.
- `livechat_webhook_secret_ref`: vault reference for LiveChat webhook `secret_key` verification.
- `livechat_manage_webhook`: set true to let Moosewave register LiveChat Configuration API webhooks for this account.
- `livechat_owner_client_id`: LiveChat owner client id required for managed webhook registration and cleanup.
- `livechat_webhook_actions`: optional comma-separated action list; defaults to `incoming_chat,incoming_event` when managed registration is enabled.
- `livechat_webhook_id`: optional route-scoping identifier. For managed webhooks, Moosewave generates this route token and stores returned provider IDs separately for cleanup.

Raw tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request posts to `/v3.6/agent/action/list_archives`. When `group_id` or `group_ids` is configured, the request body includes `filters.group_ids` with positive numeric group IDs. Customer email evidence embedded in chat archives maps to canonical support tickets, profile upserts, and support events. Cursors use `livechat:{page_id}` and complete at `livechat:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `livechat_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded LiveChat cursor.

## Webhook Behavior

LiveChat webhooks route to `[historical public callback path redacted]`. The route resolves the active support row by `account_id` or compatible organization/account aliases and, when supplied, an exact `livechat_webhook_id`/`provider_webhook_id`/`webhook_id` match. Unscoped rows only match unscoped deliveries.

The runtime verifies the provider `secret_key` from the JSON envelope against the vault-backed `livechat_webhook_secret_ref` or compatible webhook secret reference, checks that the payload account/organization id matches the route, claims deliveries through durable support webhook idempotency, scrubs the verifier from raw evidence, and maps embedded chat users/thread events into canonical tickets, messages, profiles, and events.

When `livechat_manage_webhook` is enabled, Moosewave calls LiveChat Configuration API `register_webhook` once per configured action, using a Moosewave route token in the callback URL and the vault-backed `secret_key`. Returned provider webhook IDs are stored as managed cleanup evidence; caller-supplied provider IDs and owned-cleanup flags are stripped from public create input.

Provider `Retry-After` values from Archive REST failures are preserved and reused by scheduled retry cursor creation.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` evidence. For Moosewave-managed LiveChat webhooks, disconnect calls LiveChat Configuration API `unregister_webhook` for the stored provider webhook IDs before local disconnect. Manually configured webhook targets, LiveChat token rotation/revocation, duplicate callback audit, and live cleanup proof remain operator-managed.

## Validation Checklist

- Connect with `account_id` and a vault credential token.
- To enable managed webhooks, configure `livechat_manage_webhook=true`, `livechat_owner_client_id`, and `livechat_webhook_secret_ref`; confirm `register_webhook` creates action subscriptions without persisting raw secrets.
- Run an empty sync and confirm tickets, profile upserts, event tracking, run history, and a `livechat:` cursor. When `group_id` is configured, confirm the archive request includes `filters.group_ids`.
- Send a LiveChat webhook with a valid `secret_key` and confirm ticket/message/profile/event writes, raw evidence secret scrubbing, and durable replay suppression.
- Force a transient provider failure and confirm a `livechat_retry:` cursor is stored and later resumes the embedded cursor.
- Disconnect and confirm managed `unregister_webhook` cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify LiveChat archive paging, webhooks, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
