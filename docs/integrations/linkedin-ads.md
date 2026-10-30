# LinkedIn Ads Matched Audiences Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave's LinkedIn Matched Audiences connector is a managed
audience-destination runtime for pushing consented list or segment members into
an existing LinkedIn DMP Segment. It supports credential-reference storage,
runtime secret hydration, targeted-ads consent filtering, SHA-256 email hashing
with LinkedIn-specific whitespace removal, and sequential 5,000-user DMP segment
batch delivery. It also supports bounded Retry-After-aware retry, explicit
REMOVE request construction, per-element batch failure handling, on-demand DMP
segment readback, and background provider-status polling.

The connector remains partial until live LinkedIn Audiences-program
certification, sponsored-account role validation, quota validation, provider-side
cleanup, replacement semantics, disconnect, and data-delete behavior are
certified.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Audience destinations: `POST /api/v1/audience-destinations`
- Readiness: `POST /api/v1/audience-destinations/linkedin/readiness`
- Manual sync: `POST /api/v1/audience-destinations/{id}/sync`
- Scheduled/manual sync surface: `POST /api/v1/audience-syncs/{id}/run`
- Jobs: `GET /api/v1/audience-destinations/{id}/jobs`
- Job diagnostics: `GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics`

## Setup

1. Store a LinkedIn Marketing API access token in a Moosewave credential
   reference.
2. Create or identify the target LinkedIn DMP Segment for Matched Audiences.
3. Create the audience destination with `provider=linkedin`, exactly one
   source (`list_id` or `segment_id`), the sponsored-account `account_id`, the
   target `segment_id`/`external_audience_id`, a credential reference, and
   `audiences_program_approved=true`.
4. Run readiness before the first sync.

Example destination config:

```json
{
  "provider": "linkedin",
  "segment_id": "00000000-0000-4000-8000-000000000123",
  "external_audience_id": "456",
  "config": {
    "credential_ref": "vault://integrations/linkedin/audience",
    "account_id": "urn:li:sponsoredAccount:123",
    "segment_id": "456",
    "audiences_program_approved": true
  }
}
```

Example credential secret:

```json
{
  "access_token": "AQV..."
}
```

## Sync Behavior

The runtime:

- Rejects raw access tokens and tenant-supplied LinkedIn API host overrides in
  public config.
- Hydrates credential references through the shared runtime secret resolver
  immediately before adapter delivery.
- Applies the activation firewall before hashing so non-consented or suppressed
  profiles do not leave Moosewave.
- Lowercases email addresses, removes whitespace, and hashes them as SHA-256
  `SHA256_EMAIL` identifiers.
- Sends `POST /rest/dmpSegments/{segment_id}/users` with
  `X-RestLi-Method: BATCH_CREATE`, `X-Restli-Protocol-Version: 2.0.0`, and
  `LinkedIn-Version: 202606` unless a newer version is supplied through trusted
  resolved config.
- Sends one `ADD` element per hashed email identifier.
- Sends one `REMOVE` element per hashed email identifier when `action=REMOVE`.
- Splits runs above LinkedIn's 5,000-user DMP segment request cap into
  sequential capped requests.
- Retries transient provider 429/5xx/network failures with bounded
  Retry-After-aware backoff.
- Treats per-element batch response failures as provider errors instead of
  silently accepting partial provider rejection.
- Records success, provider HTTP failures, member counts, excluded counts,
  external audience IDs, batch counts, DMP segment readback keys, and partial
  success evidence in audience-destination job and audience-sync run history.
- Stores `external_job_id=dmpSegment:{segment_id}` as the diagnostics key
  because LinkedIn's streaming DMP Segment Users endpoint returns segment-level
  responses rather than durable per-batch request IDs.
- Retrieves provider status through `GET /rest/dmpSegments/{segment_id}` and
  preserves DMP Segment `destinations[].status`, destination segment IDs,
  account/type/source metadata, and any count evidence returned by LinkedIn.
- Initializes background diagnostics when segment evidence is available so
  `provider_status` and provider check timestamps roll into job/run history.

## Disconnect Behavior

`DELETE /api/v1/audience-destinations/{id}` marks the local LinkedIn audience
destination `disconnected`, stops future Moosewave delivery for that destination,
keeps sync job history/provider request evidence, returns `provider_cleanup`,
and persists the same object as `config.provider_cleanup`.

The cleanup evidence is operator-managed (`managed_provider_cleanup=false`).
Moosewave does not delete or clear the LinkedIn DMP Segment, remove provider-side
membership, revoke LinkedIn Marketing API credentials, or uninstall the app
during this disconnect; those remain LinkedIn Campaign Manager cleanup actions.

## Remaining Native Gaps

- Live LinkedIn Audiences-program validation for `rw_dmp_segments`, sponsored
  account roles, DMP segment ownership, quotas, 4xx/429/Retry-After responses,
  reconnect, disconnect, token rotation, and data-delete evidence.
- Provider-side audience member removal certification for `REMOVE` actions.
- Replacement semantics remain outside the local complete slice until LinkedIn
  exposes or certifies a clear-all/replace flow, or Moosewave has an authoritative
  prior-member ledger to remove absent members safely.
- Provider-side OAuth revocation, DMP segment cleanup, and app uninstall
  evidence.

## Validation Checklist

- Create a destination using only `credential_ref`/`credentials_ref` and confirm
  public reads mask the reference.
- Confirm public create/update rejects `access_token`, `api_base`, and raw token
  aliases in destination config.
- Run readiness without `audiences_program_approved` and verify it fails closed.
- Run a small sync and confirm LinkedIn receives `BATCH_CREATE` rows with
  `SHA256_EMAIL` identifiers.
- Run an explicit `REMOVE` sync and confirm LinkedIn receives `REMOVE` elements
  with `SHA256_EMAIL` identifiers.
- Attempt a sync with more than 5,000 deliverable members and confirm it is
  split into sequential capped requests, records the chunk count, and does not
  drop members.
- Simulate a provider error on a later chunk and confirm job/run history keeps
  already-sent member and batch counts.
- Simulate a `200 OK` batch response containing an element-level `400` and
  confirm Moosewave records a provider failure.
- Confirm `GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics`
  calls LinkedIn `GET /rest/dmpSegments/{segment_id}` and normalizes
  destination `READY` status to `SUCCESS`.
- Validate failed consent lookup fails closed and records excluded members.
- Validate 4xx/429/5xx provider responses surface in sync job error details.
- Rotate the credential reference and verify the next sync uses the new token.
- Disconnect the destination and confirm the response plus saved config include
  `provider_cleanup` readiness evidence while LinkedIn-side token/app/audience
  cleanup remains operator-managed.

## Official References

- LinkedIn Matched Audiences: https://learn.microsoft.com/en-us/linkedin/marketing/matched-audiences/matched-audiences?view=li-lms-2026-06
- LinkedIn DMP Segment Users: https://learn.microsoft.com/en-us/linkedin/marketing/matched-audiences/create-and-manage-segment-users?view=li-lms-2026-06
- LinkedIn DMP Segments: https://learn.microsoft.com/en-us/linkedin/marketing/matched-audiences/create-and-manage-segments?view=li-lms-2026-06
