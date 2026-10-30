# Smile.io Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave's Smile.io connector is a managed loyalty integration for customer loyalty profile and loyalty-event backfill. The local runtime is complete for the implemented Smile.io slice and supports API-token credential references, Smile.io Customers REST pulls, historical and incremental points transaction pulls, historical and incremental reward fulfillment pulls, signed Smile app webhooks, integration-scoped webhook delivery idempotency with body-hash conflict checks, scheduled retry-aware continuation, points balance and VIP tier profile mapping, event-phase member refresh, loyalty event mapping, loyalty sync history, and Retry-After-aware provider errors.

The connector remains partial until real Smile.io stores are certified for customer/event pagination, `updated_at_min` behavior, app webhook delivery behavior, Smile-side cleanup posture, credential rotation, reconnect, disconnect, and data-delete behavior.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/smile/connect/start`, `POST /api/v1/integrations/smile/connect/callback`
- Facade action metadata/delegation: `POST /api/v1/integrations/smile/sync`, `POST /api/v1/integrations/smile/backfill`, `POST /api/v1/integrations/smile/pause`, `DELETE /api/v1/integrations/smile`
- Admin create/update: `POST /api/v1/loyalty-integrations`
- Manual sync: `POST /api/v1/loyalty-integrations/{id}/sync`
- Backfill: `POST /api/v1/loyalty-integrations/{id}/backfill`
- Smile app webhooks: `POST /api/public/loyalty-integrations/smile/webhooks`
- Pause: `POST /api/v1/loyalty-integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/loyalty-integrations/{id}`
- Cleanup acknowledgment: `POST /api/v1/loyalty-integrations/{id}/provider-cleanup/acknowledge`

## Smile.io Setup

1. Create or locate the Smile.io API token for the connected Shopify store.
2. Store the token in a Moosewave credential reference as JSON with `api_token`, or as a raw token secret.
3. Store the Smile app client secret in a Moosewave secret reference if app webhooks will be enabled.
4. Create the integration with `shop_domain` and `credentials_ref`.
5. If Smile app webhooks are enabled, set both `account_id` for pre-tenant routing and `webhook_secret_ref` for `Smile-Signature` verification. Moosewave rejects webhook-secret setup without an account ID because Smile sends one shared app URL for all authorized accounts.
6. Optionally set `api_base_url`, `page_size`, `program_id`, `sync_points_transactions=false`, or `sync_reward_fulfillments=false` when a token deliberately lacks the event scopes.

Example integration payload:

```json
{
  "provider": "smile",
  "name": "Smile loyalty",
  "status": "connected",
  "credentials_ref": "vault://integrations/smile/store",
  "settings": {
    "shop_domain": "acme.myshopify.com",
    "credentials_ref": "vault://integrations/smile/store",
    "account_id": "304169228",
    "webhook_secret_ref": "vault://integrations/smile/app-client-secret",
    "page_size": 50
  }
}
```

Example credential secret:

```json
{
  "api_token": "SMILE_API_TOKEN"
}
```

## Sync Behavior

The Smile.io backfiller reads:

- `GET /v1/customers` for loyalty customers.
- `GET /v1/points_transactions` for points earned, redeemed, and adjusted event history plus incremental event polling.
- `GET /v1/reward_fulfillments` for reward issued, pending, used, cancelled, and failed event history plus incremental event polling.
- `GET /v1/customers/{id}` to enrich points/reward rows with customer email, points balance, and VIP tier state before landing canonical events and member profile refreshes.

Requests use Bearer auth. Customer pages use `page` and `page_size`; event endpoints use Smile cursor pagination with `limit`. `page_size` is capped at 100. Empty `/sync` and `/backfill` calls pull the next customer or event page and store stable `smile:` cursors. When the request body omits a cursor, manual sync/backfill falls back to the stored `sync_cursor`. If that cursor is a not-yet-due `smile_retry:` cursor, Moosewave returns the same cursor without calling Smile or writing a run; due retry cursors unwrap to the underlying Smile customer/event cursor. Provider failures persist fresh `BACKFILL_FAILED` retry cursors, and fully failed local member/event writes or local sync-run persistence failures attempt `SYNC_FAILED` retry cursors for the pre-fetch cursor. Once a Smile row reaches `smile:complete`, stale scheduled continuation restarts points/reward event polling with `updated_at_min` set to the prior sync timestamp and preserves that watermark through provider cursor pages. Scheduled continuation scans stale connected, active, or errored Smile.io rows, skips not-yet-due retry cursors before consuming the runnable target limit, runs bounded 10-page ticks, records scheduled loyalty sync runs, and stores `smile_retry:` cursors with attempt count, next attempt time, status, error evidence, and the underlying Smile customer/event cursor.

The runtime maps Smile customer IDs, email, first/last name, points balance, and VIP tier into canonical Moosewave loyalty member rows. Member rows upsert subscriber loyalty profile state. Points transactions map to `loyalty.points_earned`, `loyalty.points_redeemed`, or `loyalty.points_adjusted` events. Reward fulfillments map to `loyalty.reward_issued`, `loyalty.reward_pending`, `loyalty.reward_redeemed`, `loyalty.reward_cancelled`, or `loyalty.reward_failed` events with reward metadata. Event-phase customer enrichment also emits deduped member refreshes so points balance and VIP tier stay current even when only points/reward rows changed.

## App Webhook Behavior

Smile app webhooks land at `POST /api/public/loyalty-integrations/smile/webhooks`. The handler reads `account_id` from the JSON body, resolves the tenant Smile integration by `settings.account_id` or `settings.smile_account_id`, resolves the configured `webhook_secret_ref`, and verifies `Smile-Signature` over `Smile-Timestamp + "." + raw_body` with HMAC-SHA256/base64 and a five-minute timestamp freshness window. Missing body `account_id` deliveries are rejected before signature lookup, and unmatched account IDs fail closed without claiming a delivery.

Verified deliveries are claimed in `loyalty_webhook_events` using the tenant, integration, provider, and Smile delivery ID. Delivery IDs prefer Smile/header/body IDs and fall back to account/topic/body hash when Smile does not supply one. Replays that are already processed return `200 OK`; same delivery IDs with different bodies return `409 webhook_body_mismatch`; in-progress duplicates return `503` with `Retry-After`. If canonical local processing fails, the claim is marked retryable instead of processed and the handler returns `503`. `ping` is verified and ignored. `customer/updated` maps the embedded customer into a canonical loyalty member refresh plus a `loyalty.customer_updated` event.

## Disconnect And Cleanup

Disconnect marks the local Smile.io row `disconnected`, removes it from unified connected-state/action-ID resolution, rejects manual sync/backfill, direct admin ingest, and pause with `409 integration_disconnected`, prevents tokenized and account-id-routed Smile app webhooks from resolving that row, and preserves sync/webhook audit history. Scheduled and connect-time backfills re-check the current row before provider calls and before local sink writes; a REST call that was already in-flight when disconnect happened may complete, but it will not write local sinks or revive the disconnected row. Stale run-recording paths preserve disconnected row status, cursor, timestamp, and error fields instead of reviving the row. The disconnect response includes `provider_cleanup` evidence with local effects and required Smile-side operator actions, and Moosewave persists the same checklist in `loyalty_integrations.settings.provider_cleanup` with `status=operator_action_required` plus `recorded_at` so later GET/list reads can show cleanup readiness after the response is gone.

After the Smile console work is completed, an admin can record local operator attestation against that persisted checklist:

```json
{
  "completed_actions": [
    "api_token_revoked_or_rotated",
    "app_webhook_target_removed_or_disabled",
    "app_client_secret_rotated_if_dedicated",
    "duplicate_or_manual_webhook_targets_audited"
  ],
  "notes": "Verified in the Smile console.",
  "acknowledged_by": "ops@example.com"
}
```

The acknowledgment endpoint only applies to disconnected Smile.io rows that already have `settings.provider_cleanup`. It merges `status=operator_acknowledged`, `acknowledged_at`, `acknowledged_by`, `completed_actions`, and `operator_notes` into the existing cleanup evidence while preserving the original local stop effects and checklist. `acknowledged_by` is derived from the authenticated user or API-key actor when available, with the request body as a fallback. This is a Moosewave-side attestation record; it does not call Smile APIs.

Moosewave does not currently revoke Smile.io API tokens, delete Smile app webhook target/authorization, rotate the Smile app client secret, or audit duplicate/manual Smile app webhook targets through a Smile API. Those remain Smile console/operator actions until live certification proves either a managed API cleanup path or a certified operator-managed cleanup posture.

## Remaining Native Gaps

- Live certification or provider API proof for Smile API-token revocation, app webhook target/authorization cleanup, secret rotation, and duplicate/manual webhook audits; current posture is persisted local cleanup readiness plus operator attestation.
- Live store certification for auth, pagination, `updated_at_min` behavior, 429/Retry-After behavior, reconnect, disconnect, credential rotation, and data-delete behavior.

## Validation Checklist

- Create a Smile.io integration using a credential secret with `api_token`.
- Run empty `/sync` and `/backfill` requests and confirm Bearer auth, customer page fetch, points transaction fetch, reward fulfillment fetch, stable `smile:` cursor output, incremental `updated_at_min` polling after `smile:complete`, and canonical loyalty member/profile/event imports.
- Validate `page_size` at 25, 50, and 100.
- Validate Retry-After handling on simulated or live 429 responses and confirm scheduled failures store a `smile_retry:` cursor.
- Validate manual empty `/sync` and `/backfill` with a stored `smile_retry:` cursor: not-due cursors should skip Smile calls, due cursors should resume the embedded customer/event cursor, and repeated provider failure should increment retry attempts instead of resetting them.
- Send signed `ping` and `customer/updated` app webhook payloads with `account_id`, `Smile-Signature`, and `Smile-Timestamp`; confirm missing or mismatched account IDs fail without creating webhook claims, invalid signatures fail, processed replays are idempotent, same-delivery different-body replays return `409`, local processing failures remain retryable, and `customer/updated` refreshes the member plus emits `loyalty.customer_updated`.
- Rotate the Smile.io API token and verify the credential reference update path.
- Verify disconnect marks the row disconnected, returns and persists `provider_cleanup` evidence, preserves audit history, stops account-id-routed webhook processing for the row, leaves Smile console credential/webhook cleanup as an operator action, and accepts only post-disconnect local cleanup acknowledgment with the supported action keys.
- After disconnect, confirm manual sync/backfill returns `409 integration_disconnected`, direct admin ingest and pause are also rejected, public tokenized ingest and account-id-routed Smile app webhooks return not found, and scheduled continuation does not call Smile or mutate the disconnected row.

## Source Notes

- Smile.io authentication: `https://dev.smile.io/api/authentication.md`
- Smile.io access scopes: `https://dev.smile.io/guides/apps/auth/access-scopes.md`
- Smile.io points transactions: `https://dev.smile.io/api/resources/points-transactions/list-points-transactions.md`
- Smile.io reward fulfillments: `https://dev.smile.io/api/resources/reward-fulfillments/list-reward-fulfillments.md`
- Smile.io webhooks: `https://dev.smile.io/guides/apps/webhooks.md`
