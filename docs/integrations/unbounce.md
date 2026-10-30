# Unbounce Native Lead Puller

Status: Native / partial, local runtime complete for the implemented Leads API puller slice. Live Unbounce account/API certification is still required before `RuntimeAvailable`.

## Runtime Scope

The Unbounce lead integration imports landing-page, pop-up, sticky-bar, and AMP leads from the Unbounce API into canonical Moosewave lead submissions, subscriber profiles, lists, and lead events.

Implemented local runtime:

- Credential-reference setup with raw OAuth tokens/API keys stored only in the configured secret reference.
- `GET /pages/{page_id}/form_fields` label hydration.
- `GET /pages/{page_id}/leads` lead pulls using documented `from`, `to`, `offset`, and `limit` query parameters.
- Page size capped at Unbounce's documented maximum of `1000`.
- OAuth Bearer token and API-key Basic auth support.
- Required `Accept: application/vnd.unbounce.api.v0.4+json` requests.
- `unbounce:` cursors with offset and timestamp-watermark state.
- `unbounce_retry:` cursors with retry attempts, next-attempt time, status, and truncated provider errors.
- Manual empty `/sync` and `/backfill` provider-pull dispatch.
- Connect-time bounded history drain.
- Scheduled stale-row continuation.
- `Retry-After`-aware provider errors with bounded exponential backoff.
- Disconnect-time operator-managed `provider_cleanup` evidence.

## Required Settings

- `page_id`: Unbounce page, pop-up, sticky-bar, or AMP page identifier.
- `credentials_ref`: Secret reference containing Unbounce OAuth or API-key credentials.

## Optional Settings

- `api_base_url`: Override for private/proxied Unbounce API hosts.
- `page_size`: Leads API `limit`, capped at `1000`.
- `from`: Lower created-at bound.
- `to`: Upper created-at bound.
- `include_sub_pages`: Passed to the form-fields request when set.
- `page_name` / `form_name`: Display names for imported submissions.
- `default_tags`: Comma-separated tags added to imported leads.
- `list_id`: Moosewave list ID for imported leads.
- `email_field_id`, `first_name_field_id`, `last_name_field_id`, `full_name_field_id`, `phone_field_id`, `company_field_id`: Explicit form-field identity mapping overrides.

## Credential Secret Format

OAuth token:

```json
{
  "access_token": "OAUTH_ACCESS_TOKEN"
}
```

API key:

```json
{
  "api_key": "UNBOUNCE_API_KEY"
}
```

Optional fields:

```json
{
  "access_token": "OAUTH_ACCESS_TOKEN",
  "api_base_url": "https://api.unbounce.com",
  "user_agent": "Moosewave Unbounce Integration"
}
```

Key-value secrets also work:

```text
access_token=OAUTH_ACCESS_TOKEN
api_base_url=https://api.unbounce.com
```

## Live Certification Checklist

Before promoting Unbounce from `native_runtime_complete_live_certification_pending` to `RuntimeAvailable`, collect evidence for:

- Live OAuth and API-key account access across customer-owned Unbounce workspaces.
- Leads API pagination, timestamp filtering, and 429 behavior on live pages.
- Form-field label hydration across landing pages, pop-ups, sticky bars, AMP pages, and sub-pages.
- Credential rotation/revocation behavior.
- Reconnect and cursor-resume behavior.
- Provider-console duplicate webhook/export cleanup proof.
- Data-delete workflow proof for imported lead data.
- Any provider-managed webhook lifecycle if Moosewave later owns webhook registration.
