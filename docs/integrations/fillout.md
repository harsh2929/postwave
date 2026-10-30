# Fillout Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Fillout lead-capture runtime for submission backfill, provider webhook ingest, retry cursors, and disconnect cleanup evidence. The local runtime is complete for the implemented Fillout slice; the connector remains partial until US, EU, and self-hosted/proxied Fillout accounts are certified with live setup, pagination, webhook, reconnect, disconnect, and data-delete evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/fillout/connect/start`, `POST /api/v1/integrations/fillout/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/fillout/sync`, `POST /api/v1/integrations/fillout/backfill`, `POST /api/v1/integrations/fillout/pause`, `DELETE /api/v1/integrations/fillout`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Public webhook callback: `POST /api/public/lead-integrations/fillout/webhooks`

## API Key Setup

Generate a Fillout API key from Fillout Developer settings and store it in a Moosewave credential reference. Fillout REST requests use:

```http
Authorization: Bearer <fillout-api-key>
```

The default Fillout API base URL is `https://api.fillout.com/v1/api`. EU-hosted accounts use `https://eu-api.fillout.com/v1/api`, and self-hosted or proxied accounts should use the base URL shown in the Fillout API dashboard.

Required settings:

- `provider`: `fillout`
- `settings.form_id`: Fillout public form identifier.
- `settings.credentials_ref`: Moosewave secret reference containing the Fillout API key.

Optional settings:

- `settings.webhook_secret_ref`: Moosewave secret reference containing the token that Fillout sends back to Moosewave on webhooks.
- `settings.api_region`: `eu` for Fillout EU accounts.
- `settings.api_base_url`: explicit base URL override for self-hosted or proxied accounts.
- `settings.page_size`: submissions page size, capped to Fillout's documented maximum of 150.
- `settings.status`, `settings.afterDate`, `settings.beforeDate`, `settings.includePreview`, `settings.includeEditLink`, `settings.sort`, `settings.search`: filters passed to the submissions API.
- `settings.default_tags`, `settings.list_id`, `settings.workspace_id`, `settings.form_name`: Moosewave routing and labeling metadata.

Example:

```json
{
  "provider": "fillout",
  "name": "Newsletter signup",
  "credentials_ref": "cred_fillout_api_key",
  "settings": {
    "form_id": "form_123",
    "credentials_ref": "cred_fillout_api_key",
    "webhook_secret_ref": "cred_fillout_webhook_token",
    "page_size": 100,
    "default_tags": "newsletter,fillout",
    "list_id": "list_123"
  }
}
```

## Sync Behavior

The Fillout REST backfiller reads:

- `GET /forms/{form_id}` for form metadata.
- `GET /forms/{form_id}/submissions` for submissions.

Submission pulls use `limit` and `offset`, preserve `totalResponses` and `pageCount` evidence, and store stable `fillout:` cursors. The runtime maps submitted questions, calculations, URL parameters, scheduling fields, payments, quiz/login evidence, raw provider payloads, and extracted email/name/phone/company values into canonical lead submissions.

`/sync` and `/backfill` can be called with an empty body to pull the next Fillout page from saved cursor state. Manual and scheduled continuation share `fillout_retry:` cursors with attempt count, next-attempt time, status, and truncated error details. Empty manual requests skip provider calls while a retry cursor is not due, resume the embedded `fillout:` cursor when due, store `BACKFILL_FAILED` retry state on provider pull failures, and store `SYNC_FAILED` retry state when local lead/profile/event writes fully fail.

Disconnected Fillout rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Fillout, and stale run recording cannot revive the disconnected local row.

Fillout's documented rate limit is 5 requests per second per account/API key. Moosewave currently uses bounded REST requests and generic retry cursors; provider-specific header parsing should be added if live validation exposes actionable rate-limit headers.

## Webhook Behavior

When Fillout credentials and a webhook token are available, Moosewave registers a managed provider webhook with:

- `POST /webhook/create`
- body: `formId` and `url`

The provider URL includes the Moosewave-owned verification token, but Moosewave stores only the token-free endpoint plus the returned webhook ID and registration metadata in integration settings. If provider webhook creation succeeds but local integration persistence fails for a new row, Moosewave best-effort deletes the just-created Fillout webhook so it does not become an orphan callback target.

The public callback accepts direct submission JSON or submission envelopes. It resolves the integration by `form_id`, verifies the token from query string, header, or Bearer auth, maps the submission, and records webhook-mode run history.

Disconnect calls:

- `POST /webhook/delete`
- body: `webhookId`

Local disconnect stops if Moosewave-owned provider webhook cleanup fails. API-key revocation, duplicate webhook cleanup, and manual webhook cleanup may still require Fillout dashboard action until live certification is complete.

When managed cleanup runs, the disconnect response includes `provider_cleanup` evidence and the same object is persisted to `settings.provider_cleanup`. The evidence records the provider cleanup status, stored webhook ID and endpoint facts, local Moosewave stop effects, and remaining Fillout dashboard actions.

## Validation Checklist

- Create a Fillout API-key credential ref and webhook-token ref.
- Create a connection for a US-hosted Fillout form and verify metadata pull, submissions pull, webhook registration, webhook ingest, sync history, retry history, and disconnect cleanup.
- Repeat for an EU account with `api_region: "eu"` or an explicit EU base URL.
- Repeat for a self-hosted or proxied account using the dashboard-provided API base URL.
- Verify filters: `afterDate`, `beforeDate`, `status`, `includePreview`, `includeEditLink`, `sort`, and `search`.
- Verify page-size behavior at 1, 50, 100, and 150.
- Verify repeat setup does not create duplicate active webhooks, or add provider-side reconcile support if Fillout exposes a listing endpoint.
- Verify partial/in-progress submission policy before enabling `status: "in_progress"` by default.
- Verify data-delete behavior through the central privacy workflow and provider dashboard cleanup.

## Source Notes

- Fillout REST API overview: `https://www.fillout.com/help/fillout-rest-api`
- Fillout submissions API: `https://www.fillout.com/help/api-reference/get-all-submissions`
- Fillout form metadata API: `https://www.fillout.com/help/api-reference/get-form-metadata`
- Fillout webhook create API: `https://www.fillout.com/help/api-reference/create-a-webhook`
- Fillout webhook delete API: `https://www.fillout.com/help/api-reference/remove-a-webhook`
