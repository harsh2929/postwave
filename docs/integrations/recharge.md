# Recharge Native Integration

Catalog status: `Native / partial`.

Moosewave's Recharge connector is a managed subscription runtime for pulling
Recharge subscriptions into canonical lifecycle profiles and ingesting
tokenized subscription/charge webhooks with optional Recharge HMAC
verification. It supports credential-reference storage, explicit `/sync` and
`/backfill` provider pulls, scheduled bounded continuation, durable webhook
delivery claims, canonical subscription/event mapping, run history, persisted
provider-cleanup readiness evidence, and a local operator cleanup
acknowledgment endpoint.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Subscription providers: `GET /api/v1/subscription-integrations/providers`
- Subscription integration create/list/get: `POST /api/v1/subscription-integrations`, `GET /api/v1/subscription-integrations`, `GET /api/v1/subscription-integrations/{id}`
- Manual sync/backfill: `POST /api/v1/subscription-integrations/{id}/sync`, `POST /api/v1/subscription-integrations/{id}/backfill`
- Disconnect: `DELETE /api/v1/subscription-integrations/{id}`
- Local cleanup acknowledgment: `POST /api/v1/subscription-integrations/{id}/provider-cleanup/acknowledge`
- Public webhook ingest: `POST /api/public/subscription-integrations/recharge/ingest/{token}`
- Runs: `GET /api/v1/subscription-integrations/{id}/runs`

## Setup

Create a subscription integration with:

- `provider=recharge`
- `store_domain`
- `credentials_ref`
- Optional `api_version`
- Optional `page_size`, capped at 250
- Optional `webhook_secret_ref` for `X-Recharge-Hmac-Sha256`

Public settings must store references only. The credential secret referenced by
`credentials_ref` must contain a Recharge API token as `access_token`, `token`,
`api_key`, or a raw secret string.

## Sync Behavior

- The puller calls `GET /subscriptions`.
- Requests use `X-Recharge-Access-Token`, `X-Recharge-Version`, and
  `User-Agent` headers.
- Recharge `limit`/`next_cursor` pagination is persisted as durable `recharge:`
  checkpoints.
- Subscription snapshots map to stable `recharge://subscription/{id}` source
  IDs with normalized email, customer/subscription IDs, status, SKU, product
  evidence, next charge, cancel, and update timestamps.
- The scheduled worker scans connected, active, or errored Recharge rows whose
  last sync is stale, processes up to 10 pages per tick, records scheduled
  subscription sync runs, and resumes from the stored cursor. It over-fetches a
  bounded candidate set and skips not-yet-due `recharge_retry:` cursors before
  consuming the runnable limit, so deferred retries do not starve due work.
- Provider `429` and `5xx` responses are surfaced as retry-aware errors when
  `Retry-After` is present. Scheduled failures persist `recharge_retry:` cursors
  with attempt count, next attempt time, status, truncated error text, and the
  underlying Recharge cursor.
- Empty manual `/sync` and `/backfill` requests use the stored `sync_cursor`
  when the request body omits a cursor. If the stored cursor is a not-yet-due
  `recharge_retry:` cursor, Moosewave returns the same cursor without calling
  Recharge or writing a run. Due retry cursors unwrap to the underlying
  Recharge cursor; provider failures persist a new `BACKFILL_FAILED` retry
  cursor, fully failed local writes persist a `SYNC_FAILED` retry cursor for the
  pre-fetch cursor instead of advancing past unlanded rows, and local sync-run
  persistence failures attempt a `SYNC_FAILED` retry cursor for the pre-fetch
  cursor.
- Public tokenized webhook ingest verifies `X-Recharge-Hmac-Sha256` when
  `webhook_secret_ref` is configured, resolves only the matching
  `/subscription-integrations/recharge/ingest/{token}` provider path, claims
  deliveries in `subscription_webhook_events` using provider delivery/request
  IDs or an integration/topic/body-hash fallback, then maps `subscription/*`
  payloads to canonical subscriptions and `charge/*` payloads to lifecycle
  events.
- Reconnecting a previously disconnected Recharge row replaces stale settings,
  clears old cursor/timestamp/error state, and starts connect-time backfill from
  a fresh cursor. Connect-time backfill reloads the current row before each page
  and stops before provider calls or writes if the row has been disconnected.
- Charge lifecycle events preserve Recharge charge, customer, subscription,
  order, status, type, currency, total/subtotal/tax/discount/refund, timestamp,
  subscription-id fanout, and line-item evidence in track-event properties.

## Disconnect Cleanup Evidence

`DELETE /api/v1/subscription-integrations/{id}` marks the local Recharge row
`disconnected`, stops scheduled Recharge REST pulls for that row, rejects manual
sync/backfill, direct admin ingest, and pause with
`409 integration_disconnected`, prevents the tokenized public webhook ingest URL
from resolving the row, and retains sync/run history. Stale run-recording paths
preserve disconnected row status, cursor, timestamp, and error fields instead
of reviving the row. The response includes
`provider_cleanup`, and the same object is stored as
`settings.provider_cleanup`.

The evidence is operator-managed readiness evidence only:

- `managed_provider_cleanup=false`
- `provider_cleanup_posture=operator_managed_provider_console`
- credential/webhook booleans indicate whether Moosewave had references or a
  tokenized ingest URL, without exposing secret values
- Recharge API-token revocation or rotation, webhook target deletion, and
  duplicate/manual webhook audits remain Recharge console actions until managed
  cleanup automation is certified

After the operator reviews or completes the provider-console checklist, call
`POST /api/v1/subscription-integrations/{id}/provider-cleanup/acknowledge` to
merge local attestation into `settings.provider_cleanup`. The endpoint is
Recharge-only, requires an already disconnected row with recorded
`provider_cleanup`, and does not call Recharge APIs.

Supported `completed_actions` keys:

- `api_token_revoked_or_rotated`
- `webhook_target_or_subscription_removed_or_disabled`
- `tokenized_ingest_urls_removed`
- `duplicate_or_manual_webhook_targets_audited`
- `provider_console_cleanup_reviewed_no_action_due`

The acknowledgment stores `status=operator_acknowledged`,
`acknowledged_at`, optional `acknowledged_by`, optional
`completed_actions`, and optional `operator_notes` while preserving the
original readiness evidence.

## Live Certification Boundary

- Live-validate against a real Recharge merchant for pagination, API-version
  behavior, 429/Retry-After behavior, subscription and charge webhook delivery,
  signature headers, reconnect, disconnect, and API-token rotation.
- Provider-console API-token revocation, webhook cleanup, duplicate/manual
  webhook audit, and data-delete evidence are the documented operator-managed
  posture unless a future certified Recharge API cleanup path is adopted.

## Validation Checklist

- Run empty `/sync` and `/backfill` requests and confirm Recharge REST calls,
  stable `recharge:` cursor output, and canonical subscription/event imports.
- Validate manual empty `/sync` and `/backfill` with a stored
  `recharge_retry:` cursor: not-due cursors should skip Recharge calls, due
  cursors should resume the embedded provider cursor, and repeated provider
  or fully failed local write failures should increment retry attempts instead
  of resetting them.
- Replay a subscription or charge webhook with the same Recharge delivery ID and
  confirm the second delivery is reported as a duplicate without writing another
  sync run or canonical event.
- Disconnect and confirm the response plus saved settings include
  `provider_cleanup` readiness evidence while Recharge-side API-token and
  webhook cleanup remains operator-managed.
- Acknowledge cleanup with the local `provider-cleanup/acknowledge` endpoint
  and confirm `settings.provider_cleanup.status=operator_acknowledged` without
  losing the original `recorded_at` and provider scope evidence.
- After disconnect, confirm manual sync/backfill returns
  `409 integration_disconnected`, direct admin ingest and pause are also
  rejected, the public tokenized webhook URL returns not found, and scheduled
  continuation does not call Recharge or mutate the disconnected row.
