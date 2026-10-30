# Formsite Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Formsite lead-capture runtime for results REST pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Formsite result-puller slice; the connector remains partial until live Formsite accounts are certified for setup, pagination, rate-limit behavior, Professional-plan API access, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/formsite/connect/start`, `POST /api/v1/integrations/formsite/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/formsite/sync`, `POST /api/v1/integrations/formsite/backfill`, `POST /api/v1/integrations/formsite/pause`, `DELETE /api/v1/integrations/formsite`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## Access Token Setup

Use the form's `Settings -> Integrations -> Formsite API` page to capture the access token, API base URL, user directory, and form directory. Store the access token in a Moosewave credential reference. Formsite REST requests use:

```http
Authorization: bearer your_token_value
```

Formsite API base URLs are account/server specific, for example `https://fs1.formsite.com/api/v2`. Moosewave requires `settings.api_base_url` so pulls route to the correct Formsite shard.

Required settings:

- `provider`: `formsite`
- `settings.api_base_url`: Formsite API base URL from the API page.
- `settings.account_id`: Formsite `user_dir` value.
- `settings.form_id`: Formsite `form_dir` value.
- `settings.credentials_ref`: Moosewave secret reference containing the Formsite access token.

Optional settings:

- `settings.page_size`: results page size, capped to Formsite's documented maximum of 500.
- `settings.form_name`: optional display name when result payloads omit form metadata.
- `settings.after_date`, `settings.before_date`: optional result date filters.
- `settings.after_id`, `settings.before_id`: optional Formsite result ID filters.
- `settings.results_view`: optional Formsite Results View ID.
- `settings.email_item_id`, `settings.first_name_item_id`, `settings.last_name_item_id`, `settings.full_name_item_id`, `settings.phone_item_id`, `settings.company_item_id`: optional item IDs for identity mapping.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "formsite",
  "name": "Newsletter signup",
  "credentials_ref": "cred_formsite_token",
  "settings": {
    "api_base_url": "https://fs1.formsite.com/api/v2",
    "account_id": "example",
    "form_id": "form123",
    "credentials_ref": "cred_formsite_token",
    "page_size": 100,
    "email_item_id": "100",
    "first_name_item_id": "101",
    "last_name_item_id": "102",
    "default_tags": "newsletter,formsite",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw Formsite access tokens or webhook secrets. Moosewave strips unverified webhook secret references for Formsite until provider-managed webhook/server-post runtime is implemented.

## Sync Behavior

The Formsite REST backfiller reads:

- `GET /api/v2/{user_dir}/forms/{form_dir}/results`

Result pulls use `page`, `limit`, `sort_id=result_id`, `sort_direction=asc`, optional date/result-ID filters, and Formsite pagination headers: `Pagination-Limit`, `Pagination-Page-Current`, and `Pagination-Page-Last`. The runtime stores stable `formsite:` cursors and maps result IDs, dates, login metadata, payment metadata, raw provider payloads, and item values into canonical lead submissions. Email, name, phone, and company values are mapped through configured Formsite item IDs, with a fallback email heuristic for answer values containing `@`.

`/sync` and `/backfill` can be called with an empty body to pull the next Formsite page from saved cursor state. Manual and scheduled continuation share `formsite_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying page cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Formsite rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Formsite, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Formsite form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for access-token rotation, form access review, duplicate/manual webhook/server-post/export cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Formsite webhooks/server posts, Formsite-side access-token revocation, duplicate destination deletion, reconnect proof, Professional-plan access proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
