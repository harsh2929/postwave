# Paperform Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Paperform lead-capture runtime for submissions REST pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Paperform puller slice; the connector remains partial until live Paperform accounts are certified for setup, pagination, rate-limit behavior, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/paperform/connect/start`, `POST /api/v1/integrations/paperform/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/paperform/sync`, `POST /api/v1/integrations/paperform/backfill`, `POST /api/v1/integrations/paperform/pause`, `DELETE /api/v1/integrations/paperform`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## API Key Setup

Create or retrieve a Paperform API key and store it in a Moosewave credential reference. Paperform REST requests use:

```http
Authorization: Bearer <paperform-api-key>
```

The default Paperform API base URL is `https://api.paperform.co/v1`.

Required settings:

- `provider`: `paperform`
- `settings.form_id`: Paperform form slug, custom slug, or ID.
- `settings.credentials_ref`: Moosewave secret reference containing the Paperform API key or Bearer token.

Optional settings:

- `settings.api_base_url`: explicit base URL override for private or proxied Paperform API hosts.
- `settings.page_size`: submissions page size, capped to Paperform's documented maximum of 100.
- `settings.form_name`: optional display name when submission payloads omit form metadata.
- `settings.after_date`, `settings.before_date`: optional UTC date filters for submission windows.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "paperform",
  "name": "Newsletter signup",
  "credentials_ref": "cred_paperform_api_key",
  "settings": {
    "form_id": "newsletter-signup",
    "credentials_ref": "cred_paperform_api_key",
    "page_size": 100,
    "default_tags": "newsletter,paperform",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw Paperform API keys or webhook secrets. Moosewave strips unverified webhook secret references for Paperform until provider-managed webhook runtime is implemented.

## Sync Behavior

The Paperform REST backfiller reads:

- `GET /forms/{slug_or_id}/submissions`

Submission pulls use `skip`, `limit`, and `sort=ASC`, preserve `has_more` continuation state, and store stable `paperform:` cursors. The runtime maps submission IDs, form IDs, created timestamps, device/charge/PDF evidence, raw provider payloads, and Paperform `data` answers into canonical lead submissions. Email, name, phone, and company values are inferred from answer keys and structured answer values.

`/sync` and `/backfill` can be called with an empty body to pull the next Paperform page from saved cursor state. Manual and scheduled continuation share `paperform_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying skip cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Paperform rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Paperform, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Paperform form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for API-key rotation, form access review, duplicate/manual webhook or export cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Paperform webhook ownership, Paperform-side API-key revocation, duplicate destination deletion, reconnect proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
