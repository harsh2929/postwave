# Formstack Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Formstack lead-capture runtime for submissions REST pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Formstack puller slice; the connector remains partial until live Formstack accounts are certified for setup, pagination, rate-limit behavior, encrypted-form behavior, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/formstack/connect/start`, `POST /api/v1/integrations/formstack/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/formstack/sync`, `POST /api/v1/integrations/formstack/backfill`, `POST /api/v1/integrations/formstack/pause`, `DELETE /api/v1/integrations/formstack`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## Personal Access Token Setup

Create or retrieve a Formstack Personal Access Token and store it in a Moosewave credential reference. Formstack REST requests use:

```http
Authorization: Bearer fs_pat_<token>
```

The default Formstack API base URL is `https://www.formstack.com/api/v2025`.

Required settings:

- `provider`: `formstack`
- `settings.form_id`: Formstack form identifier.
- `settings.credentials_ref`: Moosewave secret reference containing the Formstack Personal Access Token or Bearer token.

Optional settings:

- `settings.api_base_url`: explicit base URL override for private or proxied Formstack API hosts.
- `settings.page_size`: submissions page size, capped to 100 for this runtime.
- `settings.form_name`: optional display name when submission payloads omit form metadata.
- `settings.minTime`, `settings.maxTime`: optional Formstack Eastern-time submission window filters.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "formstack",
  "name": "Newsletter signup",
  "credentials_ref": "cred_formstack_pat",
  "settings": {
    "form_id": "123",
    "credentials_ref": "cred_formstack_pat",
    "page_size": 100,
    "default_tags": "newsletter,formstack",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw Formstack PATs or webhook secrets. Moosewave strips unverified webhook secret references for Formstack until provider-managed webhook runtime is implemented.

## Sync Behavior

The Formstack REST backfiller reads:

- `GET /api/v2025/forms/{formId}/submissions`

Submission pulls use `pageNumber`, `pageSize`, `order=ASC`, `data=true`, `expandData=true`, and `dataFormat=legacy`, preserve `page.totalPages` continuation state, and store stable `formstack:` cursors. The runtime maps submission IDs, form IDs, timestamps, pretty names, raw provider payloads, and expanded Formstack field data into canonical lead submissions. Email, name, phone, and company values are inferred from field type, internal label, and display label metadata.

`/sync` and `/backfill` can be called with an empty body to pull the next Formstack page from saved cursor state. Manual and scheduled continuation share `formstack_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying page cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Formstack rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Formstack, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Formstack form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for PAT rotation, form access review, duplicate/manual webhook or export cleanup, encrypted-form password cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Formstack webhook ownership, Formstack-side PAT revocation, duplicate destination deletion, reconnect proof, encrypted-form password certification, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
