# CRM Live Certification

This checklist certifies the currently live-tested native CRM connector paths:
**HubSpot, Salesforce, Zoho CRM, Microsoft Dynamics 365, Keap**. Pipedrive is
certified separately via its richer harness; see
[pipedrive-live-certification.md](pipedrive-live-certification.md).

## Wave-2 status (2026-06-20)

- **HubSpot** has its local polling and OAuth runtime slice implemented: managed OAuth
  install/refresh/revocation, contact/list/deal-event REST pull, provider-list
  membership evidence, complete-scan stale repair for owned mapped memberships,
  scheduled retries, persisted disconnect cleanup evidence, and the OAuth-install
  app-level webhook runtime (v3 signature, exact appId + portalId routing,
  ambiguity rejection, idempotency). Private-app rows are polling-only. Its
  remaining promotion gate is live HubSpot portal certification, including
  managed-OAuth/private-app behavior, 2026-03 webhook settings and property-level subscription
  reconciliation, list-repair evidence, disconnect refresh-token revocation,
  provider-console cleanup proof, rate-limit behavior, and contact deletion/privacy
  deletion posture.
  Historical coarse membership reconciliation is an optional operator migration,
  and broader deal/account materialization is future product scope.
- **Salesforce** has managed OAuth install/refresh/revocation + a scheduled
  backfill worker. Change Data Capture / Platform-Events streaming (replay IDs)
  is a deliberate follow-on, so it has no webhook check.
- **Zoho CRM, Microsoft Dynamics 365, Keap** now expose
  `native_runtime_complete_live_certification_pending` for their implemented
  read-puller slices. They have local managed OAuth refresh, scheduled retries,
  manual retry-cursor preservation, disconnected-row guards before provider
  calls and local writes, and local disconnect cleanup evidence. Their live
  harnesses still automate only first-page read paths plus manual OAuth/cleanup
  evidence rows, so provider webhooks/object fanout/live cleanup proof remain
  `RuntimeAvailable` gates.

## Honesty boundary — read this first (Zoho / Dynamics / Keap)

These connectors implement a managed REST contact/lead **pull** with
canonical mapping, cursor pagination, managed OAuth refresh, scheduled retries,
manual retry-cursor preservation, Retry-After handling, and local disconnect
cleanup evidence. They do **not** yet implement provider webhook lifecycles or
the broader object/event fanout needed for full runtime availability.

Passing this gate certifies that the implemented read path and required manual
evidence work against a real org. It is a **prerequisite for, not a substitute
for, promotion** to `RuntimeAvailable`. The unified contract may classify the
implemented puller slice as `native_runtime_complete_live_certification_pending`
when local auth, retry, disconnected-row guards, canonical profile writes, and
cleanup evidence are complete. Do not claim provider webhook/object fanout or
flip the catalog row to `RuntimeAvailable` on read-path evidence alone.

## Harness layout

```text
apps/api/internal/integrations/livecert/                 # shared evidence tooling
apps/api/internal/crm_integrations/crm_livecert_test.go  # shared gate, read runner, contract + completeness helpers
apps/api/internal/crm_integrations/hubspot_live_test.go
apps/api/internal/crm_integrations/salesforce_live_test.go
apps/api/internal/crm_integrations/zoho_live_test.go
apps/api/internal/crm_integrations/dynamics365_live_test.go
apps/api/internal/crm_integrations/keap_live_test.go
```

Each connector has three tests:

| Test | Runs | Needs credentials |
| --- | --- | --- |
| `Test<P>LiveCertificationEvidenceContract` | always (CI) | no |
| `Test<P>LiveCertificationBackfillReadPaths` | only when `CRM_LIVE_CERTIFICATION=1` + creds | yes |
| `Test<P>LiveCertificationReportCompleteness` | only when `CRM_LIVE_CERTIFICATION_VALIDATE_REPORT=1` | reads the on-disk report |

There is no webhook-signature test for Zoho/Dynamics/Keap yet because those
provider webhook lifecycles are still follow-on work. Salesforce managed OAuth
is implemented, but the live read-path certification still covers only the
currently automated SOQL paths until OAuth install/refresh/revocation,
CampaignMembers, Tasks, and disconnect cleanup have dedicated live-org evidence.

## Per-connector credentials

All live runs require `CRM_LIVE_CERTIFICATION=1` and a sandbox/developer org.
Objects pulled by the current live read-path tests: HubSpot and Keap = contacts;
Salesforce, Zoho, Dynamics 365 = contacts + leads. Salesforce's runtime also
implements CampaignMember and Task SOQL pulls, but those objects are still listed
as Salesforce certification follow-up until they are exercised against a real
org with representative Campaign/Task data.

| Connector | Required env | Optional env |
| --- | --- | --- |
| HubSpot | `HUBSPOT_ACCESS_TOKEN` | `HUBSPOT_API_BASE_URL`, `HUBSPOT_API_VERSION`, `HUBSPOT_PORTAL_ID` |
| Salesforce | `SALESFORCE_ACCESS_TOKEN`, `SALESFORCE_INSTANCE_URL` | `SALESFORCE_API_VERSION`, `SALESFORCE_ORG_ID` |
| Zoho CRM | `ZOHO_ACCESS_TOKEN`, and one of `ZOHO_API_BASE_URL` / `ZOHO_DATA_CENTER` | `ZOHO_API_VERSION`, `ZOHO_ORGANIZATION_ID` |
| Dynamics 365 | `DYNAMICS365_ACCESS_TOKEN`, `DYNAMICS365_ENVIRONMENT_URL` | `DYNAMICS365_API_VERSION` |
| Keap | `KEAP_ACCESS_TOKEN` | `KEAP_API_BASE_URL`, `KEAP_ACCOUNT_ID` |

## Running a read-path certification (Salesforce shown)

```sh
cd apps/api
CRM_LIVE_CERTIFICATION=1 \
CRM_LIVE_CERTIFICATION_REPORT=../../artifacts/salesforce-live-certification.jsonl \
SALESFORCE_ACCESS_TOKEN=... \
SALESFORCE_INSTANCE_URL=https://yourorg.my.salesforce.com \
go test -count=1 -run 'TestSalesforceLiveCertificationBackfillReadPaths' ./internal/crm_integrations
```

This records `backfill_contacts` and `backfill_leads`. The evidence recorder
drops any token/secret-like detail key, so only counts and cursor presence are
written.

## Manual evidence rows

After witnessing each behavior against the live org, append a row:

```sh
printf '{"provider":"salesforce","check":"manual_data_delete_behavior","status":"passed","recorded_at":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ../../artifacts/salesforce-live-certification.jsonl
```

Required manual rows (every CRM connector):

| Check | What to witness |
| --- | --- |
| `manual_disconnect_cleanup` | `DELETE` the integration; `provider_cleanup` evidence is returned/persisted and local credential/cursor state is cleared |
| `manual_reconnect_resume` | Reconnect resumes from the stored cursor without duplicating contacts |
| `manual_rate_limit_retry_after` | A 429/Retry-After is honored and the retry advances |
| `manual_data_delete_behavior` | A contact/lead delete in the CRM is reflected correctly |
| `manual_credential_rotation` | Rotating the access token keeps the pull healthy |

Additional manual rows by connector:

| Connector | Check | What to witness |
| --- | --- | --- |
| Zoho CRM | `manual_oauth_install` | Managed OAuth install creates a usable Zoho credential reference |
| Zoho CRM | `manual_oauth_refresh` | Managed Zoho refresh produces a valid access token before expiry |
| Zoho CRM | `manual_disconnect_oauth_revocation` | Disconnect revokes the managed Zoho refresh token when present and deletes the local managed OAuth envelope |
| Microsoft Dynamics 365 | `manual_oauth_install` | Managed Microsoft OAuth install creates a usable Dataverse credential reference |
| Microsoft Dynamics 365 | `manual_oauth_refresh` | Managed Microsoft refresh produces a valid access token before expiry |
| Microsoft Dynamics 365 | `manual_local_managed_credential_cleanup` | Disconnect deletes the local managed OAuth envelope and records provider revocation as operator-managed |
| Keap | `manual_oauth_install` | Managed Keap OAuth install creates a usable credential reference when OAuth is used |
| Keap | `manual_oauth_refresh` | Managed Keap refresh produces a valid access token before expiry when OAuth is used |
| Keap | `manual_local_managed_credential_cleanup` | Disconnect deletes the local managed OAuth/PAT/SAK envelope and records provider revocation as operator-managed |

## Read-path gate

```sh
cd apps/api
CRM_LIVE_CERTIFICATION_VALIDATE_REPORT=1 \
CRM_LIVE_CERTIFICATION_REPORT=../../artifacts/salesforce-live-certification.jsonl \
go test -count=1 -run 'TestSalesforceLiveCertificationReportCompleteness' ./internal/crm_integrations
```

A green run certifies the current live-tested read path plus required manual
evidence rows. Promotion to `RuntimeAvailable` remains gated on the remaining
provider webhook/object-fanout/live-cleanup work per the honesty boundary above.
