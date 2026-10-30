# Jotform Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave's Jotform connector is a managed form-submission integration for lead capture. The local runtime is complete for the implemented Jotform slice: API-key based REST backfill, regional Jotform API hosts, managed form webhook registration, shared-token webhook verification, provider-side webhook cleanup on disconnect, retry cursors, facade lifecycle actions, and canonical profile/list/event mapping.

The connector remains partial until Standard, EU, HIPAA, and custom/proxied Jotform accounts are certified with live setup, pagination, webhook delivery, reconnect, disconnect, and data-delete evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/jotform/connect/start`, `POST /api/v1/integrations/jotform/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/jotform/sync`, `POST /api/v1/integrations/jotform/backfill`, `POST /api/v1/integrations/jotform/pause`, `DELETE /api/v1/integrations/jotform`
- Public webhook callback: `/api/public/lead-integrations/jotform/webhooks`
- Admin create/update: `/api/v1/lead-integrations`
- Manual sync: `/api/v1/lead-integrations/{id}/sync`
- Backfill: `/api/v1/lead-integrations/{id}/backfill`
- Pause: `/api/v1/lead-integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/lead-integrations/{id}`

## Jotform Setup

1. Create a Jotform API key with read access for forms/submissions and write access for webhooks.
2. Store the API key in the Moosewave secret vault.
3. Store a separate Moosewave-owned webhook token in the vault.
4. Create the integration with the Jotform `form_id`, `credentials_ref`, and `webhook_secret_ref`.
5. Moosewave registers the form webhook automatically by calling the Jotform form-webhooks API with a callback URL that includes the webhook token.
6. Moosewave stores only the safe callback endpoint without the token, plus the provider webhook ID, registration time, and create/reuse metadata.

Example credential secret:

```json
{
  "api_key": "JOTFORM_API_KEY",
  "api_base_url": "https://api.jotform.com"
}
```

Example webhook secret:

```json
{
  "webhook_secret": "POSTWAVE_GENERATED_RANDOM_TOKEN"
}
```

Example integration payload:

```json
{
  "provider": "jotform",
  "name": "Newsletter signup",
  "status": "connected",
  "credentials_ref": "vault://integrations/jotform/newsletter",
  "settings": {
    "form_id": "JOTFORM_FORM_ID",
    "credentials_ref": "vault://integrations/jotform/newsletter",
    "webhook_secret_ref": "vault://integrations/jotform/newsletter-webhook",
    "api_region": "standard",
    "default_tags": "newsletter,jotform"
  }
}
```

## Regional API Hosts

- Standard: `https://api.jotform.com`
- EU: `https://eu-api.jotform.com`
- HIPAA: `https://hipaa-api.jotform.com`

Set `api_region` to `standard`, `eu`, or `hipaa`, or use `api_base_url` for Enterprise/custom-host deployments.

## Sync Behavior

The Jotform REST backfiller reads:

- `GET /form/{form_id}` for form metadata.
- `GET /form/{form_id}/questions` for question metadata.
- `GET /form/{form_id}/submissions` for submissions.

Requests use the `APIKEY` header and `offset`/`limit` pagination. Empty `/sync` and `/backfill` calls pull the next page from saved cursor state and store stable `jotform:` cursors. The runtime maps submitted answers by question ID, answer name, and question text into canonical lead submissions with extracted email/name/phone/company fields.

Manual and scheduled continuation share `jotform_retry:` cursors with attempt count, next-attempt time, status, and truncated error details. Empty manual `/sync` and `/backfill` requests skip provider calls while a retry cursor is not due, resume the embedded `jotform:` cursor when due, store `BACKFILL_FAILED` retry state on provider pull failures, and store `SYNC_FAILED` retry state when local lead/profile/event writes fully fail. Jotform's public limits are plan based, so live validation must confirm practical rate behavior for Standard, EU, HIPAA, and Enterprise/custom-host accounts.

Disconnected Jotform rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Jotform, and stale run recording cannot revive the disconnected local row.

## Webhook Behavior

Moosewave manages form webhooks under `/form/{formID}/webhooks`. Setup lists existing hooks, reuses a hook whose safe callback endpoint matches Moosewave's token-free endpoint, or creates a missing hook with form-encoded `webhookURL`. If creation succeeds but local integration persistence fails for a new row, Moosewave best-effort deletes the just-created Jotform hook; reused provider hooks are preserved. Disconnect deletes the stored provider webhook ID at `/form/{formID}/webhooks/{webhookID}` and treats provider 404 responses as already cleaned up.

When managed cleanup runs, the disconnect response includes `provider_cleanup` evidence and the same object is persisted to `settings.provider_cleanup`. The evidence records the deleted or already-absent webhook status, stored webhook ID and endpoint facts, local Moosewave stop effects, and remaining Jotform dashboard actions.

Jotform does not expose a first-party signing scheme for these webhook deliveries. Moosewave verifies a Moosewave-owned token from query string, `X-Postwave-Webhook-Secret`, `X-Jotform-Webhook-Secret`, or Bearer auth, and accepts JSON, form-url-encoded, and multipart payload encodings.

## Validation Checklist

- Create the integration and confirm Moosewave registers or reuses exactly one provider webhook.
- Confirm `jotform_webhook_endpoint` does not contain the secret token.
- Run an empty backfill request and confirm form metadata, questions, and submissions import correctly.
- Submit the form and confirm the webhook creates one lead event/profile with expected answer fields.
- Replay the same provider payload and confirm downstream idempotency behavior for duplicate submissions.
- Disconnect the integration and confirm the provider webhook is deleted; a 404 should be treated as already cleaned up.
- Repeat create, sync, webhook delivery, and disconnect against Standard, EU, and HIPAA API hosts.

## Source Notes

Jotform's API docs list Standard, EU, and HIPAA API hosts and support API-key authentication through the `APIKEY` header or query string. Jotform's form webhook API lists, creates, and deletes form webhooks under `/form/{formID}/webhooks`; create uses a form-encoded `webhookURL` value, and delete targets `/form/{formID}/webhooks/{webhookID}`. Jotform webhooks do not provide a first-party signing scheme, so Moosewave uses a Moosewave-owned URL/header/Bearer token and stores that token in the secret vault.
