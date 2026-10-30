# Facebook Lead Ads Native Integration

Catalog status: `Native / partial`.

Moosewave's Facebook Lead Ads connector is a managed lead-capture runtime for
pulling leads from a known Meta lead form into canonical Moosewave lead
submissions. It supports credential-reference storage, explicit Graph REST
backfill, scheduled bounded continuation, signed leadgen webhook ingest,
managed Page `leadgen` subscription reconciliation, lead-ID follow-up fetches,
`field_data` identity mapping, ad/campaign attribution fields, durable webhook
claims, disconnect cleanup, and lead sync run history.

The local runtime is complete for the current Graph pull, connect-time backfill,
signed webhook, bounded lead follow-up fetch, Page subscription cleanup, retry,
disconnect cleanup, and run-history slice. The connector remains partial until
page/form ownership validation, token revocation/app uninstall posture, Meta
retention/rate-limit behavior, and live Meta app-review evidence are certified.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/facebook-lead-ads/connect/start`, `POST /api/v1/integrations/facebook-lead-ads/connect/callback`
- Facade sync/pause/disconnect: `POST /api/v1/integrations/facebook-lead-ads/sync`, `POST /api/v1/integrations/facebook-lead-ads/pause`, `DELETE /api/v1/integrations/facebook-lead-ads`
- Lead providers: `GET /api/v1/lead-integrations/providers`
- Lead integration create/list/get: `POST /api/v1/lead-integrations`, `GET /api/v1/lead-integrations`, `GET /api/v1/lead-integrations/{id}`
- Manual sync/backfill: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`
- Public webhook challenge and callback: `GET /api/public/lead-integrations/facebook-lead-ads/webhooks`, `POST /api/public/lead-integrations/facebook-lead-ads/webhooks`
- Runs: `GET /api/v1/lead-integrations/{id}/runs`

## Setup

1. Identify the Meta Page and Lead Form that own the incoming leads.
2. Store a Meta Graph access token in a Moosewave credential reference. JSON
   secrets may use `access_token`, `token`, or `bearer_token`; raw string
   secrets are treated as the access token. The same JSON secret may also carry
   `app_secret`, or a separate `webhook_secret_ref` may point at the Meta app
   secret used to verify `X-Hub-Signature-256`.
3. Create the lead integration with `provider=facebook-lead-ads`, `page_id`,
   `form_id`, `credentials_ref`, and optional `webhook_secret_ref`.
4. Moosewave reconciles the Meta Page app subscription for the `leadgen` field
   through the Page `subscribed_apps` Graph edge and stores audit-safe
   subscription evidence in integration settings.
5. New connections run a bounded, opt-out `backfill_on_connect` drain when the
   Facebook Lead Ads backfiller is configured. Operators can still run an
   explicit empty `/backfill` or `/sync` request, and the scheduled worker
   continues due connected/error integrations from the stored cursor.
6. Configure the Meta app webhook verify token in
   `FACEBOOK_LEAD_ADS_WEBHOOK_VERIFY_TOKEN`, and configure the Meta app webhook
   callback URL to the public endpoint below. The managed Page subscription is
   separate from that app-level callback configuration.

Example integration payload:

```json
{
  "provider": "facebook-lead-ads",
  "name": "Meta launch form",
  "credentials_ref": "vault://integrations/meta/lead-ads-token",
  "settings": {
    "page_id": "1234567890",
    "form_id": "9876543210",
    "ad_account_id": "act_1234567890",
    "webhook_secret_ref": "vault://integrations/meta/app-secret",
    "default_tags": "facebook,paid-lead"
  }
}
```

Example credential secret:

```json
{
  "access_token": "EAAB...",
  "app_secret": "meta-app-secret"
}
```

## Sync Behavior

The REST puller:

- Uses the stored credential reference to send `Authorization: Bearer ...` to
  Meta Graph API v25.0.
- Calls `GET /{form_id}/leads` with lead identity, field data, form, ad set,
  campaign, platform, and organic/paid attribution fields.
- Maps `field_data` names such as `email`, `first_name`, `last_name`,
  `phone_number`, and `company_name` into `SubmissionInput`.
- Preserves all lead-form fields under `facebook_lead_ads_field.*`.
- Adds stable source IDs shaped as `facebook-lead-ads://lead/{lead_id}`.
- Advances durable `facebook-lead-ads:` after-cursor checkpoints.
- The scheduled worker scans connected or errored Facebook Lead Ads rows whose
  last sync is stale, processes up to 10 Graph pages per tick, and records
  scheduled lead sync runs.
- Fresh connections with `backfill_on_connect` enabled (the default) run a
  bounded background drain through the same Graph puller so recent historical
  leads import without a manual first sync. Set `settings.backfill_on_connect`
  to `false` to opt out.
- Provider `429` and `5xx` responses are surfaced as retry-aware provider
  errors when `Retry-After` is present. Scheduled failures persist
  `facebook_lead_ads_retry:` cursors with attempt count, next attempt time,
  status, truncated error text, and the underlying after-cursor.
- Empty manual `/sync` and `/backfill` requests share the scheduled
  `facebook_lead_ads_retry:` behavior: not-due retries skip Graph calls, due
  retries resume the embedded after-cursor, provider pull failures persist
  `BACKFILL_FAILED`, and fully failed local writes persist `SYNC_FAILED`.
- Disconnected rows reject manual sync/backfill with
  `409 integration_disconnected`; scheduled continuation skips disconnected
  rows before calling Meta, and stale run recording cannot revive the
  disconnected local row.
- Records provider failures and successful imports in lead sync history.

## Page Subscription Behavior

When a Facebook Lead Ads integration is created or updated with a configured
credential resolver, Moosewave:

- Calls `POST /{page_id}/subscribed_apps` with `subscribed_fields=leadgen`.
- Stores `facebook_lead_ads_page_subscription_*` evidence for the managed Page
  subscription, including Page ID, subscribed fields, endpoint, timestamp, and
  `managed_by_postwave`.
- If Page subscription reconciliation succeeds but a new local integration row
  cannot be persisted, best-effort cleanup calls the Page subscription delete
  path so Moosewave does not leave an orphan managed `leadgen` subscription.
- On disconnect, calls `DELETE /{page_id}/subscribed_apps` with
  `subscribed_fields=leadgen` before deleting the local row when Moosewave-owned
  subscription evidence exists.
- The disconnect response includes `provider_cleanup` evidence and the same
  object is persisted to `settings.provider_cleanup`. The evidence records the
  managed Page subscription cleanup status, Page scope, subscribed fields,
  local Moosewave stop effects, and Meta Business/app actions that remain
  operator-managed, such as OAuth token revocation or duplicate CRM integration
  audits.

## Webhook Behavior

Meta validates the public callback with `hub.mode=subscribe`,
`hub.verify_token`, and `hub.challenge`. Moosewave compares the verify token to
`FACEBOOK_LEAD_ADS_WEBHOOK_VERIFY_TOKEN` and returns the challenge as plain text.

For POST deliveries, Moosewave:

- Reads the exact raw body and verifies `X-Hub-Signature-256` using the
  vault-backed Meta app secret.
- Extracts `leadgen` changes with `page_id`, `form_id`, and `leadgen_id`.
- Resolves the owning integration by provider, `page_id`, and `form_id` before
  tenant context exists.
- Claims `page:{page_id}:form:{form_id}:lead:{leadgen_id}` in
  `lead_webhook_events`; successful replays return OK without a second Graph
  fetch, and in-progress duplicates return `503` with `Retry-After`.
- Fetches `GET /{leadgen_id}` from Meta Graph before mapping the lead through
  the same canonical `field_data` path as REST backfill.
- Records webhook-mode lead sync history and marks failed run recording as
  retryable.

## Remaining Native Gaps

- Page/form ownership validation and live permission proof for Page subscription
  management.
- Provider-side token revocation and app uninstall evidence.
- Live Meta app-review, permission, retention-window, and rate-limit evidence.

## Validation Checklist

- Create a connection using only `credentials_ref`; raw token-like settings
  should be rejected.
- Run an explicit `/backfill` against a test lead form and confirm the Graph
  request includes `/{form_id}/leads` and a Bearer token.
- Confirm email, name, phone, company, ad, campaign, and custom field data map
  into the resulting lead submission.
- Confirm empty pages advance to `facebook-lead-ads:complete` without inserting
  synthetic leads.
- Send a signed leadgen webhook delivery and confirm Moosewave verifies
  `X-Hub-Signature-256`, fetches `/{leadgen_id}`, records a webhook sync run,
  and dedupes replay through `lead_webhook_events`.
- Disconnect a managed connection and confirm the Page `leadgen` subscription
  cleanup runs before the local integration is removed.
- Validate 4xx/429/5xx Graph errors surface in run history with truncated
  provider details and Retry-After where present.
- Confirm Meta-side token revocation and app uninstall cleanup during live
  certification.
