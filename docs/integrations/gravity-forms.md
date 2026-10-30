# Gravity Forms Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave owns a managed Gravity Forms lead-capture runtime for Entries REST pulls, retry cursors, canonical profile/list/event imports, and disconnect cleanup evidence. The local runtime is complete for the implemented Gravity Forms entry-puller slice; the connector remains partial until live WordPress/Gravity Forms sites are certified for REST API enablement, HTTPS Basic auth, pagination/filter behavior, reconnect, disconnect, data-delete, and provider-console cleanup evidence.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/gravity-forms/connect/start`, `POST /api/v1/integrations/gravity-forms/connect/callback`
- Facade sync/backfill/pause/disconnect: `POST /api/v1/integrations/gravity-forms/sync`, `POST /api/v1/integrations/gravity-forms/backfill`, `POST /api/v1/integrations/gravity-forms/pause`, `DELETE /api/v1/integrations/gravity-forms`
- Owning surface create/update: `POST /api/v1/lead-integrations`
- Owning surface sync/backfill/delete: `POST /api/v1/lead-integrations/{id}/sync`, `POST /api/v1/lead-integrations/{id}/backfill`, `DELETE /api/v1/lead-integrations/{id}`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## Credential Setup

Enable Gravity Forms REST API v2 on the WordPress site, then store either a WordPress Application Password or Gravity Forms REST API key/secret in a Moosewave credential reference. Gravity Forms Basic auth is intended for HTTPS sites; live certification must prove HTTPS behavior before promotion.

Required settings:

- `provider`: `gravity-forms`
- `settings.site_url`: WordPress site URL that hosts Gravity Forms.
- `settings.form_id`: Gravity Forms form ID.
- `settings.credentials_ref`: Moosewave secret reference containing WordPress or Gravity Forms Basic credentials.

Optional settings:

- `settings.form_name`: optional display name for imported entries.
- `settings.page_size`: entry page size, capped at 200 for this runtime.
- `settings.status`: optional Gravity Forms entry status filter.
- `settings.search`: optional raw Gravity Forms search JSON object.
- `settings.email_field_id`, `settings.first_name_field_id`, `settings.last_name_field_id`, `settings.full_name_field_id`, `settings.phone_field_id`, `settings.company_field_id`: optional Gravity Forms field IDs for identity mapping.
- `settings.email_field`, `settings.first_name_field`, `settings.last_name_field`, `settings.full_name_field`, `settings.phone_field`, `settings.company_field`: optional field-label mapping aliases.
- `settings.default_tags`, `settings.list_id`: Moosewave routing metadata.

Example:

```json
{
  "provider": "gravity-forms",
  "name": "Website inquiry",
  "credentials_ref": "cred_gravity_forms_wp_app_password",
  "settings": {
    "site_url": "https://example.com",
    "form_id": "12",
    "credentials_ref": "cred_gravity_forms_wp_app_password",
    "page_size": 100,
    "status": "active",
    "email_field_id": "3",
    "first_name_field_id": "1.3",
    "last_name_field_id": "1.6",
    "default_tags": "gravity-forms,website",
    "list_id": "list_123"
  }
}
```

Public settings must not contain raw WordPress passwords, Gravity Forms REST keys/secrets, or webhook secrets. Moosewave strips unverified webhook secret references for Gravity Forms until provider-managed webhook/feed runtime is certified.

## Credential Secret Format

WordPress Application Password:

```json
{
  "username": "wp-user@example.com",
  "application_password": "xxxx xxxx xxxx xxxx xxxx xxxx",
  "site_url": "https://example.com"
}
```

Gravity Forms REST API key/secret:

```json
{
  "consumer_key": "ck_...",
  "consumer_secret": "cs_...",
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

The Gravity Forms REST backfiller reads:

- `GET /wp-json/gf/v2/forms/{form_id}/entries`

Entry pulls use `_labels=1`, `paging[page_size]`, `paging[offset]`, `sorting[key]=id`, `sorting[direction]=ASC`, optional `status`, and optional raw `search` filters. The runtime stores stable `gravity_forms:` cursors with offset and `total_count` state, maps entry IDs, form IDs, created/updated dates, source URL, IP, user agent, status, field labels, and raw provider payloads into canonical lead submissions. Email, name, phone, and company values are mapped through configured field IDs or labels, with fallback heuristics over Gravity Forms field labels.

`/sync` and `/backfill` can be called with an empty body to pull the next Gravity Forms page from saved cursor state. Manual and scheduled continuation share `gravity_forms_retry:` cursors with attempt count, next-attempt time, status, truncated error details, and the underlying offset cursor. Provider or WordPress host `Retry-After` headers are honored when present, otherwise retry delay uses bounded exponential backoff.

Disconnected Gravity Forms rows reject manual sync/backfill with `409 integration_disconnected`. Scheduled bulk backfills skip disconnected rows before calling Gravity Forms, and stale run recording cannot revive the disconnected local row.

## Cleanup And Certification Gap

Disconnect marks the local row disconnected, preserves run history, and returns plus persists `provider_cleanup` evidence with the Gravity Forms form scope, credential-ref presence, Moosewave shutdown effects, and the operator checklist for WordPress Application Password or Gravity Forms REST credential rotation/revocation, REST API enablement review, duplicate/manual webhook, feed, notification, or export cleanup, reconnect proof, and data-delete review.

Moosewave does not yet claim provider-managed Gravity Forms webhook/feed registration, WordPress-side credential revocation, duplicate destination deletion, reconnect proof, live HTTPS Basic-auth proof, plugin/version/permission proof, or data-delete proof. Those items require live provider certification before the connector can move to `RuntimeAvailable`.

## Verification

- `go test -count=1 ./internal/lead_integrations ./internal/integrations`
