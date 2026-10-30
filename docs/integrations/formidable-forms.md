# Formidable Forms Integration

Status: Native / partial, local runtime complete, live certification pending.

Moosewave pulls Formidable Forms entries from the WordPress-hosted Formidable REST API and maps them into canonical lead profiles, lists, and `lead.submitted` events. The implemented slice uses credential references only; raw WordPress or Formidable credentials must live in the configured secrets backend.

## Requirements

- WordPress site URL reachable over HTTPS.
- Formidable Forms plus the Formidable API add-on enabled for the target site.
- A WordPress Application Password for a user with form and entry access, or a Formidable API key accepted by the site's `/wp-json/frm/v2` endpoints.
- A numeric Formidable `form_id`.

## Settings

Required:

- `site_url`: WordPress site base URL.
- `form_id`: Formidable Forms form ID.
- `credentials_ref`: Vault reference for the credential payload.

Optional:

- `plugin_namespace`: REST namespace override; defaults to `frm/v2`.
- `page_size`: entry page size, capped at 200 by this runtime.
- `search`: optional entry search string.
- `order_by`: `id`, `created_at`, `updated_at`, or `form_id`.
- `order`: `ASC` or `DESC`.
- `form_name`: display name override.
- `email_field_id`, `email_field_key`, `first_name_field_id`, `first_name_field_key`, `last_name_field_id`, `last_name_field_key`, `full_name_field_id`, `full_name_field_key`, `phone_field_id`, `phone_field_key`, `company_field_id`, `company_field_key`: explicit identity mapping hints.
- `default_tags`: comma-separated tags for imported leads.
- `list_id`: Moosewave list route for imported leads.

## Credential Secret Formats

WordPress Application Password JSON:

```json
{
  "username": "editor@example.com",
  "application_password": "xxxx xxxx xxxx xxxx xxxx xxxx",
  "site_url": "https://example.com"
}
```

Formidable API key JSON:

```json
{
  "api_key": "95SX-LM4Z-DDTC-HP8A",
  "site_url": "https://example.com"
}
```

Key-value secrets are also accepted:

```text
username=editor@example.com
application_password=xxxx xxxx xxxx xxxx xxxx xxxx
site_url=https://example.com
```

## Sync Behavior

An empty `/sync` or `/backfill` request triggers the managed provider pull:

1. `GET /wp-json/frm/v2/forms/{form_id}` hydrates form metadata.
2. `GET /wp-json/frm/v2/forms/{form_id}/fields` hydrates field labels and types.
3. `GET /wp-json/frm/v2/forms/{form_id}/entries` pulls entries with `page`, `page_size`, `order`, `order_by`, and optional `search`.

The cursor is stored as `formidable_forms:` and records page, total pages, and total count. Transient provider failures are wrapped in `formidable_forms_retry:` cursors with attempt count, next attempt time, status, and truncated error text. Provider `Retry-After` is honored for WordPress or host throttling.

## Disconnect And Certification Boundary

Disconnect marks the local integration disconnected, skips future scheduled/manual provider pulls, and persists `provider_cleanup` evidence. Provider-side credential revocation, duplicate webhook/API-action/feed cleanup, reconnect proof, data-delete proof, plugin/license proof, permission proof, and live WordPress/Formidable certification remain operator-managed before promotion to runtime available.

## Verification

```bash
cd apps/api
go test -count=1 ./internal/lead_integrations ./internal/integrations
go test -count=1 .
```
