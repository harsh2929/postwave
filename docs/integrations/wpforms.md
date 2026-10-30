# WPForms Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed WPForms lead-capture runtime for read-only WordPress Abilities API entry pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented WPForms Pro entry-puller slice; the connector remains partial until live WordPress/WPForms sites are certified for WordPress 6.9+ Abilities API availability, WPForms 1.9.9+ Pro entry access, Application Password auth, pagination/filter behavior, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/wpforms/connect/start`, `POST /api/v1/integrations/wpforms/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/wpforms/sync`, `POST /api/v1/integrations/wpforms/backfill`, `POST /api/v1/integrations/wpforms/pause`, `DELETE /api/v1/integrations/wpforms`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## Credential Setup

Use a WordPress user with WPForms permissions and create a WordPress Application Password. Store the username and generated application password in a Moosewave credential reference. WPForms exposes read abilities through WordPress core's Abilities API at:

- `/wp-json/wp-abilities/v1/abilities/wpforms/get-form/run`
- `/wp-json/wp-abilities/v1/abilities/wpforms/search-entries/run`

Required settings:

- `provider`: `wpforms`
- `settings.site_url`: WordPress site URL that hosts WPForms.
- `settings.form_id`: numeric WPForms form ID.
- `settings.credentials_ref`: Moosewave secret reference containing WordPress Application Password credentials.

Optional settings:

- `settings.form_name`: optional display name for imported entries.
- `settings.page_size`: entries page size, capped at 100 by the WPForms Abilities API.
- `settings.status`: optional entry status filter: `partial`, `abandoned`, `spam`, or `trash`.
- `settings.type`: optional entry type filter: `read`, `unread`, or `starred`.
- `settings.search`, `settings.field_id`, `settings.field_value`: optional search filters.
- `settings.date_from`, `settings.date_to`: optional `YYYY-MM-DD` search bounds.
- `settings.email_field_id`, `settings.first_name_field_id`, `settings.last_name_field_id`, `settings.full_name_field_id`, `settings.phone_field_id`, `settings.company_field_id`: optional WPForms field IDs for identity mapping.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "wpforms",
  "name": "Newsletter signup",
  "credentials_ref": "cred_wpforms_wp_app_password",
  "settings": {
    "site_url": "https://example.com",
    "form_id": "123",
    "credentials_ref": "cred_wpforms_wp_app_password",
    "page_size": 100,
    "type": "unread",
    "email_field_id": "2",
    "first_name_field_id": "1",
    "default_tags": "wpforms,newsletter",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw WordPress passwords or webhook secrets. Moosewave strips unverified webhook secret references for WPForms until provider-managed webhook/feed runtime is certified.

## Credential Secret Format

```json
{
  "username": "wp-user@example.com",
  "application_password": "xxxx xxxx xxxx xxxx xxxx xxxx",
  "site_url": "https://example.com"
}
```

Key-value secrets also work:

```text
username=wp-user@example.com
application_password=xxxx xxxx xxxx xxxx xxxx xxxx
site_url=https://example.com
```

## Sync Behavior

The WPForms backfiller reads form metadata first:

- `GET /wp-json/wp-abilities/v1/abilities/wpforms/get-form/run?input[form_id]=...&input[include_fields]=true`

Then it reads Pro entries:

- `GET /wp-json/wp-abilities/v1/abilities/wpforms/search-entries/run?input[form_id]=...&input[include_fields]=true&input[limit]=...&input[page]=...`

Entry pulls use page/limit pagination, `include_fields=true`, ascending `entry_id` ordering by default, optional search/status/type/date filters, and WPForms field labels for identity mapping. The runtime stores stable `wpforms:` cursors with page, `total_pages`, and `total_count` state, then maps entry IDs, form IDs, entry dates, viewed/starred status, IP address, field values, and raw provider payloads into canonical lead submissions. Email, name, phone, and company values are mapped through configured field IDs or labels, with fallback heuristics over WPForms field names.

`/sync` and `/backfill` can be called with an empty body to pull the next WPForms page from saved cursor state. Manual and scheduled continuation share `wpforms_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying page cursor. Provider or WordPress host `Retry-After` headers are honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected WPForms rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling WordPress/WPForms, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the WPForms form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for WordPress Application Password rotation/revocation, WordPress 6.9+/WPForms Pro capability review, duplicate/manual webhook, feed, notification, or export cleanup, reconnect proof, and data-delete review.

Moosewave does not yet claim provider-managed WPForms webhook/feed registration, WordPress-side credential revocation, duplicate destination deletion, reconnect proof, live plugin/version/license proof, capability proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
