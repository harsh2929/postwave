# Microsoft Dynamics 365 Integration

Catalog status: `Native / partial`; unified contract depth: `native_runtime_complete_live_certification_pending` for the implemented Contacts/Leads puller slice.

Moosewave currently owns a native Microsoft Dynamics 365 Dataverse Contacts/Leads puller for the CRM integrations surface, with managed OAuth refresh, scheduled retry workers, manual retry-cursor preservation, disconnected-row guards before provider calls and local writes, and local cleanup evidence for the implemented slice. It is not yet a fully certified Microsoft marketplace app or complete Dataverse event runtime.

## What Works

- Create a managed CRM integration with `provider=microsoft-dynamics-365`.
- Store the Dataverse environment URL in `environment_url`, for example `https://org.crm.dynamics.com`.
- Store OAuth access-token material only in a vault secret referenced by `credentials_ref`.
- Use managed OAuth start/callback when configured, or provide a pre-provisioned credential reference.
- Run an empty `/sync` or `/backfill` request to pull provider records directly.
- Pull Contacts from `/api/data/v9.2/contacts`.
- Pull Leads from `/api/data/v9.2/leads` after Contacts complete, unless `sync_leads=false`.
- Follow Dataverse `@odata.nextLink` cursors using durable `dynamics365:` sync cursors.
- Continue due installs with scheduled `dynamics365_retry:` cursors.
- Preserve manual retry cursors across not-due skips, due resumes, provider failures, and local sync failures.
- Re-check disconnected rows before scheduled provider calls and before local profile writes.
- Disconnect returns and persists `provider_cleanup` evidence and deletes local managed OAuth credential envelopes; Microsoft Entra token/app cleanup remains operator-managed because this connector has no provider revocation endpoint.
- Cap page size with `Prefer: odata.maxpagesize`, up to 5,000 rows.
- Map Dataverse Contacts and Leads into canonical Moosewave CRM contacts.
- Preserve retry/error detail through existing CRM sync run history.

## Required Settings

- `environment_url`: Dataverse environment URL.
- `credentials_ref`: Vault reference containing the Microsoft OAuth token payload.

Supported secret payload formats:

```json
{
  "access_token": "eyJ...",
  "environment_url": "https://org.crm.dynamics.com",
  "api_version": "v9.2"
}
```

Key-value secrets are also accepted:

```text
access_token=eyJ...
environment_url=https://org.crm.dynamics.com
api_version=v9.2
```

Raw secret values are treated as Bearer access tokens. Raw tokens are rejected in public integration settings.

## Optional Settings

- `api_version`: Defaults to `v9.2`.
- `page_size`: Defaults to 5,000 and is capped at 5,000.
- `sync_leads`: Set `false` to sync Contacts only.
- `contacts_fields`: Extra Dataverse Contact fields to request.
- `leads_fields`: Extra Dataverse Lead fields to request.
- `fields`: Extra fields appended to both objects.
- `default_tags`: Tags stamped onto synced records.
- `list_ids`, `list_id`, `default_list_id`, `marketing_list_id`: Moosewave list IDs stamped onto synced records.
- `tenant_id`: Optional Microsoft tenant evidence.
- `business_unit_id`: Optional business-unit evidence; filtering remains partial.

## Canonical Mapping

Contacts:

- Source ID: `dynamics365://contact/{contactid}`
- Email: `emailaddress1`, falling back to `emailaddress2`
- Name: `firstname`, `lastname`, `fullname`
- Phone: `telephone1`, `mobilephone`, `telephone2`
- Company: parent customer formatted value when available
- Lifecycle: status formatted value, lead source formatted value, or job title
- Updated time: `modifiedon`, falling back to `createdon`

Leads:

- Source ID: `dynamics365://lead/{leadid}`
- Email: `emailaddress1`, falling back to `emailaddress2`
- Name: `firstname`, `lastname`, `fullname`
- Company: `companyname`
- Lifecycle: status or lead-source formatted value
- Updated time: `modifiedon`, falling back to `createdon`

## Remaining Gaps

- Live Dynamics 365/Dataverse environment certification for the implemented Contacts/Leads puller slice before `RuntimeAvailable`.
- Managed Dataverse change tracking, webhooks/service endpoints, callback verification, and subscription cleanup.
- Accounts, Opportunities, marketing-list membership, and activity fanout.
- Live validation against real Dynamics 365/Dataverse environments.
- Live/operator certification for Microsoft Entra token/app cleanup beyond local managed envelope deletion.

Keep the catalog badge as `Native / partial`; only the unified contract depth is promoted for the implemented puller slice until those remaining items have passing live evidence.
