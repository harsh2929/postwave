# Tally Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Tally lead-capture runtime for submissions REST pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Tally puller slice; the connector remains partial until live Tally workspaces are certified for setup, pagination, rate-limit behavior, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/tally/connect/start`, `POST /api/v1/integrations/tally/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/tally/sync`, `POST /api/v1/integrations/tally/backfill`, `POST /api/v1/integrations/tally/pause`, `DELETE /api/v1/integrations/tally`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## API Key Setup

Create or retrieve a Tally API key and store it in a Moosewave credential reference. Tally REST requests use:

```http
Authorization: Bearer <tally-api-key>
```

The default Tally API base URL is `https://api.tally.so`.

Required settings:

- `provider`: `tally`
- `settings.form_id`: Tally form identifier.
- `settings.credentials_ref`: Moosewave secret reference containing the Tally API key or Bearer token.

Optional settings:

- `settings.api_base_url`: explicit base URL override for private or proxied Tally API hosts.
- `settings.page_size`: submissions page size, capped to Tally's documented maximum of 500.
- `settings.form_name`: optional display name when submission payloads omit form metadata.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "tally",
  "name": "Newsletter signup",
  "credentials_ref": "cred_tally_api_key",
  "settings": {
    "form_id": "form_123",
    "credentials_ref": "cred_tally_api_key",
    "page_size": 100,
    "default_tags": "newsletter,tally",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw Tally API keys or webhook secrets. Moosewave strips unverified webhook secret references for Tally until provider-managed webhook runtime is implemented.

## Sync Behavior

The Tally REST backfiller reads:

- `GET /forms/{formId}/submissions`

Submission pulls use `page` and `limit`, preserve `hasMore` continuation state, and store stable `tally:` cursors. The runtime maps submission IDs, form IDs, respondent IDs, submitted timestamps, raw provider payloads, and Tally field values into canonical lead submissions. Email, name, phone, and company values are inferred from field type and label/key/title metadata.

`/sync` and `/backfill` can be called with an empty body to pull the next Tally page from saved cursor state. Manual and scheduled continuation share `tally_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying page cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Tally rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Tally, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Tally form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for API-token rotation, form access review, duplicate/manual webhook or export cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Tally webhook ownership, Tally-side token revocation, duplicate destination deletion, reconnect proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`

