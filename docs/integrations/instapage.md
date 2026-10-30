# Instapage Native Lead Puller

Status: Native / partial, local runtime complete for the implemented submissions API puller slice. Live Instapage workspace/API-token certification is still required before `RuntimeAvailable`.

## Runtime Scope

The Instapage lead integration imports landing-page submissions from the Instapage Public API into canonical Moosewave lead submissions, subscriber profiles, lists, and lead events.

Implemented local runtime:

- Credential-reference setup with raw personal API tokens stored only in the configured secret reference.
- `POST /v1/workspaces/{workspaceId}/submissions` submission pulls using documented workspace, page, timeframe, and `nextPageToken` request fields.
- Bearer token auth through the referenced Instapage personal API token.
- Defensive response parsing for documented `data.submissions`, `data`, `meta.nextPageToken`, and top-level token variants.
- `instapage:` cursors with `nextPageToken` and Unix-second timestamp-watermark state.
- `instapage_retry:` cursors with retry attempts, next-attempt time, status, and truncated provider errors.
- Manual empty `/sync` and `/backfill` provider-pull dispatch.
- Connect-time bounded history drain.
- Scheduled stale-row continuation.
- `Retry-After`-aware provider errors with bounded exponential backoff.
- Disconnect-time operator-managed `provider_cleanup` evidence.

## Required Settings

- `workspace_id`: Instapage workspace identifier.
- `page_id`: Instapage landing page identifier.
- `credentials_ref`: Secret reference containing an Instapage personal API token.

## Optional Settings

- `api_base_url`: Override for private/proxied Instapage API hosts.
- `from`: Lower created-at bound as Unix seconds, milliseconds, or RFC3339.
- `to`: Upper created-at bound as Unix seconds, milliseconds, or RFC3339.
- `page_name` / `form_name`: Display names for imported submissions.
- `form_id`: Optional Moosewave form identifier.
- `default_tags`: Comma-separated tags added to imported leads.
- `list_id`: Moosewave list ID for imported leads.
- `email_field`, `first_name_field`, `last_name_field`, `full_name_field`, `phone_field`, `company_field`: Explicit field identity mapping overrides.

## Credential Secret Format

Personal API token:

```json
{
  "access_token": "INSTAPAGE_PERSONAL_API_TOKEN"
}
```

`api_key`, `token`, and `bearer_token` aliases also work:

```json
{
  "api_key": "INSTAPAGE_PERSONAL_API_TOKEN",
  "api_base_url": "https://api.instapage.com",
  "user_agent": "Moosewave Instapage Integration"
}
```

Key-value secrets also work:

```text
access_token=INSTAPAGE_PERSONAL_API_TOKEN
api_base_url=https://api.instapage.com
```

## Live Certification Checklist

Before promoting Instapage from `native_runtime_complete_live_certification_pending` to `RuntimeAvailable`, collect evidence for:

- Live personal API-token access across customer-owned Instapage workspaces.
- Submissions API pagination, timeframe filtering, and 429 behavior on live landing pages.
- Production payload-shape evidence for fields, nested arrays, timestamps, and `nextPageToken`.
- Credential rotation/revocation behavior.
- Reconnect and cursor-resume behavior.
- Provider-console duplicate webhook/export cleanup proof.
- Data-delete workflow proof for imported lead data.
- Any provider-managed webhook lifecycle if Moosewave later owns webhook registration.
