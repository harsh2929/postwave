# Google Ads Customer Match Native Integration

Catalog status: `Native / partial`.

Implementation depth: `native_runtime_complete_live_certification_pending` for
the Google Data Manager Customer Match audience-destination slice.

Moosewave's Google Ads Customer Match connector is a managed audience-destination
runtime for pushing consented segment or list members to an existing Customer
Match list. It supports credential-reference storage, runtime secret hydration,
targeted-ads consent filtering, SHA-256 email hashing, default Google Data
Manager API upload delivery, explicit Data Manager member-removal delivery, and
provider request-status diagnostics.

The connector remains catalog-partial until live Google Ads/Data Manager account
validation, cleanup posture, token/account-link handling, and data-delete
behavior are certified. Legacy `OfflineUserDataJobService` and Google Lead Form
Extensions are separate partial surfaces and are not part of this Data Manager
Customer Match promotion.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/google-ads/connect/start`, `POST /api/v1/integrations/google-ads/connect/callback`
- Facade sync/pause/disconnect: `POST /api/v1/integrations/google-ads/sync`, `POST /api/v1/integrations/google-ads/pause`, `DELETE /api/v1/integrations/google-ads`
- Audience destinations: `POST /api/v1/audience-destinations`
- Readiness: `POST /api/v1/audience-destinations/google_ads/readiness`
- Manual sync: `POST /api/v1/audience-destinations/{id}/sync`
- Scheduled/manual sync surface: `POST /api/v1/audience-syncs/{id}/run`
- Jobs: `GET /api/v1/audience-destinations/{id}/jobs`
- Job diagnostics: `GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics`

## Supported Transports

### Data Manager API

Use this for new Customer Match integrations. New Moosewave-created rows default
to this transport when no legacy `offline_user_data_job` evidence is present.

Set `customer_match_transport` to `data_manager` or omit the transport for a
new row. The default operation sends
`POST https://datamanager.googleapis.com/v1/audienceMembers:ingest` with:

- `destinations[].operatingAccount.accountType=GOOGLE_ADS`
- `destinations[].productDestinationId` from `user_list_id`
- `audienceMembers[].compositeData.userData.userIdentifiers[].emailAddress`
- request-level `consent`
- `encoding=HEX`
- `termsOfService.customerMatchTermsOfServiceStatus=ACCEPTED`

Set `customer_match_operation=remove` to send
`POST https://datamanager.googleapis.com/v1/audienceMembers:remove` for explicit
member cleanup batches using the same destination and SHA-256 HEX user-data
shape. Moosewave does not claim a provider-side "remove all / replace all"
operation because Google's Data Manager Customer Match upgrade guidance does not
support that legacy remove-all behavior.

A single Data Manager `audienceMembers:ingest` request is capped at 10,000
members; Moosewave uses the same cap for remove batches. Larger runs are chunked
into sequential Data Manager requests inside the existing audience-sync run cap,
preserving every returned request ID for diagnostics. Transient 429, 5xx, and
network failures retry per chunk with bounded backoff and `Retry-After`
awareness before the run is marked failed.

### Legacy Google Ads API

Existing eligible/allowlisted integrations can still opt into the Google Ads API
`OfflineUserDataJobService` path by setting
`customer_match_transport=offline_user_data_job`, or by preserving an old row
that already has `offline_user_data_job` evidence. This path remains explicitly
gated by `offline_user_data_job_worker_attached=true` because full
create/add/run/poll job lifecycle and partial-failure telemetry are not part of
the Data Manager local-complete slice.

## Setup

1. Create or identify the target Customer Match user list in Google Ads or Data
   Manager.
2. Store Google credentials in a Moosewave credential reference. For Data Manager
   uploads the resolved secret must include `access_token`. Legacy Google Ads API
   uploads also need `developer_token`.
3. Create the audience destination with `provider=google_ads`, exactly one
   source (`list_id` or `segment_id`), the target `user_list_id`, `customer_id`,
   consent fields, `customer_match_transport=data_manager` or omitted transport
   for the default Data Manager path, a credential reference, and
   `customer_match_terms_accepted=true`.
4. Use readiness before the first sync.

Example destination config:

```json
{
  "provider": "google_ads",
  "segment_id": "00000000-0000-4000-8000-000000000123",
  "external_audience_id": "123456789",
  "config": {
    "credential_ref": "vault://integrations/google-ads/data-manager",
    "customer_id": "1234567890",
    "customer_match_transport": "data_manager",
    "customer_match_terms_accepted": true,
    "ad_user_data_consent": "granted",
    "ad_personalization_consent": "granted"
  }
}
```

Example credential secret:

```json
{
  "access_token": "ya29..."
}
```

## Sync Behavior

The runtime:

- Rejects raw access tokens, raw developer tokens, and tenant-supplied Google
  Ads/Data Manager API host overrides in public config.
- Desktop Google Ads destination setup defaults new connections to
  `customer_match_transport=data_manager`, captures the required ad-user-data
  and ad-personalization consent values, and requires an explicit Customer
  Match terms acknowledgement before readiness can pass.
- Hydrates credential references through the shared runtime secret resolver
  immediately before adapter delivery.
- Applies the activation firewall before hashing so non-consented or suppressed
  profiles do not leave Moosewave.
- Hashes normalized email addresses as SHA-256 HEX.
- Sends chunked Data Manager `audienceMembers:ingest` payloads by default, or
  `audienceMembers:remove` payloads when `customer_match_operation=remove`, with
  each request capped at 10,000 members.
- Retries transient Data Manager 429, 5xx, and network failures with bounded
  `Retry-After`-aware backoff; auth/config 4xx responses fail fast.
- Stores a raw Data Manager `requestId` for single-request runs, or compact
  multi-request ID evidence for chunked runs, as `external_job_id` on
  destination-job and audience-sync run history.
- Retrieves provider status on demand through Google Data Manager
  `requestStatus:retrieve` for each stored request ID. Diagnostics are
  intentionally limited to `customer_match_transport=data_manager`; legacy
  OfflineUserDataJob rows are not treated as Data Manager request IDs.
- Polls due Data Manager request IDs in the background, parses
  `requestStatusPerDestination[].requestStatus`, rolls up `SUCCESS`,
  `PROCESSING`, `FAILED`, and `PARTIAL_SUCCESS` results into job/run history,
  and schedules bounded follow-up checks while requests remain non-terminal.
- Keeps legacy Google Ads API `OfflineUserDataJobService` uploads behind an
  explicit worker gate outside the Data Manager local-complete claim.
- Records success, provider HTTP failures, member counts, and excluded counts in
  the audience sync job history, including `provider_status`,
  `provider_checked_at`, `provider_next_check_at`, and
  `provider_poll_attempts` for async provider evidence.
- Exposes the same provider polling fields on `GET
  /api/v1/audience-destinations/{id}/jobs` through OpenAPI, the TypeScript SDK,
  desktop API types, and the CLI job table.
- Exposes audience-sync run history with provider request IDs, provider status,
  checked/next poll timestamps, poll attempts, and activation-firewall
  `excluded_count` through OpenAPI, `client.audienceSyncs.runs()`, and
  `integrations audience-syncs runs <id>`.

## Disconnect Behavior

`DELETE /api/v1/audience-destinations/{id}` marks the local Google Ads audience
destination `disconnected`, stops future Moosewave delivery and background Data
Manager status polling for that destination, keeps sync job history/provider
request evidence, returns `provider_cleanup`, and persists the same object as
`config.provider_cleanup`.

The cleanup evidence is operator-managed (`managed_provider_cleanup=false`).
Moosewave does not delete or clear the Customer Match user list, revoke OAuth or
developer-token access, or change Google Ads/Data Manager account links during
this disconnect; those remain Google account cleanup actions.

## Remaining Certification Gates

- Live Data Manager account validation for OAuth scopes, account links, Customer
  Match eligibility, quotas, reconnect/disconnect behavior, token rotation, and
  provider error responses.
- Provider-side OAuth revocation, account-link cleanup, list deletion, and data
  delete evidence remains operator-managed and needs live cleanup certification.
- Data Manager member removal is implemented through `audienceMembers:remove`,
  but provider-side replace-all/list recreation remains an operator-managed or
  future product decision because the current Data Manager path does not support
  legacy remove-all semantics.

## Separate Partial Surfaces

- Legacy OfflineUserDataJob create/add/run/poll worker with partial-failure
  telemetry remains unavailable until that explicit fallback worker is attached.
- Legacy OfflineUserDataJob diagnostics and partial-failure telemetry remain
  unavailable until the full create/add/run/poll lifecycle is attached.
- Google Lead Form Extensions are documented separately; that lead-capture
  source has manual and scheduled GoogleAdsService.Search pullers for
  `lead_form_submission_data`, while provider-side webhooks and live Google Ads
  validation remain separate work.

## Validation Checklist

- Create a destination using only `credential_ref`/`credentials_ref` and confirm
  public reads mask the reference.
- Confirm public create/update rejects `access_token`, `developer_token`,
  `api_base`, and `data_manager_api_base` in destination config.
- Run readiness with Data Manager config and verify missing terms fail closed.
- Run a small audience sync and confirm Data Manager receives SHA-256 HEX email
  identifiers, consent, `encoding=HEX`, and accepted Customer Match terms.
- Run an explicit `customer_match_operation=remove` audience sync and confirm
  Data Manager receives `audienceMembers:remove`, SHA-256 HEX identifiers, and
  no upload-only consent/terms block.
- Confirm the Data Manager response `requestId` is stored as `external_job_id`
  on the job/run history, then call the job diagnostics endpoint and verify it
  returns the provider `requestStatus:retrieve` response.
- Confirm background polling advances `provider_poll_attempts`, stores
  `provider_status`, backs off while provider status is `PROCESSING`, and stops
  scheduling checks on terminal statuses such as `SUCCESS` or `FAILED`.
- Confirm `integrations audience-syncs runs <id>` or
  `client.audienceSyncs.runs(id)` shows the same provider telemetry on
  scheduled/manual audience-sync runs.
- Confirm legacy `offline_user_data_job` rows with `external_job_id` do not get
  initialized as Data Manager diagnostics targets.
- Attempt a Data Manager sync with more than 10,000 deliverable members and
  confirm it is split into sequential capped requests, records the chunk count,
  and stores all returned request IDs.
- Simulate a 429/`Retry-After` or 5xx Data Manager upload response followed by
  success and confirm retry-attempt evidence is recorded without losing request
  IDs from accepted chunks.
- Validate failed consent lookup fails closed and records excluded members.
- Validate 4xx/429/5xx provider responses surface in sync job error details.
- Rotate the credential reference and verify the next sync uses the new token.
- Disconnect the destination and confirm the response plus saved config include
  `provider_cleanup` readiness evidence while Google-side token/account/list
  cleanup remains operator-managed.

## Official References

- Google Data Manager Customer Match: https://developers.google.com/data-manager/api/devguides/audiences/google-ads/customer-match
- Data Manager `audienceMembers:ingest`: https://developers.google.com/data-manager/api/reference/rest/v1/audienceMembers/ingest
- Data Manager `requestStatus:retrieve`: https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve
- Data Manager `Destination`: https://developers.google.com/data-manager/api/reference/rest/v1/Destination
- Data Manager `UserData`: https://developers.google.com/data-manager/api/reference/rest/v1/UserData
- Data Manager `Consent`: https://developers.google.com/data-manager/api/reference/rest/v1/Consent
- Customer Match support changes: https://ads-developers.googleblog.com/2026/03/changes-to-customer-match-support-in.html
