# Zoho CRM Native Integration

Catalog status: `Native / partial`; unified contract depth: `native_runtime_complete_live_certification_pending` for the implemented Contacts/Leads puller slice.

Moosewave currently owns Zoho CRM Contact and Lead import/backfill through credential references, managed OAuth refresh, scheduled retry workers, manual retry-cursor preservation, disconnected-row guards before provider calls and local writes, managed refresh-token revocation/local credential cleanup on disconnect, and Zoho CRM V8 records APIs. Notification API channels, Accounts/Deals/activity fanout, connected-app/notification cleanup certification, and live Zoho certification remain open before this connector can be marked fully runtime-available.

## Setup

1. Create or use a Zoho OAuth client with CRM module read scopes.
2. Store the access token or managed OAuth envelope in the existing Moosewave credential vault and use only the returned `credentials_ref` in CRM integration settings.
3. Create the CRM integration with:

```json
{
  "provider": "zoho-crm",
  "settings": {
    "organization_id": "zoho-org-1",
    "credentials_ref": "cred_zoho_oauth",
    "data_center": "us",
    "per_page": 200
  }
}
```

Optional settings:

- `data_center`: routes to the matching Zoho API domain. Supported values include `us`, `eu`, `in`, `au`, `jp`, `cn`, and `ca`.
- `api_base_url`: overrides the Zoho API base URL for tests or special routing.
- `api_version`: defaults to `v8`.
- `per_page`: records per API page; capped at 200.
- `list_view_id` / `cvid`: optional Zoho custom view ID to stamp onto synced profiles and use for first-page pulls.
- `sync_leads`: set to `false` to sync Contacts only.
- `converted`: optional Zoho Leads converted filter.
- `fields`, `contacts_fields`, `leads_fields`: optional comma-separated or array field lists to request.
- `default_tags` and `list_ids`: optional Moosewave routing evidence stamped onto synced contacts/leads.

## Sync And Backfill

Manual sync/backfill can use an empty payload:

```json
{}
```

Moosewave will pull one Zoho CRM records page using:

- `GET /crm/v8/Contacts`, then `GET /crm/v8/Leads` when lead sync is enabled.
- `Authorization: Zoho-oauthtoken <token>` from the referenced credential.
- `per_page`, `page`, and `page_token` pagination.
- Durable `zoho:` cursor checkpoints.
- Scheduled `zoho_retry:` continuation with Retry-After-aware backoff.
- Manual retry-cursor skip/resume, provider-failure retry, and local-sync-failure retry preservation.
- Scheduled-run guards that re-check disconnected rows before provider calls and before local profile writes.

Contacts are mapped into canonical CRM contacts with `zoho://contact/{id}` source IDs. Leads are mapped with `zoho://lead/{id}` source IDs and status/source evidence.

## Disconnect

Disconnect returns and persists `provider_cleanup` evidence, revokes stored managed OAuth refresh tokens when present, deletes local managed OAuth credential envelopes, and leaves Zoho connected-app plus Notification API channel audit to the certification/operator checklist.

## Remaining Native Work

- Live Zoho org certification for the implemented Contacts/Leads puller slice before `RuntimeAvailable`.
- Connected-app and Notification API cleanup certification beyond managed refresh-token revocation and local envelope deletion.
- Notification API channel create/update/delete lifecycle and callback verification.
- Accounts/Deals fanout into profile enrichment and identity-tied CRM events.
- Task/call/meeting activity sync into canonical CRM events.
- Live certification against real Zoho CRM orgs across relevant data centers for auth, pagination, page-token behavior, rate limits, reconnect, disconnect, token revocation, notification expiry, and data-delete handling.

## Official Docs Checked

- Zoho CRM V8 API overview: https://www.zoho.com/crm/developer/docs/api/v8/
- Get Records API: https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
- OAuth overview: https://www.zoho.com/crm/developer/docs/api/v8/oauth-overview.html
- Access and refresh tokens: https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html
- Multi DC support: https://www.zoho.com/crm/developer/docs/api/v8/multi-dc.html
- Notifications overview: https://www.zoho.com/crm/developer/docs/api/v8/notifications/overview.html
- Enable notifications: https://www.zoho.com/crm/developer/docs/api/v8/notifications/enable.html
