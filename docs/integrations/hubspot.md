# HubSpot CRM Native Integration

Status: Native / partial.

Moosewave currently owns HubSpot CRM contact import/backfill through credential references and HubSpot's CRM objects API, configured list-membership fanout through the Lists API with provider-list segment evidence, opt-in native Moosewave list membership adds through `list_membership_map`, complete-scan stale repair for owned native list memberships, opt-in deal association event fanout, managed OAuth install/refresh/revocation, manual and scheduled retry continuation, OAuth-install app-level signed contact webhooks, and persisted disconnect cleanup evidence. Private-app credential rows are polling-only: HubSpot app-level subscriptions apply only to accounts that installed the Moosewave public app through OAuth. Migration preserves the raw HubSpot contact ID in subscriber source provenance and in its durable source-projection ledger; the native reader accepts raw, legacy, or URI forms and normalizes them into a durable integration-scoped binding. An exact migration-source or lineage-safe ledger match is adopted before any email lookup, including when the originally imported subscriber was merged before the first native sync, while incomplete or conflicting evidence fails closed. Because historical migration provenance has no portal dimension, lazy adoption also fails closed when a tenant has more than one non-disconnected HubSpot integration.

## Setup

1. Choose managed OAuth when app-level contact webhooks are required. A private-app token can be used for REST backfill and scheduled polling only. Grant contact read access; add list read access when using configured membership fanout, and deal/company read access when `sync_deals=true`.
2. Store the token in the existing Moosewave credential vault and use only the returned `credentials_ref` in the CRM integration request.
3. Create the CRM integration with:

```json
{
  "provider": "hubspot",
  "credentials_ref": "cred_hubspot_private_app",
  "settings": {
    "portal_id": "123456",
    "page_size": 100,
    "sync_list_memberships": true,
    "membership_list_ids": "456,789",
    "list_membership_map": {
      "456": "00000000-0000-0000-0000-000000000456"
    },
    "sync_deals": true,
    "deal_page_size": 50,
    "deal_properties": "dealname,pipeline,dealstage,amount,closedate",
    "company_properties": "name,domain,industry",
    "properties": "email,firstname,lastname,phone,company,lifecyclestage"
  }
}
```

Optional settings:

- `list_id`: stamps synced contacts with a known default HubSpot list ID; also acts as a membership list when `sync_list_memberships=true` and `membership_list_ids` is omitted.
- `sync_list_memberships`: set to `true` to pull configured HubSpot list memberships after contact pages complete.
- `membership_list_ids` / `hubspot_list_ids`: comma-separated or array of HubSpot list IDs to traverse through the Lists API.
- `list_membership_map` / `hubspot_list_membership_map`: optional object or `hubspot_list_id=postwave_list_uuid` string that materializes proven HubSpot list memberships into native Moosewave lists with `source=integration` plus provider-specific owner evidence.
- `membership_page_size`: capped at 100 for list membership records.
- `sync_deals`: set to `true` to pull HubSpot deals after contacts and configured memberships complete, then emit CRM events for associated contacts with email addresses.
- `deal_page_size`: capped at 100 for deal records.
- `deal_properties`: comma-separated or array of extra deal properties to request.
- `company_properties`: comma-separated or array of extra company properties to request for deal-associated account evidence.
- `api_base_url`: overrides `https://api.hubapi.com` for tests or special routing.
- `api_version`: defaults to `2026-03`; set `v3` only for legacy endpoint compatibility.
- `properties`: comma-separated or array of extra contact properties to request.
- `page_size`: capped at 100 for the contacts list endpoint.
- Managed OAuth callbacks store provider-verified `portal_id`, `hubspot_portal_id`, `hubspot_app_id`, and `hubspot_auth_mode=managed_oauth` routing metadata. Manual credential-reference rows are normalized to `hubspot_auth_mode=private_app` and `hubspot_webhook_mode=polling_only`; user-supplied routing metadata cannot opt them into app webhook delivery.

## Sync And Backfill

Manual sync/backfill can use an empty payload:

```json
{}
```

Moosewave will pull one HubSpot contacts page using:

- `GET /crm/objects/2026-03/contacts` by default.
- `GET /crm/v3/objects/contacts` when `api_version=v3`.
- `Authorization: Bearer <token>` from the referenced credential.
- `limit`, `after`, `archived=false`, and `properties` query parameters.
- When `sync_list_memberships=true`, Contacts pages advance into `GET /crm/v3/lists/{listId}/memberships` for each configured list ID.
- Membership pages batch-read member contacts with `POST /crm/v3/objects/contacts/batch/read`, then map contacts with the current proven HubSpot list ID, `crm_provider_segment_*` evidence, and a `hubspot_list_membership_report`. When that HubSpot list ID is present in `list_membership_map`, Moosewave adds the synced contact email to the mapped native Moosewave list after the CRM profile upsert succeeds.
- For mapped HubSpot lists, each provider-managed list scan opens a provider-specific ownership ledger scope; terminal list pages stale-repair only memberships owned by that same HubSpot integration/list mapping, and leave historical or separately owned memberships active.
- When `sync_deals=true`, completed contact/list-membership pages advance into `GET /crm/objects/2026-03/deals` by default, with `associations=contacts,companies`, deal property selection, `after` pagination, and a `deal_page_size` cap.
- Deal pages batch-read associated contacts through `POST /crm/v3/objects/contacts/batch/read` and associated companies through `POST /crm/v3/objects/companies/batch/read`.
- Manual empty sync/backfill honors stored `hubspot_retry:` cursors the same way the scheduled worker does: not-due cursors skip HubSpot calls and preserve the retry cursor, due cursors unwrap and resume the embedded HubSpot object cursor, and provider failures store fresh Retry-After-aware retry evidence.

Contacts are mapped into canonical CRM contacts with `hubspot://contact/{id}` source IDs, normalized email/name/phone/company/lifecycle fields, HubSpot object metadata, raw properties, optional default list IDs, and default `hubspot` tags. The profile sink binds `(tenant, integration, provider contact)` to Moosewave's stable subscriber/profile identity. Later HubSpot primary-email changes resolve through that profile binding, while a first-time email match preserves any unrelated `subscribers.external_id`. Trait updates merge into existing custom fields and leave status, consent, tags, `source_id`, and `source_platform` unchanged; this prevents a native refresh from erasing richer one-time migration evidence. The binding follows subscriber merge lineage; `deleted` and `no_email` can reactivate only from a source revision at least as new as the inactive event. A `privacy_deleted` object ID is a terminal tombstone and cannot be reactivated by ordinary sync/webhook traffic. Proven Lists API membership snapshots additionally carry provider-list segment IDs, non-removal evidence, and a compact list-membership report so downstream consumers can distinguish HubSpot provider lists from mapped Moosewave native lists.

Deal-associated contacts are mapped into canonical CRM events with `hubspot://deal/{dealId}/contact/{contactId}` source IDs and `crm.deal.updated` event names. Event properties include the deal ID/name/pipeline/stage/amount/close date, associated contact ID, associated company summaries, optional HubSpot list IDs, raw deal properties, and the HubSpot updated timestamp when present. Deals without an associated contact email are skipped while cursor advancement is preserved.

## Remaining Native Work

- Marketplace/app-review evidence and live provider-console cleanup proof for managed OAuth installs.
- Live certification of private-app polling and OAuth installs, contact/list/deal pagination, rate-limit behavior, 2026-03 webhook settings/subscription reconciliation, app-level webhook delivery, disconnect refresh-token revocation, provider-console cleanup, and data-delete posture.
- Live provider proof is still required for deletion/privacy-deletion ordering, contacts that lose their primary email, and data-delete posture. The implemented policy marks the integration-scoped binding `no_email`, `deleted`, or `privacy_deleted`, compares HubSpot contact `updatedAt` with lifecycle `occurredAt` so older fetches/events cannot overwrite newer state, keeps privacy deletion monotonic under out-of-order deliveries, and detaches only list memberships owned by that HubSpot integration. `privacy_deleted` clears the binding's last-email cache, retains only a non-PII event tombstone, and blocks ordinary reactivation for that object ID. It intentionally retains the subscriber and does not alter consent, status, suppressions, tags, external identity, or migration provenance.
- Webhook routing fails closed when more than one active managed-OAuth integration claims the same `appId` + `portalId`. Existing duplicate ownership must be reconciled before webhook delivery can resume for that install.
- Live-certified HubSpot list repair evidence for provider-owned mapped memberships.
- Optional operator-approved reconciliation of historical coarse `source=integration` memberships that predate provider-specific ownership evidence.
- Future product scope: broader deal lifecycle coverage, provider deal webhooks, and richer deal/company/account materialization if needed.

## Disconnect Behavior

`DELETE /api/v1/crm/integrations/{id}` marks the CRM row `disconnected`, returns and persists `settings.provider_cleanup`, and preserves sync/webhook audit history. Repeating the delete returns the existing cleanup evidence without making another provider call.

For managed OAuth rows, Moosewave revokes the HubSpot refresh token when present and deletes the local managed credential envelope after the disconnect update. Private app token revocation, OAuth app uninstall review, duplicate/manual webhook target cleanup, and provider-console list/deal setting review remain HubSpot-side operator actions.

Manual sync/backfill and pause requests reject disconnected rows with `409 integration_disconnected`. Scheduled stale targets that resolve after a disconnect skip provider calls, sync writes, and cursor mutation, and late sync-run recording cannot revive the disconnected row.

HubSpot app-level webhooks resolve only `connected` or `active` managed-OAuth rows using the signed payload's exact `appId` + `portalId`. Private-app rows, mismatched app IDs, ambiguous duplicate ownership, paused/errored rows, and disconnected rows are acknowledged as ignored/unknown and do not claim delivery IDs or mutate Moosewave profiles.

## Official Docs Checked

- Contacts API: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide
- Authentication overview: https://developers.hubspot.com/docs/apps/legacy-apps/authentication/intro-to-auth
- Request signature validation: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation
- Webhooks API guide: https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide
- Lists API: https://developers.hubspot.com/docs/api-reference/latest/crm/lists/guide
- Deals API: https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide
- Companies API: https://developers.hubspot.com/docs/api-reference/crm-companies-v3/guide
- Associations API: https://developers.hubspot.com/docs/api-reference/crm-associations-v3/guide

## Wave 2 — OAuth, scheduled worker, and webhooks (2026-06-20)

HubSpot is now a managed native connector foundation:

- **OAuth public-app install** — `GET /api/v1/crm/hubspot/oauth/start` (auth'd) →
  `https://app.hubspot.com/oauth/authorize`; the public callback
  `GET /api/v1/crm/hubspot/oauth/callback` exchanges the code at
  `POST /oauth/v1/token`, reads `hub_id` (portalId) via
  `GET /oauth/v1/access-tokens/{token}`, and stores an encrypted managed
  credential (`crm:hubspot:*`). Access tokens refresh automatically on resolve;
  disconnect revokes the refresh token (`DELETE /oauth/v1/refresh-tokens/{token}`).
  There is **no inbound uninstall callback** — HubSpot does not send one.
- **Scheduled/manual backfill retry** — continuous managed contact and configured list-membership sync with
  `hubspot_retry:` cursors and Retry-After backoff (default 15-min tick); manual empty sync/backfill uses the same skip/resume/failure cursor semantics.
- **OAuth app-level webhooks** — single public endpoint
  `POST /api/public/crm-integrations/hubspot/webhooks`, verified with
  `X-HubSpot-Signature-v3` against the app client secret, routed to one owning
  managed-OAuth integration by `appId` + `portalId` for `connected` or `active`
  rows only, idempotent via `crm_webhook_events`. Private-app rows do not receive
  these app-level subscriptions. Claims use a canonical digest of each event's
  app, portal, event ID, subscription ID/type, object ID, occurrence time,
  property name, change source, and a digest rather than the literal property
  value because HubSpot does not guarantee that `eventId` is unique. The retry
  `attemptNumber` and surrounding batch shape are excluded so the same
  notification deduplicates across retries. Both the documented
  `subscriptionType` field and the guide's `eventType` example field are
  accepted, but conflicting values are rejected. Partial processing,
  finalization, and concurrent in-progress failures return retryable `503`;
  completed siblings deduplicate on the whole-batch retry, failed claims can be
  retried immediately, and abandoned in-progress claims become claimable after
  a bounded stale interval. Startup reconciliation uses the current
  `/webhooks/2026-3/{appId}` settings/subscription endpoints, updates the target
  URL and throttling settings, and creates one `contact.propertyChange`
  subscription per configured property name as required by HubSpot.

Env: `HUBSPOT_OAUTH_CLIENT_ID/CLIENT_SECRET/REDIRECT_URL/OAUTH_BASE_URL/SUCCESS_REDIRECT/SCOPES`,
`HUBSPOT_APP_ID`, `HUBSPOT_DEVELOPER_API_KEY`, `POSTWAVE_PUBLIC_BASE_URL` (must match
the registered webhook target). Migration `1609_crm_hubspot_oauth_webhooks.sql`
adds the initial portalId webhook-lookup RLS policy + index; migration
`1652_crm_integration_disconnect_cleanup.sql` tightens lookup to connected/active
rows, adds canonical `portal_id` RLS compatibility, and backfills cleanup evidence
for already-disconnected CRM rows. Migration
`1820_crm_contact_profile_bindings.sql` adds the tenant- and
integration-scoped provider-contact binding, structural composite tenant
foreign keys, inactive lifecycle evidence, RLS, and supporting indexes.
