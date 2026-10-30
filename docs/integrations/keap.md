# Keap Integration

Catalog status: `Native / partial`; unified contract depth: `native_runtime_complete_live_certification_pending` for the implemented Contacts puller slice.

Moosewave currently owns a native Keap REST v2 Contacts puller for the CRM integrations surface, with managed OAuth refresh, scheduled retry workers, manual retry-cursor preservation, disconnected-row guards before provider calls and local writes, and local cleanup evidence for the implemented slice. It is not yet a fully certified Keap app or complete tag/campaign/order/webhook runtime.

## What Works

- Create a managed CRM integration with `provider=keap`.
- Store the Keap account identifier in `account_id`.
- Store OAuth access tokens, Personal Access Tokens, or Service Account Keys only in a vault secret referenced by `credentials_ref`.
- Use managed OAuth start/callback when configured, or provide a pre-provisioned OAuth/PAT/SAK credential reference.
- Run an empty `/sync` or `/backfill` request to pull provider contacts directly.
- Pull Contacts from `/rest/v2/contacts`.
- Pull tagged contacts from `/rest/v2/tags/{tag_id}/contacts` when `tag_id` is configured.
- Follow Keap `next_page_token` values using durable `keap:` sync cursors.
- Continue due installs with scheduled `keap_retry:` cursors.
- Preserve manual retry cursors across not-due skips, due resumes, provider failures, and local sync failures.
- Re-check disconnected rows before scheduled provider calls and before local profile writes.
- Disconnect returns and persists `provider_cleanup` evidence and deletes local managed OAuth/PAT/SAK credential envelopes; Keap provider credential revocation remains operator-managed because this connector has no provider revocation endpoint.
- Cap `page_size` at 1,000.
- Map Keap Contacts into canonical Moosewave CRM contacts.
- Preserve retry/error detail through existing CRM sync run history.

## Required Settings

- `account_id`: Keap account/app identifier for operator context.
- `credentials_ref`: Vault reference containing OAuth/PAT/SAK credential material.

Supported secret payload formats:

```json
{
  "access_token": "eyJ...",
  "api_base_url": "https://api.infusionsoft.com/crm"
}
```

Personal Access Token / Service Account Key payloads are accepted:

```json
{
  "service_account_key": "sak_..."
}
```

Key-value secrets are also accepted:

```text
personal_access_token=pat_...
api_base_url=https://api.infusionsoft.com/crm
```

Raw secret values are treated as Bearer tokens. Raw tokens are rejected in public integration settings.

## Optional Settings

- `api_base_url`: Defaults to `https://api.infusionsoft.com/crm`.
- `page_size`: Defaults to 1,000 and is capped at 1,000.
- `filter`: Keap REST v2 filter expression.
- `order_by`: Defaults to `update_time asc` for full contact pulls.
- `fields`: Extra fields appended to the Contact field list.
- `contacts_fields`: Extra Contact fields to request.
- `tag_id`: Uses `/rest/v2/tags/{tag_id}/contacts` for a tagged-contact pull.
- `default_tags`: Tags stamped onto synced records.
- `list_ids`, `list_id`, `default_list_id`: Moosewave list IDs stamped onto synced records.

## Canonical Mapping

Contacts:

- Source ID: `keap://contact/{id}`
- Email: first `email_addresses[].email`, falling back to `email`
- Name: `given_name`, `family_name`
- Phone: first `phone_numbers[].number_e164`, falling back to `number`
- Company: `company.company_name`
- Lifecycle: `contact_type`, `source_type`, `job_title`, or `score_value`
- Updated time: `update_time`, falling back to `applied_time` or `create_time`

Tagged contacts:

- Source ID: `keap://contact/{id}`
- Email: `email`
- Name: `given_name`, `family_name`
- Tags: includes `keap-tag-{tag_id}`
- Updated time: `applied_time`

## Remaining Gaps

- Live Keap account certification for the implemented Contacts puller slice before `RuntimeAvailable`.
- Live/operator certification for Keap OAuth/PAT/SAK cleanup beyond local managed envelope deletion.
- Full tag details and tag membership fanout into Moosewave segment/list evidence.
- Campaign sequence, order, appointment, task, opportunity, and product fanout.
- REST Hooks/webhook registration, callback verification, idempotency, cleanup, and event handling.
- Live validation against real Keap accounts for OAuth, PAT, SAK, pagination, filters, tag pulls, rate limits, reconnect, disconnect, token revocation, and data-delete handling.

Keep the catalog badge as `Native / partial`; only the unified contract depth is promoted for the implemented Contacts puller slice until those remaining items have passing live evidence.
