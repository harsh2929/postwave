# SurveyMonkey Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed SurveyMonkey lead-capture runtime for survey detail hydration, bulk response pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented REST response-puller slice; the connector remains partial until live SurveyMonkey accounts are certified for OAuth app/scopes, survey and collector access, pagination, timestamp filters, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/surveymonkey/connect/start`, `POST /api/v1/integrations/surveymonkey/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/surveymonkey/sync`, `POST /api/v1/integrations/surveymonkey/backfill`, `POST /api/v1/integrations/surveymonkey/pause`, `DELETE /api/v1/integrations/surveymonkey`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## OAuth Setup

Store a SurveyMonkey OAuth access token in a Moosewave credential reference. The token must allow read access to survey details and response details:

- `surveys_read_detail`
- `responses_read_detail`

SurveyMonkey REST requests use:

```http
Authorization: Bearer access_token
```

Required settings:

- `provider`: `surveymonkey`
- `settings.survey_id`: SurveyMonkey survey identifier.
- `settings.credentials_ref`: Moosewave secret reference containing the OAuth access token.

Optional settings:

- `settings.collector_id`: optional collector filter.
- `settings.api_base_url`: optional SurveyMonkey API base URL override.
- `settings.page_size`: response page size, capped to SurveyMonkey's documented maximum of 100.
- `settings.survey_name`: optional display name when survey metadata is unavailable.
- `settings.start_modified_at`, `settings.end_modified_at`: optional modified-time filters.
- `settings.start_created_at`, `settings.end_created_at`: optional created-time filters.
- `settings.status`: optional response status filter.
- `settings.email_question_id`, `settings.first_name_question_id`, `settings.last_name_question_id`, `settings.full_name_question_id`, `settings.phone_question_id`, `settings.company_question_id`: optional SurveyMonkey question IDs for identity mapping.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "surveymonkey",
  "name": "Newsletter survey",
  "credentials_ref": "cred_surveymonkey_oauth",
  "settings": {
    "survey_id": "123456789",
    "credentials_ref": "cred_surveymonkey_oauth",
    "collector_id": "987654321",
    "page_size": 100,
    "start_modified_at": "2026-06-01T00:00:00Z",
    "email_question_id": "1001",
    "first_name_question_id": "1002",
    "default_tags": "newsletter,surveymonkey",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw OAuth access tokens or webhook secrets. Moosewave strips unverified webhook secret references for SurveyMonkey until provider-managed webhook ownership is implemented and certified.

## Sync Behavior

The SurveyMonkey REST backfiller reads:

- `GET /v3/surveys/{survey_id}/details`
- `GET /v3/surveys/{survey_id}/responses/bulk`

Survey details supply question and answer labels. Response pulls use `per_page`, optional collector/status/created/modified filters, and SurveyMonkey `links.next` continuation state. The runtime stores stable `surveymonkey:` cursors with either a next URL or a timestamp watermark and maps response IDs, survey IDs, collector IDs, status, timestamps, custom variables, raw provider payloads, and answer values into canonical lead submissions.

`/sync` and `/backfill` can be called with an empty body to pull the next SurveyMonkey page from saved cursor state. Manual and scheduled continuation share `surveymonkey_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying next-URL/timestamp cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected SurveyMonkey rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling SurveyMonkey, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the SurveyMonkey survey scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for OAuth token revocation, survey/collector/app access review, duplicate/manual webhook or export cleanup, and data-delete review.

Moosewave does not yet claim provider-managed SurveyMonkey webhooks, SurveyMonkey-side OAuth revocation, duplicate destination deletion, reconnect proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
