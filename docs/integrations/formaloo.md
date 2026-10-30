# Formaloo Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Formaloo lead-capture runtime for Rows API pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented rows puller slice; the connector remains partial until live Formaloo workspaces are certified for token exchange, pagination/incremental semantics, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/formaloo/connect/start`, `POST /api/v1/integrations/formaloo/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/formaloo/sync`, `POST /api/v1/integrations/formaloo/backfill`, `POST /api/v1/integrations/formaloo/pause`, `DELETE /api/v1/integrations/formaloo`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## Credential Setup

Formaloo API v3 uses an `x-api-key` header plus a JWT authorization token. Moosewave can exchange the referenced API secret at `POST /v3.0/oauth2/authorization-token/`, or use a preissued authorization token from the credential reference.

Store credentials in a Moosewave credential reference. Secret payloads may contain:

- `api_key` or `x_api_key`.
- `api_secret` or `secret` for token exchange.
- `authorization_token`, `access_token`, `jwt`, or `token` for an already issued token.
- Optional `api_base_url`, `workspace_id`, and `user_agent` overrides.

Required settings:

- `provider`: `formaloo`
- `settings.form_id`: Formaloo form slug or identifier used for `GET /v3.0/forms/{slug}/rows/`.
- `settings.credentials_ref`: Moosewave secret reference containing `x-api-key` plus API secret or authorization token material.

Optional settings:

- `settings.form_slug`: explicit Formaloo form slug; overrides `form_id` at runtime.
- `settings.workspace_id`: optional `x-workspace` header.
- `settings.api_base_url`: API base URL; defaults to `https://api.formaloo.me`.
- `settings.form_name`: optional display name.
- `settings.page_size`: `page_size`, capped at 1000 for this runtime.
- `settings.created_at_gte`, `settings.updated_at_gte`, `settings.submit_time_gte`: optional lower-bound filters.
- `settings.submit_number`, `settings.tracking_code`, `settings.tags`, `settings.search`: optional row filters.
- `settings.email_field_key`, `settings.first_name_field_key`, `settings.last_name_field_key`, `settings.full_name_field_key`, `settings.phone_field_key`, `settings.company_field_key`: optional row-data identity mapping hints.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "formaloo",
  "name": "Website contact form",
  "credentials_ref": "cred_formaloo",
  "settings": {
    "form_id": "contact-us",
    "credentials_ref": "cred_formaloo",
    "workspace_id": "workspace_123",
    "page_size": 100,
    "email_field_key": "Email",
    "full_name_field_key": "Name",
    "default_tags": "website,formaloo",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw API keys, API secrets, authorization tokens, or webhook secrets. Moosewave strips unverified webhook secret references for Formaloo because this runtime does not claim managed provider webhooks.

## Sync Behavior

An empty `/sync` or `/backfill` request triggers:

1. `POST /v3.0/oauth2/authorization-token/` when an authorization token is not already present in the credential secret.
2. `GET /v3.0/forms/{slug}/rows/` with `x-api-key`, `Authorization: JWT ...`, optional `x-workspace`, `page`, `page_size`, and configured filters.
3. Response decoding from `results`, `data`, `items`, or `rows`, including `next`, `current_page`, `page_count`, and total count evidence when returned.
4. Row `data`, `readable_data`, `rendered_data`, and `extra_response` mapping into canonical identity fields, profile attributes, list adds, and `lead.submitted` events.

The cursor is stored as `formaloo:` and records the form slug, page or next URL, row slug/date watermarks, and high-water marks while a multi-page scan is in flight. Manual and scheduled continuation share `formaloo_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Formaloo rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Formaloo, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Formaloo form/workspace scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for API-key/API-secret/token rotation, workspace/form access review, duplicate/manual webhook, export, or integration cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Formaloo webhook setup/cleanup, API-key/API-secret/token revocation automation, provider-side duplicate destination deletion, reconnect proof, data-delete proof, or live incremental-semantics certification. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

References:

- Formaloo API key docs: `https://help.formaloo.com/en/articles/8143469-how-to-use-formaloo-api-keys-in-formaloo-api`
- Formaloo OpenAPI schema: `https://docs.formaloo.com/openapi-v3.0.yaml`
- Formaloo docs home: `https://docs.formaloo.com/`

## Verification

```bash
cd apps/api
go test -count=1 ./internal/lead_integrations ./internal/integrations
go test -count=1 .
```
