# Intercom

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Moosewave's Intercom connector is a managed partial-native support integration for conversation history (`native_runtime_complete_live_certification_pending`). It supports credential-reference storage, explicit `/sync` and `/backfill` provider pulls, cached contact lookup fallback, per-conversation `/conversations/{id}` detail hydration for source plus conversation-part message rows up to Intercom's 500-part API limit, signed app webhook ingest, sparse conversation refresh, scheduled bounded continuation, canonical support ticket/message/profile/event mapping, support sync history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

The connector remains `Native / partial` until real Intercom workspaces are certified for richer admin/participant enrichment requirements, attachment expansion, managed app-webhook cleanup posture, duplicate/manual target audit, credential rotation, reconnect, disconnect, data-delete behavior, and live workspace behavior.

## Setup

Create a support integration with:

- `provider`: `intercom`
- `settings.workspace_id`: Intercom workspace identifier
- `credentials_ref`: vault reference containing an OAuth access token or `{ "access_token": "..." }`
- scopes: `conversations.read` and `contacts.read`

Optional settings:

- `api_base_url`: explicit API host override for tests
- `page_size`: Conversations API page size, capped at 150
- `webhook_secret_ref`: vault reference for Intercom `X-Hub-Signature` verification, using the Intercom app client secret or equivalent app webhook signing secret
- `backfill_on_connect`: set to `false` to opt out of automatic bounded history import

Raw access tokens and webhook secrets are not accepted in public integration settings.

## Runtime

Empty `/sync` and `/backfill` calls pull from `GET /conversations` using OAuth Bearer auth, `per_page`, and `starting_after` cursor pagination. For each listed conversation, the puller retrieves `GET /conversations/{id}` so source bodies and returned `conversation_parts` can be mapped into support messages up to Intercom's 500-part API hard limit. The puller maps safe conversation source-author email/name evidence when present, stores stable `intercom://conversation/{id}` source IDs, records provider conversation-part count/limit evidence, and persists `intercom:` cursor checkpoints.

When a conversation does not contain a safe customer requester email, the puller uses the first referenced conversation contact and fetches `GET /contacts/{id}` once per unique contact ID on the page. Contact lookup supplies requester email/name fallback and preserves contact ID, external ID, phone, author ID/type, and assignee IDs as support-ticket evidence. Staff source authors are not used as requester identities. Existing installs without contact scope degrade to a skipped unmappable conversation instead of failing the whole pull on `401`, `403`, or `404`.

Scheduled continuation scans stale connected, active, or errored Intercom rows, runs bounded 10-page ticks, records scheduled support sync runs, and stores `intercom_retry:` cursors with attempt count, next attempt time, status, error evidence, and the underlying Intercom cursor.

Manual empty `/sync` and `/backfill` calls use the stored `sync_cursor` when no cursor is supplied and understand the same `intercom_retry:` cursor envelope as scheduled continuation. Not-due retry cursors return the stored cursor without calling Intercom or writing a sync run; due retry cursors resume the underlying `intercom:` cursor. Provider failures persist `BACKFILL_FAILED` retry state, and local sync-run failures attempt `SYNC_FAILED` retry state for the pre-fetch cursor.

Signed app webhooks post to `POST [historical public callback path redacted]`. The handler resolves the workspace integration, requires `webhook_secret_ref`, verifies `X-Hub-Signature: sha1=<hex>` over the raw body, claims deliveries in `support_webhook_events`, maps full `data.item` conversation payloads including source and embedded part messages, and refreshes sparse conversation notifications through `GET /conversations/{id}` before landing canonical support rows. Duplicate processed deliveries return success, in-flight duplicates return `503` with `Retry-After`, and retryable sparse-refresh failures are left claimable for provider retry.

Webhook runtime maps conversation-level ticket/profile/event state plus source and returned conversation-part message rows. Attachment expansion, richer admin/participant hydration, and managed provider-side webhook setup/deletion remain outside the current local-complete slice until live certification proves those paths.

## Disconnect And Cleanup

`DELETE /api/v1/support-integrations/{id}` marks the local Intercom row disconnected, stops scheduled conversation pulls, makes manual `/sync`, `/backfill`, and admin `/ingest` return `409 integration_disconnected`, prevents signed Intercom app webhook routing from resolving that row, preserves support sync/webhook audit history, and returns plus persists `settings.provider_cleanup` readiness evidence. Stale run recording cannot revive the disconnected row or mutate its cursor/timestamp/error fields.

That evidence records `status=operator_action_required`, the workspace ID and app webhook ID when known, local Moosewave stop effects, and checklist actions for Intercom OAuth-token revocation or app uninstall, app webhook subscription deletion, and duplicate/manual webhook audit. Moosewave does not call an Intercom cleanup API on support disconnect yet, and the evidence never includes raw credential refs or webhook secret refs.

## Validation Checklist

- Create an Intercom integration with OAuth access-token credentials.
- Confirm empty `/sync` or `/backfill` imports conversation rows, source/retrieved part support messages, provider conversation-part count/limit evidence when Intercom reports it, and support profile/events.
- Force a `429` or `5xx` response with `Retry-After` and confirm Moosewave stores an `intercom_retry:` cursor; confirm a not-due retry cursor skips provider calls and a due retry cursor resumes the embedded provider cursor without resetting attempts.
- Confirm `contacts.read` scope is present for target workspaces where conversation list rows do not carry safe requester emails.
- Configure an Intercom app webhook for conversation topics against `[historical public callback path redacted]`, sign test payloads with the app secret, and confirm full plus sparse notifications create support sync history and any returned source/part support messages.
- Confirm attachment and admin/participant enrichment requirements before `RuntimeAvailable` promotion.
- Disconnect and confirm the response plus saved settings include `provider_cleanup` readiness evidence while Intercom-side token/app/webhook cleanup remains operator-managed.
- Live-certify reconnect, disconnect, credential rotation/revocation, and data-delete behavior before promotion.
