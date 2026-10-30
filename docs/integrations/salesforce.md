# Salesforce CRM Native Integration

Status: Native / partial — local runtime complete, live Salesforce org certification pending.

Moosewave currently owns Salesforce CRM connected-app OAuth start/callback, encrypted managed credential storage, proactive token refresh plus one-shot reactive refresh/retry after early `401` / `INVALID_SESSION_ID` SOQL failures, Contact and Lead import/backfill through Salesforce REST SOQL queries, CampaignMember event fanout by Contact/Lead email with explicit Salesforce Campaign provider-segment evidence, opt-in native Moosewave list membership adds plus explicit removal-signal soft-removes and complete-scan stale repair for owned mapped Campaign memberships through `campaign_membership_map`, Task activity event fanout through Contact/Lead `Who` email mapping, manual and scheduled `salesforce_retry:` continuation, managed OAuth availability/start helpers across public API/client surfaces, and managed refresh-token revocation/local credential deletion on disconnect. The remaining availability gate is live certification against a real Salesforce org.

## Setup

1. Create or use a Salesforce connected app / external client app with API access.
2. Start the managed OAuth install flow, or store OAuth access token, refresh/client metadata, instance/login URLs, and expiry metadata in the existing Moosewave credential vault.
3. Create the CRM integration with:

```json
{
  "provider": "salesforce",
  "settings": {
    "org_id": "00Dxx0000000001",
    "credentials_ref": "crm:salesforce:managed-ref",
    "instance_url": "https://example.my.salesforce.com",
    "api_version": "67.0",
    "batch_size": 200,
    "campaign_membership_map": {
      "701xx000000001": "00000000-0000-0000-0000-000000070101"
    }
  }
}
```

Optional settings:

- `api_version`: defaults to `67.0`, the Summer '26 Salesforce Platform API version.
- `batch_size`: sent as `Sforce-Query-Options`; defaults to 200 and is capped at 2000.
- `campaign_id`: stamps synced Contact/Lead rows with a known default campaign/list ID.
- `campaign_membership_map` / `salesforce_campaign_membership_map`: optional object or `campaign_id=postwave_list_uuid` string that materializes tracked CampaignMember identities into native Moosewave list adds, and soft-removes those mapped native memberships when the CampaignMember event carries explicit removal evidence.
- `sync_leads`: set to `false` to sync Contacts only.
- `sync_campaign_members`: set to `false` to skip CampaignMember event fanout.
- `sync_tasks`: set to `false` to skip Task activity fanout.
- `contact_fields` / `lead_fields` / `campaign_member_fields` / `task_fields`: comma-separated or array of extra SOQL fields; managed OAuth start preserves these field-selection settings for the created integration.

## Sync And Backfill

Manual sync/backfill can use an empty payload:

```json
{}
```

Moosewave will pull one Salesforce SOQL page using:

- `GET /services/data/v67.0/query` by default.
- `Authorization: Bearer <token>` from the referenced credential, refreshed automatically for managed OAuth refs before expiry.
- One reactive managed OAuth refresh/retry when Salesforce returns `401` / `INVALID_SESSION_ID` before the stored expiry.
- `Sforce-Query-Options: batchSize=...`.
- Contact query first, Lead query second when enabled, CampaignMember query third when enabled, Task query fourth when enabled, and `nextRecordsUrl` cursor checkpoints for additional pages.
- Manual and scheduled `salesforce_retry:` cursors to continue due bounded syncs after Retry-After/provider failures. Manual empty sync/backfill skips not-due retries without calling Salesforce, unwraps due retries before calling SOQL, and stores fresh retry evidence when provider calls fail.

Contacts are mapped into canonical CRM contacts with `salesforce://contact/{id}` source IDs. Leads are mapped with `salesforce://lead/{id}` source IDs and status/conversion evidence.

CampaignMembers are mapped into canonical CRM events with `salesforce://campaign-member/{id}` source IDs and `crm.campaign_member.updated` event names, or `crm.campaign_member.removed` when the record carries explicit removal evidence (`IsDeleted=true` or a literal `Removed`/`Deleted` status). The mapper requires a nested `Contact.Email` or `Lead.Email`, records Campaign ID/name/status/responded/deletion evidence, stores the actual Campaign ID as `crm_provider_list_id`, and emits `crm_provider_segment_*` plus `salesforce_campaign_member_report` evidence so downstream consumers can distinguish the Salesforce Campaign provider segment from any mapped Moosewave native list. When that Campaign ID is present in `campaign_membership_map`, Moosewave adds provider-specific owner evidence for the event email identity on the mapped native Moosewave list, removes that Salesforce owner for explicit removal events, and terminal CampaignMember SOQL scans stale-repair owned mapped Campaign memberships without removing separately owned list memberships.

Tasks are mapped into canonical CRM events with `salesforce://task/{id}` source IDs and `crm.task.updated` event names. The SOQL uses `TYPEOF Who` for Contact/Lead email/name fields, skips account-only tasks with no email identity, and records subject, status, priority, type, subtype, activity/completion dates, owner, and raw Salesforce task evidence.

## Certification Gate

- Live certification against a real Salesforce org, including connected-app OAuth install, token refresh, early `INVALID_SESSION_ID` recovery, SOQL pagination/query-locator behavior, Retry-After/rate-limit handling, CampaignMember mapped-list repair evidence, Task fanout evidence, reconnect, disconnect refresh-token revocation, local credential deletion, Connected App policy cleanup, and provider-side data-delete evidence.
- Historical coarse `source=integration` memberships that predate provider-specific ownership evidence are intentionally not auto-reconciled by the connector. Any backfill/reconciliation for those rows should be an operator-approved data migration with its own audit trail, not a Salesforce runtime blocker.

## Future Enhancements

- Change Data Capture or Platform Event subscriptions for near-real-time updates.
- Replay ID storage and reconnect handling for the future streaming worker.

## Official Docs Checked

- REST Query resource: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_query.htm
- Execute SOQL query: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_query.htm
- Query more results: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_query_more_results.htm
- Query Options header: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/headers_queryoptions.htm
- OAuth and connected apps: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_oauth_and_connected_apps.htm
- Contact object: https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contact.htm
- Lead object: https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_lead.htm
- CampaignMember object: https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_campaignmember.htm
- Task object: https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_task.htm
- SOQL `TYPEOF` polymorphic relationship query: https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_soql_select_typeof.htm
- Summer '26 API version note: https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release

## Wave 2 — OAuth + scheduled worker (2026-06-20)

Salesforce now supports managed connected-app OAuth and continuous sync:

- **OAuth install** — `GET /api/v1/crm/salesforce/oauth/start` (auth'd) →
  `{login_url}/services/oauth2/authorize`; the public callback
  `GET /api/v1/crm/salesforce/oauth/callback` exchanges the code at
  `/services/oauth2/token`, captures `instance_url`, and stores an encrypted
  managed credential (`crm:salesforce:*`). Salesforce token responses omit
  `expires_in`, so an assumed TTL (default 2h, `SALESFORCE_TOKEN_TTL`) drives
  proactive refresh; disconnect revokes via `/services/oauth2/revoke`.
- **Scheduled/manual backfill retry** — Contacts + Leads + CampaignMembers + Tasks SOQL sync with
  `salesforce_retry:` cursors and Retry-After backoff; manual empty sync/backfill uses the same skip/resume/failure cursor semantics.
- **Change feed** — Change Data Capture / Platform-Events streaming (CometD /
  Pub-Sub API with replay IDs) is a **deliberate follow-on**: it is a distinct
  long-lived streaming subsystem that does not fit the HTTP-webhook handler model
  and requires a live org to certify. The scheduled worker provides periodic
  change capture in the interim.

Env: `SALESFORCE_OAUTH_CLIENT_ID/CLIENT_SECRET/REDIRECT_URL/LOGIN_URL/SUCCESS_REDIRECT/SCOPES`.
Reuses the shared `crm_oauth_states` / `crm_credential_secrets` tables and the
cross-tenant worker policy (no new migration).

## Disconnect Behavior

`DELETE /api/v1/crm/integrations/{id}` marks the CRM row `disconnected`, revokes the managed OAuth refresh token when present, deletes the local managed credential envelope, returns/persists `settings.provider_cleanup`, and preserves sync history. Repeating the delete returns the existing cleanup evidence without making another provider call.

Manual sync/backfill and pause requests reject disconnected rows with `409 integration_disconnected`. Scheduled stale targets that resolve after a disconnect skip provider calls, sync writes, and cursor mutation, and late sync-run recording cannot revive the disconnected row.
