# TikTok Ads Customer File Audience Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave's TikTok Audiences connector is a managed audience-destination runtime
for pushing consented list or segment members into TikTok Customer File custom
audiences. It supports credential-reference storage, runtime secret hydration,
targeted-ads consent filtering, SHA-256 email hashing, multipart Customer File
upload, custom-audience create/update calls, bounded Retry-After-aware retry,
on-demand custom-audience readback, and background provider-status polling.

The connector remains partial until live TikTok advertiser certification,
provider-side `REMOVE`/`REPLACE` certification, quota validation, provider-side
cleanup, disconnect, and data-delete behavior are certified.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Audience destinations: `POST /api/v1/audience-destinations`
- Readiness: `POST /api/v1/audience-destinations/tiktok/readiness`
- Manual sync: `POST /api/v1/audience-destinations/{id}/sync`
- Scheduled/manual sync surface: `POST /api/v1/audience-syncs/{id}/run`
- Jobs: `GET /api/v1/audience-destinations/{id}/jobs`
- Job diagnostics: `GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics`

## Setup

1. Store a TikTok Marketing API access token in a Moosewave credential reference.
2. Create an audience destination with `provider=tiktok`, exactly one source
   (`list_id` or `segment_id`), `advertiser_id`, and either `audience_id` for
   updates or `custom_audience_name` for first-time audience creation.
3. Optionally set `action` to `APPEND`, `REPLACE`, or `REMOVE` for existing
   audiences. The default is `APPEND`.
4. Run readiness before the first sync.

Example existing-audience config:

```json
{
  "provider": "tiktok",
  "segment_id": "00000000-0000-4000-8000-000000000123",
  "external_audience_id": "1700000000000000",
  "config": {
    "credential_ref": "vault://integrations/tiktok/audience",
    "advertiser_id": "7000000000000000000",
    "action": "APPEND"
  }
}
```

Example new-audience config:

```json
{
  "provider": "tiktok",
  "segment_id": "00000000-0000-4000-8000-000000000123",
  "config": {
    "credential_ref": "vault://integrations/tiktok/audience",
    "advertiser_id": "7000000000000000000",
    "custom_audience_name": "Moosewave engaged subscribers"
  }
}
```

Example credential secret:

```json
{
  "access_token": "act...."
}
```

## Sync Behavior

The runtime:

- Rejects raw access tokens and tenant-supplied TikTok API host overrides in
  public config.
- Hydrates credential references through the shared runtime secret resolver
  immediately before adapter delivery.
- Applies the activation firewall before hashing so non-consented or suppressed
  profiles do not leave Moosewave.
- Hashes normalized email addresses as SHA-256.
- Uploads newline-delimited hashes to TikTok
  `/dmp/custom_audience/file/upload/` as multipart form-data with
  `calculate_type=FIRST_SHA256` by default.
- Calls `/dmp/custom_audience/update/` for existing audiences or
  `/dmp/custom_audience/create/` when only `custom_audience_name` is provided.
- Retries transient provider 429/5xx/network failures with bounded
  Retry-After-aware backoff.
- Records success, provider HTTP failures, member counts, excluded counts, and
  returned provider request IDs in job/run history.
- Keeps returned request IDs and custom audience IDs as durable provider
  evidence, then initializes background diagnostics when `advertiser_id` is
  present.
- Retrieves provider status through TikTok
  `/dmp/custom_audience/get/` using repeated `custom_audience_ids` query
  parameters, preserving the provider response as diagnostics evidence without
  credential or member-payload data.
- Exposes audience-sync run history with TikTok request evidence, provider
  messages, provider status, provider check timestamps, and
  activation-firewall `excluded_count` through OpenAPI,
  `client.audienceSyncs.runs()`, and `integrations audience-syncs runs <id>`.

## Disconnect Behavior

`DELETE /api/v1/audience-destinations/{id}` marks the local TikTok audience
destination `disconnected`, stops future Moosewave delivery for that destination,
keeps sync job history/provider request evidence, returns `provider_cleanup`,
and persists the same object as `config.provider_cleanup`.

The cleanup evidence is operator-managed (`managed_provider_cleanup=false`).
Moosewave does not delete or clear the TikTok Custom Audience, remove
provider-side membership, revoke Marketing API credentials, or uninstall the app
during this disconnect; those remain TikTok Ads Manager cleanup actions.

## Remaining Native Gaps

- Live TikTok advertiser validation for permissions, audience eligibility,
  quota/rate-limit behavior, minimum audience-size behavior, 4xx/429 responses,
  reconnect, disconnect, token rotation, and data-delete evidence.
- Provider-side audience member removal/replacement certification for `REMOVE`
  and `REPLACE` actions.
- Provider-side OAuth revocation, audience cleanup, and app uninstall evidence.

## Validation Checklist

- Create a destination using only `credential_ref`/`credentials_ref` and confirm
  public reads mask the reference.
- Confirm public create/update rejects `access_token`, `api_base`, and raw token
  aliases in destination config.
- Run readiness with an existing `audience_id` and with a new
  `custom_audience_name`.
- Run a small sync and confirm TikTok receives SHA-256 email rows in multipart
  form-data followed by a custom-audience update/create request.
- Confirm a returned TikTok request ID is stored as provider evidence, sets
  `provider_status=PENDING`, and schedules a provider diagnostics poll when the
  destination has `advertiser_id`.
- Confirm `GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics`
  calls TikTok `/dmp/custom_audience/get/`, sends `custom_audience_ids` as a
  repeated query parameter, and normalizes ready/available provider states to
  `SUCCESS`.
- Confirm `integrations audience-syncs runs <id>` or
  `client.audienceSyncs.runs(id)` shows the run's request evidence and
  `excluded_count` plus provider status once diagnostics has polled.
- Validate failed consent lookup fails closed and records excluded members.
- Validate 4xx/429/5xx provider responses surface in sync job error details.
- Rotate the credential reference and verify the next sync uses the new token.
- Disconnect the destination and confirm the response plus saved config include
  `provider_cleanup` readiness evidence while TikTok-side token/app/audience
  cleanup remains operator-managed.

## Official References

- TikTok Marketing API Audience SDK docs: https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/AudienceApi.md
- Customer File upload: https://business-api.tiktok.com/portal/docs?id=1739940567842818
- Custom Audience create: https://ads.tiktok.com/marketing_api/docs?id=1739940570793985
- Custom Audience update: https://business-api.tiktok.com/portal/docs?id=1739940572667906
- Custom Audience get: https://business-api.tiktok.com/portal/docs?id=1739940507792385
