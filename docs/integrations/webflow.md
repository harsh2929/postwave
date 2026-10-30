# Webflow Native Integration

Catalog status: `Native / partial`.

Moosewave's Webflow connector is a managed Webflow Data API integration for form submissions. It supports bearer access-token/API-token credential references, drift-aware provider-side form-submission webhook reconciliation, signed webhook ingest with durable delivery idempotency, REST backfill, scheduled retry-aware backfills, and provider-side webhook cleanup on disconnect.

The connector remains partial until real Webflow sites are certified for OAuth/token setup, site-level and form-scoped pulls, `elementId` filtering, webhook signature verification, reconnect, disconnect, and data-delete behavior.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/webflow/connect/start`, `POST /api/v1/integrations/webflow/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/webflow/sync`, `POST /api/v1/integrations/webflow/backfill`, `POST /api/v1/integrations/webflow/pause`, `DELETE /api/v1/integrations/webflow`
- Public webhook callback: `/api/public/lead-integrations/webflow/webhooks`
- Admin create/update: `/api/v1/lead-integrations`
- Manual sync: `/api/v1/lead-integrations/{id}/sync`
- Backfill: `/api/v1/lead-integrations/{id}/backfill`
- Pause: `/api/v1/lead-integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/lead-integrations/{id}`

## Webflow App Setup

1. Create or configure a Webflow app or token with `forms:read`, `sites:read`, and `sites:write`.
2. Store the Webflow access token and webhook signing secret in Moosewave's secret vault.
3. Create the Moosewave integration through `/api/v1/lead-integrations` with `site_id`, `credentials_ref`, and `webhook_secret_ref`.
4. Optionally set `form_name`; Moosewave uses it as the Webflow `form_submission` webhook filter.
5. Optionally set `form_id` or `form_element_id` to constrain REST backfills and webhook ingest to one form.

Example credential secret:

```json
{
  "access_token": "WEBFLOW_OAUTH_ACCESS_TOKEN",
  "webhook_secret": "WEBFLOW_OAUTH_CLIENT_SECRET"
}
```

Example integration payload:

```json
{
  "provider": "webflow",
  "name": "Webflow newsletter",
  "status": "connected",
  "credentials_ref": "vault://integrations/webflow/site",
  "settings": {
    "site_id": "WEBFLOW_SITE_ID",
    "credentials_ref": "vault://integrations/webflow/site",
    "webhook_secret_ref": "vault://integrations/webflow/site",
    "form_name": "Newsletter",
    "default_tags": "webflow,newsletter"
  }
}
```

## Sync Behavior

The Webflow Data API backfiller reads:

- `GET /v2/sites/{site_id}/form_submissions` for site-level submissions.
- `GET /v2/sites/{site_id}/forms/{form_id}/submissions` for form-scoped submissions.

Requests use Bearer auth and require `forms:read`. `form_element_id` is sent as `elementId` on site-level pulls, and `limit`/`offset` pagination is capped to Webflow's documented maximum of 100. Empty `/sync` and `/backfill` calls pull the next page from saved cursor state and store stable `webflow:` cursors.

The runtime maps Webflow `formResponse` or `data` fields into canonical lead submissions with extracted email/name/phone/company values, form display name, workspace/site/form metadata, schema evidence, provider raw evidence, default tags, and list routing.

New Webflow connections participate in the opt-out connect-time history drain when a provider backfiller is configured, so recent form submissions import immediately before the scheduled worker takes over.

Manual and scheduled continuation share `webflow_retry:` cursors with attempt count, next-attempt time, status, and truncated error details. Empty manual `/sync` and `/backfill` requests skip provider calls while a retry cursor is not due, resume the embedded `webflow:` cursor when due, preserve prior attempt history if the due retry fails again, store `BACKFILL_FAILED` retry state on provider pull failures, and store `SYNC_FAILED` retry state when local lead/profile/event writes fully fail. Webflow documents `429 Too Many Requests` responses on the relevant Data API endpoints; Moosewave now honors `Retry-After` when it is present and otherwise falls back to bounded exponential retry timing.

Disconnected Webflow rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Webflow, and stale run recording cannot revive the disconnected local row.

## Managed Webhook Lifecycle

On create/update, Moosewave validates the stored Webflow webhook ID with `GET /v2/webhooks/{webhook_id}` and reuses it only if the site, callback URL, trigger, and filter still match. If the stored ID is missing or drifted, Moosewave lists site webhooks, reuses an exact `form_submission` match, or creates one through the Webflow Data API. Moosewave stores only provider metadata such as webhook ID, endpoint, trigger type, filter, created/reused flags, reconciliation timestamp, repair reason, and previous webhook ID; raw signing secrets remain in secret references. If a newly created webhook cannot be persisted locally for a new row, Moosewave best-effort deletes that new webhook while preserving reused exact matches.

On disconnect, Moosewave deletes the stored Webflow webhook ID and treats a provider 404 as already absent only after the fallback site-webhook lookup confirms no exact Moosewave callback/filter match remains. If managed metadata exists but the stored ID is missing or stale, Moosewave lists site webhooks and deletes the exact Moosewave callback/filter match. If the stored ID is absent but the fallback lookup fails, Moosewave marks provider cleanup as skipped with `fallback_lookup_failed` evidence instead of claiming the webhook was deleted.

When managed cleanup runs, the disconnect response includes `provider_cleanup` evidence and the same object is persisted to `settings.provider_cleanup`. The evidence records the deleted or already-absent webhook status, previous webhook ID when a repair path was involved, endpoint/filter facts, local stop effects, and Webflow dashboard actions that remain operator-managed.

The webhook callback resolves the integration by `payload.siteId` plus optional form/form-element filters, verifies `x-webflow-timestamp` and `x-webflow-signature` with HMAC-SHA256 using the configured site token secret or OAuth client secret, enforces timestamp freshness, claims the form-scoped delivery in `lead_webhook_events`, accepts JSON `form_submission` payloads, records webhook-mode sync history, returns `200 OK` for successful and already-processed deliveries, and returns `503` with `Retry-After` while the same delivery is already in progress. If Webflow omits `payload.id`, Moosewave hashes stable site/form/submitted-at/form-response evidence before falling back to a raw-body hash, so harmless delivery metadata changes do not duplicate the same logical submission.

## Validation Checklist

- Create the integration and confirm Moosewave stores `webflow_webhook_id`, endpoint, trigger type, `webflow_webhook_reconciled_at`, and managed metadata.
- Reconnect with a stale stored webhook ID and confirm Moosewave records `webflow_webhook_repaired`, `webflow_webhook_repair_reason`, and `webflow_webhook_previous_id`.
- Submit a Webflow form and confirm the signed webhook creates exactly one lead event.
- Replay the same webhook and confirm durable idempotency prevents duplicate ingest.
- Run an empty backfill and confirm site-level or form-scoped submissions import with stable cursors.
- Disconnect the integration and confirm the Webflow webhook is deleted provider-side, already-absent only when fallback lookup succeeds, or marked skipped when the fallback lookup cannot prove endpoint/filter cleanup.
- Rotate the OAuth client secret/signing secret reference and repeat webhook verification.

## Source Notes

Webflow's Data API exposes form submission listing under `/v2/sites/{site_id}/form_submissions` and `/v2/sites/{site_id}/forms/{form_id}/submissions`. Webhook management lists site webhooks at `/v2/sites/{site_id}/webhooks`, creates site webhooks with `triggerType: "form_submission"` and `url`, and reads/deletes a webhook at `/v2/webhooks/{webhook_id}`. OAuth-created Webflow webhooks include `x-webflow-timestamp` and `x-webflow-signature`; Moosewave verifies the signature with HMAC-SHA256 and enforces timestamp freshness.
