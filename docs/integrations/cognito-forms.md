# Cognito Forms Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Cognito Forms lead-capture runtime for OData grid-view entry ID discovery, REST entry hydration, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Cognito Forms entry-puller slice; the connector remains partial until live Cognito Forms accounts are certified for API-key scope behavior, selected-view field visibility, ID ordering/update behavior, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/cognito-forms/connect/start`, `POST /api/v1/integrations/cognito-forms/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/cognito-forms/sync`, `POST /api/v1/integrations/cognito-forms/backfill`, `POST /api/v1/integrations/cognito-forms/pause`, `DELETE /api/v1/integrations/cognito-forms`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## API Key Setup

Cognito Forms API keys are used as Bearer tokens against the REST and OData APIs:

```http
Authorization: Bearer your_api_key
```

Store the API key in a Moosewave credential reference. Moosewave accepts secret payload keys named `access_token`, `api_key`, `token`, or `bearer_token`, plus optional `api_base_url`, `odata_base_url`, and `user_agent` overrides.

Required settings:

- `provider`: `cognito-forms`
- `settings.form_id`: Cognito Forms form ID.
- `settings.view_id`: Cognito Forms grid view ID used for OData entry discovery.
- `settings.credentials_ref`: Moosewave secret reference containing a Cognito Forms API key with `Form:Read` and `Entry:Read` access.

Optional settings:

- `settings.organization_id`: optional organization/workspace label for operator context.
- `settings.form_name`: optional display name.
- `settings.page_size`: local ID hydration batch size, capped at 50 by this runtime.
- `settings.api_base_url`: REST API base URL; defaults to `https://www.cognitoforms.com/api`.
- `settings.odata_base_url`: OData API base URL; defaults to `https://www.cognitoforms.com/api/odata`.
- `settings.email_field_key`, `settings.first_name_field_key`, `settings.last_name_field_key`, `settings.full_name_field_key`, `settings.phone_field_key`, `settings.company_field_key`: optional field/internal-name identity mapping hints.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "cognito-forms",
  "name": "Demo request form",
  "credentials_ref": "cred_cognito_forms_api_key",
  "settings": {
    "form_id": "123",
    "view_id": "456",
    "credentials_ref": "cred_cognito_forms_api_key",
    "page_size": 25,
    "email_field_key": "Email",
    "full_name_field_key": "Name",
    "default_tags": "demo,cognito-forms",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw Cognito Forms API keys, access tokens, or webhook secrets. Moosewave strips unverified webhook secret references for Cognito Forms because this runtime does not claim managed provider webhooks.

## Sync Behavior

An empty `/sync` or `/backfill` request triggers the managed provider pull:

1. `GET /api/odata/Forms({form_id})` hydrates form metadata.
2. `GET /api/forms/{form_id}/schema?input=false&includeLinks=false` hydrates field/schema metadata.
3. `GET /api/odata/Forms({form_id})/Views({view_id})/Entries?$select=Id&$count=true` discovers entry IDs visible to the selected grid view.
4. `GET /api/forms/{form_id}/entries/{entry_id}` hydrates each selected entry through REST.

Cognito Forms does not expose a documented REST entry-list endpoint in the API spec used for this runtime, and the OData docs used here document `$count` and `$select=Id` but not a provider page cursor. Moosewave therefore sorts and deduplicates discovered IDs, filters IDs greater than the stored `last_id`, hydrates up to `page_size` entries per pull, and stores a `cognito_forms:` cursor containing `form_id`, `view_id`, `last_id`, and `total_count`.

Manual and scheduled continuation share `cognito_forms_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying ID cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Cognito Forms rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Cognito Forms, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Cognito Forms form/view scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for API-key rotation, `Form:Read`/`Entry:Read` scope review, selected grid-view field visibility review, duplicate/manual OData consumer, webhook, export, or automation cleanup, and data-delete review.

Moosewave does not yet claim provider-managed Cognito Forms webhook setup/cleanup, API-key revocation automation, provider-side duplicate destination deletion, selected-view certification, reconnect proof, ID monotonicity/update proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

```bash
cd apps/api
go test -count=1 ./internal/lead_integrations ./internal/integrations
go test -count=1 .
```
