# Help Scout

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Moosewave's Help Scout connector is a managed partial-native support integration (`native_runtime_complete_live_certification_pending`) for mailbox-scoped conversation history and signed app webhook ingest. It supports credential-reference storage, explicit `/sync` and `/backfill` provider pulls, embedded thread/message mapping, scheduled bounded continuation, signed `X-HelpScout-Signature` callback verification, durable webhook idempotency, sparse conversation refresh, canonical support ticket/profile/message/event mapping, support sync history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

The connector remains partial until real Help Scout mailboxes are certified for provider-side webhook setup/deletion posture, credential rotation, reconnect, disconnect, data-delete behavior, and live delivery evidence. Help Scout-side app credential and webhook cleanup remain operator-managed until live certification proves a stronger managed cleanup path.

## Setup

Create a support integration with:

- `provider`: `help-scout`
- `settings.mailbox_id`: Help Scout mailbox identifier to sync and route webhooks
- `credentials_ref`: vault reference containing `{ "client_id": "...", "client_secret": "..." }`

Optional settings:

- `status`: Help Scout conversation status filter; defaults to `all`
- `api_base_url`: explicit API host override for tests
- `webhook_secret_ref`: vault reference containing the Help Scout webhook secret used for `X-HelpScout-Signature`
- `help_scout_webhook_id`: optional Help Scout webhook id used to narrow public callback routing
- `backfill_on_connect`: set to `false` to opt out of automatic bounded history import

Raw client secrets and webhook secrets are not accepted in public integration settings.

## Runtime

Empty `/sync` and `/backfill` calls exchange OAuth client credentials through `POST /v2/oauth2/token`, then pull from `GET /v2/conversations` using `mailbox`, `status`, `page`, and `embed=threads` query parameters. The puller maps primary-customer email/name evidence, falls back to embedded thread customer identity when the primary customer envelope is sparse, stores stable `help-scout://conversation/{id}` source IDs, maps customer/user/note threads into `help-scout://thread/{id}` support messages, and persists `help-scout:` cursor checkpoints.

If a conversation list response does not include embedded thread data, the runtime can fetch paginated `GET /v2/conversations/{id}/threads` as a fallback. `Retry-After` and `X-RateLimit-Retry-After` provider hints from either conversation or thread requests are propagated into scheduled retry cursors.

Signed app callbacks land at `POST [historical public callback path redacted]`. The handler resolves the integration by mailbox id plus optional webhook id, verifies the raw body with `X-HelpScout-Signature` HMAC-SHA1/base64 using `webhook_secret_ref`, reads the event from `X-HelpScout-Event`, claims the delivery in `support_webhook_events`, maps full conversation payloads directly, and refreshes sparse conversation-id payloads through `GET /v2/conversations/{id}?embed=threads`.

Scheduled continuation scans stale connected, active, or errored Help Scout rows, runs bounded 10-page ticks, records scheduled support sync runs, and stores `help_scout_retry:` cursors with attempt count, next attempt time, status, error evidence, and the underlying Help Scout page cursor.

Manual empty `/sync` and `/backfill` calls use the stored `sync_cursor` when no cursor is supplied and understand the same `help_scout_retry:` cursor envelope as scheduled continuation. Not-due retry cursors return the stored cursor without calling Help Scout or writing a sync run; due retry cursors resume the underlying `help-scout:` page cursor. Provider failures persist `BACKFILL_FAILED` retry state, and local sync-run failures attempt `SYNC_FAILED` retry state for the pre-fetch cursor.

## Disconnect And Cleanup

`DELETE /api/v1/support-integrations/{id}` marks the local Help Scout row disconnected, stops scheduled conversation pulls, makes manual `/sync`, `/backfill`, and admin `/ingest` return `409 integration_disconnected`, prevents signed Help Scout app webhook routing from resolving that row, preserves support sync/webhook audit history, and returns plus persists `settings.provider_cleanup` readiness evidence. Stale run recording cannot revive the disconnected row or mutate its cursor/timestamp/error fields.

That evidence records `status=operator_action_required`, the mailbox ID and webhook ID when known, local Moosewave stop effects, and checklist actions for Help Scout OAuth app credential rotation, app webhook subscription deletion, and duplicate/manual webhook audit. Moosewave does not call a Help Scout cleanup API on support disconnect yet, and the evidence never includes raw credential refs or webhook secret refs.

## Validation Checklist

- Create a Help Scout integration with OAuth client-credential secret refs.
- Confirm empty `/sync` or `/backfill` imports conversation rows, messages, support profiles, and support events.
- Force a `429` or `5xx` response with `X-RateLimit-Retry-After` or `Retry-After` and confirm Moosewave stores a `help_scout_retry:` cursor; confirm a not-due retry cursor skips provider calls and a due retry cursor resumes the embedded provider cursor without resetting attempts.
- Send a signed Help Scout webhook body and confirm invalid signatures do not claim webhook deliveries.
- Confirm sparse conversation-id webhook payloads refresh via `GET /v2/conversations/{id}?embed=threads`.
- Disconnect and confirm the response plus saved settings include `provider_cleanup` readiness evidence while Help Scout-side app credential and webhook cleanup remain operator-managed.
- Live-certify reconnect, disconnect, credential rotation/revocation, webhook delivery, and data-delete behavior before promotion.
- Promote Help Scout from `RuntimePartial` to `RuntimeAvailable` only after managed cleanup automation and live mailbox evidence are proven.

Verification:

- `go test -count=1 ./internal/support_integrations -run 'HelpScout'`, `go test -count=1 ./internal/integrations -run 'HelpScout'`, and `go test -count=1 ./internal/support_integrations ./internal/integrations .` from `apps/api` cover Help Scout provider metadata, REST mapping, embedded thread/message mapping, REST conversation refresh, signed app webhook verification, durable webhook idempotency, sparse refresh retry behavior, scheduled worker message counters, scheduled retry cursors, and facade truthfulness.
