# Feathery Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Feathery lead-capture runtime for Submissions API pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Feathery submissions puller slice; the connector remains partial until live Feathery workspaces are certified for API-key setup, pagination, timestamp filters, reconnect, disconnect, data-delete, provider-console cleanup evidence, and any provider-managed webhook coverage.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/feathery/connect/start`, `POST /api/v1/integrations/feathery/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/feathery/sync`, `POST /api/v1/integrations/feathery/backfill`, `POST /api/v1/integrations/feathery/pause`, `DELETE /api/v1/integrations/feathery`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## API Key Setup

Store the Feathery API key in a Moosewave credential reference. Feathery REST requests use:

```http
Authorization: Token your_api_key
```

The default API base URL is `https://api.feathery.io`. If a workspace uses a regional Feathery API host, set `settings.api_base_url`.

Required settings:

- `provider`: `feathery`
- `settings.form_id`: Feathery form identifier for the Submissions API `form_id` parameter.
- `settings.credentials_ref`: Moosewave secret reference containing the Feathery API key.

Optional settings:

- `settings.workspace_id`: workspace identifier for operator evidence.
- `settings.environment`: production, sandbox, or another operator label.
- `settings.api_base_url`: optional regional Feathery API base URL.
- `settings.page_size`: submissions page size, capped to Feathery's documented maximum of 1000.
- `settings.form_name`: optional display name for imported submissions.
- `settings.start_time`, `settings.end_time`: optional update-time filters.
- `settings.created_after`, `settings.created_before`: optional creation-time filters.
- `settings.completed`: optional completed-state filter.
- `settings.fields`, `settings.sort`: optional Feathery query controls.
- `settings.email_field_id`, `settings.first_name_field_id`, `settings.last_name_field_id`, `settings.full_name_field_id`, `settings.phone_field_id`, `settings.company_field_id`: optional field IDs for identity mapping.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "feathery",
  "name": "Newsletter signup",
  "credentials_ref": "cred_feathery_api_key",
  "settings": {
    "form_id": "form_456",
    "credentials_ref": "cred_feathery_api_key",
    "page_size": 500,
    "start_time": "2026-06-01T00:00:00Z",
    "email_field_id": "email",
    "first_name_field_id": "first_name",
    "last_name_field_id": "last_name",
    "default_tags": "newsletter,feathery",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw Feathery API keys or webhook secrets. Moosewave strips unverified webhook secret references for Feathery until provider-managed webhook ownership is implemented and certified.

## Sync Behavior

The Feathery REST backfiller reads:

- `GET /api/form/submission/?form_id={form_id}`

Submission pulls use `page_size`, Feathery's `next` URL continuation, optional update-time and created-time filters, optional completed filters, and field-value mapping into canonical lead submissions. The runtime stores stable `feathery:` cursors with either a next URL or a timestamp watermark and maps user IDs, submission timestamps, raw provider payloads, field IDs, field display labels, hidden flags, and internal IDs into canonical lead submissions.

`/sync` and `/backfill` can be called with an empty body to pull the next Feathery page from saved cursor state. Manual and scheduled continuation share `feathery_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying next-URL/timestamp cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Feathery rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Feathery, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Feathery form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for API-key rotation, workspace/form access review, duplicate/manual webhook or export cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Feathery webhooks, Feathery-side API-key revocation, duplicate destination deletion, reconnect proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
