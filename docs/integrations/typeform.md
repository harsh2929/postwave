# Typeform Native Integration

Catalog status: `Native / partial`.

Moosewave's Typeform connector is a managed lead-capture integration for form responses. It supports personal-token or externally managed OAuth access-token credential references, Retrieve Form routing, Responses API backfill, managed webhook tag upsert/read-back verification/delete, Typeform-Signature verification, durable webhook delivery idempotency, scheduled retry-aware backfills, and canonical profile/list/event mapping.

The connector remains partial until real Typeform US and EU forms are certified for token setup, response-link routing, response pagination, partial/completed response policy, webhook delivery, reconnect, disconnect, and data-delete behavior.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect actions: `POST /api/v1/integrations/typeform/connect/start`, `POST /api/v1/integrations/typeform/connect/callback` delegate to the Lead integrations surface; Typeform provider OAuth callback handling is not implemented locally.
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/typeform/sync`, `POST /api/v1/integrations/typeform/backfill`, `POST /api/v1/integrations/typeform/pause`, `DELETE /api/v1/integrations/typeform`
- Public webhook callback: `POST /api/public/lead-integrations/typeform/webhooks`
- Admin create/update: `POST /api/v1/lead-integrations`
- Manual sync: `POST /api/v1/lead-integrations/{id}/sync`
- Backfill: `POST /api/v1/lead-integrations/{id}/backfill`
- Pause: `POST /api/v1/lead-integrations/{id}/pause`
- Disconnect: `DELETE /api/v1/lead-integrations/{id}`

## Typeform Setup

1. Create a Typeform personal access token or an externally managed OAuth access token with `forms:read`, `responses:read`, `webhooks:read`, and `webhooks:write`.
2. Store the token in a Moosewave credential reference.
3. Store a separate Typeform webhook signing secret in a Moosewave secret reference.
4. Create the integration with `form_id`, `credentials_ref`, and `webhook_secret_ref`.
5. Optionally set `webhook_tag`; Moosewave defaults it when absent and uses it to upsert a Moosewave-owned provider webhook.
6. Optionally set `api_region`, `responses_api_region`, `response_type`, `page_size`, `verify_ssl`, `include_partial_responses`, `default_tags`, and `list_id`.

Example integration payload:

```json
{
  "provider": "typeform",
  "name": "Typeform newsletter",
  "status": "connected",
  "credentials_ref": "vault://integrations/typeform/newsletter",
  "settings": {
    "form_id": "abc123",
    "credentials_ref": "vault://integrations/typeform/newsletter",
    "webhook_secret_ref": "vault://integrations/typeform/newsletter-webhook",
    "webhook_tag": "postwave-prod",
    "response_type": "completed",
    "page_size": 100,
    "default_tags": "typeform,newsletter"
  }
}
```

## Sync Behavior

The Typeform backfiller reads:

- `GET /forms/{form_id}` for form metadata and response-link routing.
- `GET /forms/{form_id}/responses` for responses.

Requests use Bearer auth. `page_size` is capped to Typeform's documented maximum of 1000. The runtime supports `response_type`, response API region overrides, and `after` cursor traversal. Empty `/sync` and `/backfill` calls pull the next page from saved cursor state and store stable `typeform:` cursors.

The runtime maps answer fields by ref, id, and title; hidden fields; metadata; variables; calculated values; provider raw evidence; submitted timestamps; and extracted email/name/phone/company values into canonical lead submissions.

Manual and scheduled continuation share `typeform_retry:` cursors with attempt count, next-attempt time, status, and truncated error details. Empty manual `/sync` and `/backfill` requests skip provider calls while a retry cursor is not due, resume the embedded `typeform:` cursor when due, preserve prior attempt history if the due retry fails again, and store `BACKFILL_FAILED` retry state on provider pull failures. Typeform 429 handling honors Retry-After when present. If a provider page is fetched but local lead/profile/event writes fully fail, the manual run records `SYNC_FAILED` retry state for the pre-fetch cursor instead of advancing past the page.

Disconnected Typeform rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Typeform, and stale run recording cannot revive the disconnected local row.

## Managed Webhook Lifecycle

On create/update, Moosewave upserts a Typeform webhook with:

- `PUT /forms/{form_id}/webhooks/{tag}`
- `enabled: true`
- `url`
- `secret`
- `verify_ssl`
- `event_types`

After the upsert, Moosewave retrieves the same managed tag with `GET /forms/{form_id}/webhooks/{tag}` and fails setup if the provider read-back metadata does not match the expected tag, form, URL, or enabled event types. Successful setup persists `typeform_webhook_verified=true` plus `typeform_webhook_verified_at` alongside the returned webhook ID, tag, endpoint, event types, and registration timestamp.

If managed webhook registration succeeds but the local integration row cannot be persisted for a new connection, Moosewave best-effort deletes the just-registered managed tag so a provider-side webhook is not orphaned before normal disconnect cleanup can see it.

When `include_partial_responses` is enabled, Moosewave subscribes to `form_response_partial` as well as `form_response`. The public callback reads the raw body, resolves the integration by `form_response.form_id`, verifies `Typeform-Signature` with HMAC-SHA256 over the exact payload and the configured webhook secret, claims the form-scoped delivery in `lead_webhook_events`, maps the response, records webhook-mode sync history, returns `200 OK` for already-processed replays, and returns `503` with `Retry-After` while the same delivery is already in progress. If Typeform omits `event_id` on a completed `form_response`, Moosewave derives the replay claim from stable form/response identity before falling back to a full-body hash for ambiguous payloads.

Disconnect deletes the stored Moosewave-owned webhook tag with:

- `DELETE /forms/{form_id}/webhooks/{tag}`

Provider 404 responses are treated as already cleaned up. Personal/OAuth token revocation and duplicate/manual webhook cleanup may still require Typeform dashboard action until live certification is complete.

When Moosewave runs managed webhook cleanup during disconnect, the API response includes `provider_cleanup` evidence and the same object is persisted to `settings.provider_cleanup`. The evidence records the provider cleanup status, webhook tag/ID or endpoint facts when available, local Moosewave stop effects, and dashboard actions that remain outside Moosewave automation.

## Validation Checklist

- Create a US Typeform integration and confirm webhook upsert plus read-back verification metadata, response pull, signed webhook ingest, retry history, and disconnect cleanup.
- Simulate local persistence failure after managed webhook registration and confirm the just-registered Typeform tag is rolled back.
- Repeat against a Typeform form whose responses route through the EU response data center.
- Validate `_links.responses` routing from Retrieve Form when present.
- Validate `response_type=completed`, `response_type=partial,completed`, and `include_partial_responses`.
- Validate `page_size` at 25, 100, and 1000.
- Validate `after` cursor pagination, manual/scheduled `typeform_retry:` resume/not-due behavior, attempt preservation when a due retry fails again, `SYNC_FAILED` retry handling, and Retry-After handling on simulated or live 429 responses.
- Replay webhook payloads with and without `event_id` and confirm idempotency/dedupe behavior.
- Verify privacy/data-delete behavior through the central privacy workflow and provider dashboard cleanup.

## Source Notes

- Typeform Retrieve Form: `https://www.typeform.com/developers/create/reference/retrieve-form/`
- Typeform Retrieve Responses: `https://www.typeform.com/developers/responses/reference/retrieve-responses/`
- Typeform Create or Update Webhook: `https://www.typeform.com/developers/webhooks/reference/create-or-update-webhook/`
- Typeform Retrieve Webhook: `https://www.typeform.com/developers/webhooks/reference/retrieve-single-webhook/`
- Typeform Secure Webhooks: `https://www.typeform.com/developers/webhooks/secure-your-webhooks/`
- Typeform Webhooks walkthroughs: `https://www.typeform.com/developers/webhooks/walkthroughs/`
