# Google Forms Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Google Forms lead-capture runtime for Forms API response pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Responses API puller slice; the connector remains partial until live Google Workspace accounts are certified for OAuth app/scopes, form access, pagination, timestamp filters, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/google-forms/connect/start`, `POST /api/v1/integrations/google-forms/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/google-forms/sync`, `POST /api/v1/integrations/google-forms/backfill`, `POST /api/v1/integrations/google-forms/pause`, `DELETE /api/v1/integrations/google-forms`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## OAuth Setup

Store a Google OAuth access token in a Moosewave credential reference. The token must allow the Forms API read scopes:

- `forms.body.readonly`
- `forms.responses.readonly`

Google Forms REST requests use:

```http
Authorization: Bearer ya29...
```

Required settings:

- `provider`: `google-forms`
- `settings.form_id`: Google Forms form identifier.
- `settings.credentials_ref`: Moosewave secret reference containing the OAuth access token.

Optional settings:

- `settings.api_base_url`: explicit base URL override for private or proxied Google Forms API hosts.
- `settings.page_size`: responses page size, capped to Google's documented maximum of 5000.
- `settings.form_name`: optional display name when form metadata is unavailable.
- `settings.after_time`: optional RFC3339 UTC lower-bound filter for responses.
- `settings.email_question_id`, `settings.first_name_question_id`, `settings.last_name_question_id`, `settings.full_name_question_id`, `settings.phone_question_id`, `settings.company_question_id`: optional Google Forms question IDs for identity mapping.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "google-forms",
  "name": "Newsletter signup",
  "credentials_ref": "cred_google_forms_oauth",
  "settings": {
    "form_id": "1FAIpQLSd...",
    "credentials_ref": "cred_google_forms_oauth",
    "page_size": 500,
    "email_question_id": "question_email",
    "first_name_question_id": "question_first_name",
    "default_tags": "newsletter,google-forms",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw OAuth access tokens or webhook secrets. Moosewave strips unverified webhook secret references for Google Forms until Cloud Pub/Sub watch/channel ownership is certified.

## Sync Behavior

The Google Forms REST backfiller reads:

- `GET /v1/forms/{formId}`
- `GET /v1/forms/{formId}/responses`

Form metadata supplies question labels. Response pulls use `pageSize`, `pageToken`, optional `timestamp > RFC3339` filters, and `nextPageToken` continuation state. The runtime stores stable `google-forms:` cursors with either a page token or a timestamp watermark and maps response IDs, form IDs, create/submitted timestamps, collected respondent email, total score, raw provider payloads, and answer values into canonical lead submissions.

`/sync` and `/backfill` can be called with an empty body to pull the next Google Forms page from saved cursor state. Manual and scheduled continuation share `google_forms_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying page token/timestamp cursor. Provider `Retry-After` is honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Google Forms rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Google, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Google Forms form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for OAuth token rotation/revocation, Forms/Drive sharing review, duplicate/manual Pub/Sub watch, Apps Script trigger, linked Sheet, or webhook bridge cleanup, and data-delete review.

Moosewave does not yet claim Cloud Pub/Sub watch/channel ownership, watch renewal, OAuth app verification, Google-side token revocation, duplicate Apps Script/Sheet/webhook cleanup, reconnect proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
