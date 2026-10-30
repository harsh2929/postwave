# Leadpages Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Leadpages lead-capture runtime for form submission REST pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Leadpages form-submissions puller slice; the connector remains partial until live Leadpages accounts are certified for response schema, pagination behavior, rate limits, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/leadpages/connect/start`, `POST /api/v1/integrations/leadpages/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/leadpages/sync`, `POST /api/v1/integrations/leadpages/backfill`, `POST /api/v1/integrations/leadpages/pause`, `DELETE /api/v1/integrations/leadpages`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## API Key Setup

Leadpages API keys or OAuth access tokens are sent as Bearer tokens:

```http
Authorization: Bearer your_token_value
```

Store the token in a Moosewave credential reference. Moosewave accepts secret payload keys named `access_token`, `api_key`, `token`, or `bearer_token`, plus optional `api_base_url` and `user_agent` overrides.

Required settings:

- `provider`: `leadpages`
- `settings.form_id`: Leadpages form ID used for `GET /api/forms/{form_id}/submissions`.
- `settings.credentials_ref`: Moosewave secret reference containing a Leadpages API key or OAuth access token.

Optional settings:

- `settings.account_id`: optional Leadpages account identifier for operator context.
- `settings.page_id`: optional Leadpages landing-page identifier stored on imported leads.
- `settings.form_name`: optional display name.
- `settings.page_size`: local request limit, capped at 250 until live Leadpages limits are certified.
- `settings.api_base_url`: API base URL; defaults to `https://api.leadpages.net`.
- `settings.from`, `settings.to`: optional timestamp filters passed through when supported.
- `settings.email_field_key`, `settings.first_name_field_key`, `settings.last_name_field_key`, `settings.full_name_field_key`, `settings.phone_field_key`, `settings.company_field_key`: optional field-key identity mapping hints.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "leadpages",
  "name": "Launch page form",
  "credentials_ref": "cred_leadpages_api_key",
  "settings": {
    "form_id": "form_123",
    "page_id": "page_456",
    "credentials_ref": "cred_leadpages_api_key",
    "page_size": 100,
    "email_field_key": "email",
    "full_name_field_key": "name",
    "default_tags": "launch,leadpages",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw Leadpages API keys, OAuth access tokens, or webhook secrets. Moosewave strips unverified webhook secret references for Leadpages because this runtime does not claim managed provider webhooks.

## Sync Behavior

An empty `/sync` or `/backfill` request triggers:

1. `GET /api/forms/{form_id}/submissions`
2. Flexible response decoding for common submission arrays under `submissions`, `leads`, `items`, `results`, or `data`.
3. Provider cursor, next-link, or page-hint continuation when those hints are returned.
4. A local submitted-at/ID watermark cursor so repeated pulls can skip already imported rows.

The cursor is stored as `leadpages:` and records provider cursor/next URL/page hints plus `last_submitted_at` and `last_id`. Manual and scheduled continuation share `leadpages_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Leadpages rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Leadpages, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Leadpages form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for API-key/OAuth token rotation, page/form access review, duplicate/manual dashboard webhook, export, or integration cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Leadpages webhook setup/cleanup, token revocation automation, provider-side duplicate destination deletion, response-schema certification, pagination certification, reconnect proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

```bash
cd apps/api
go test -count=1 ./internal/lead_integrations ./internal/integrations
go test -count=1 .
```
