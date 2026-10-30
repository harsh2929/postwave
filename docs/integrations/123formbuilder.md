# 123FormBuilder Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed 123FormBuilder lead-capture runtime for REST API v2 submission pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented submissions puller slice; the connector remains partial until live 123FormBuilder accounts are certified for US/EU access, token exchange, pagination/incremental semantics, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/123formbuilder/connect/start`, `POST /api/v1/integrations/123formbuilder/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/123formbuilder/sync`, `POST /api/v1/integrations/123formbuilder/backfill`, `POST /api/v1/integrations/123formbuilder/pause`, `DELETE /api/v1/integrations/123formbuilder`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## Credential Setup

123FormBuilder REST API v2 authenticates by exchanging credentials at `POST /token` and sending the returned JWT as the `JWT` query parameter on subsequent requests. Moosewave also accepts a preissued JWT in the referenced secret when an operator has already completed the exchange.

Store credentials in a Moosewave credential reference. Secret payloads may contain:

- `jwt`, `token`, `access_token`, or `api_key` for an already issued JWT.
- `username` or `email` plus `password` or `passhash` for token exchange.
- Optional `api_base_url` and `user_agent` overrides.

Required settings:

- `provider`: `123formbuilder`
- `settings.form_id`: 123FormBuilder form ID used for `GET /forms/{form_id}/submissions`.
- `settings.credentials_ref`: Moosewave secret reference containing JWT or token-exchange login material.

Optional settings:

- `settings.account_id`: optional 123FormBuilder account identifier for operator context.
- `settings.region`: optional region evidence such as `us` or `eu`.
- `settings.api_base_url`: API base URL; defaults to `https://api.123formbuilder.com/v2`. Use the EU base URL for EU accounts when certified.
- `settings.form_name`: optional display name.
- `settings.page_size`: `per_page`, capped at the documented maximum of 1000.
- `settings.start_date`: optional lower-bound date passed to 123FormBuilder.
- `settings.include_recipients`: optional query flag for recipient metadata.
- `settings.email_field_key`, `settings.first_name_field_key`, `settings.last_name_field_key`, `settings.full_name_field_key`, `settings.phone_field_key`, `settings.company_field_key`: optional content-field identity mapping hints.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "123formbuilder",
  "name": "Website contact form",
  "credentials_ref": "cred_123formbuilder",
  "settings": {
    "form_id": "123456",
    "credentials_ref": "cred_123formbuilder",
    "page_size": 100,
    "email_field_key": "Email",
    "full_name_field_key": "Name",
    "default_tags": "website,123formbuilder",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw JWTs, usernames, passwords, passhashes, API keys, or webhook secrets. Moosewave strips unverified webhook secret references for 123FormBuilder because this runtime does not claim managed provider webhooks.

## Sync Behavior

An empty `/sync` or `/backfill` request triggers:

1. `POST /token` when a JWT is not already present in the credential secret.
2. `GET /forms/{form_id}/submissions` with `JWT`, `page`, `per_page`, optional `start_date`, and duplicate-safe `start_submission_id` continuation.
3. Response decoding from the documented `data` array and `meta.pagination` page metadata.
4. Content JSON mapping into canonical identity fields, profile attributes, list adds, and `lead.submitted` events.

The cursor is stored as `123formbuilder:` and records the form ID, page, total-page evidence, last submission ID/date watermarks, and high-water marks while a multi-page scan is in flight. Manual and scheduled continuation share `123formbuilder_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected 123FormBuilder rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling 123FormBuilder, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the 123FormBuilder form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for JWT/login credential rotation, form access review, duplicate/manual webhook, export, or integration cleanup, and data-delete review.

Moosewave does not yet claim provider-managed 123FormBuilder webhook setup/cleanup, JWT/login revocation automation, provider-side duplicate destination deletion, reconnect proof, data-delete proof, or live `start_submission_id` incremental-semantics certification. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

References:

- 123FormBuilder Developer Center API v2: `https://www.123formbuilder.com/developer/api-v2/`
- Authentication docs: `https://www.123formbuilder.com/developer/api-v2-authentication/`
- Forms/submissions docs: `https://www.123formbuilder.com/developer/api-v2-forms/`
- Official Swagger JSON: `https://www.123formbuilder.com/wp-content/uploads/sites/5/2024/01/swagger-4.json`

## Verification

```bash
cd apps/api
go test -count=1 ./internal/lead_integrations ./internal/integrations
go test -count=1 .
```
