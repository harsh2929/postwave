# Snapchat Ads Audience Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Moosewave's Snap Audiences connector is a managed audience-destination runtime
for pushing consented list or segment members into an existing Snap audience
segment. It supports credential-reference storage, runtime secret hydration,
targeted-ads consent filtering, SHA-256 email hashing, nested `EMAIL_SHA256`
payload rows, returned request-id evidence, and sequential 100,000-user segment
batch delivery. It also supports bounded Retry-After-aware retry, explicit
REMOVE/REPLACE request construction, on-demand segment readback, and background
provider-status polling.

The connector remains partial until live Snap account certification,
provider-side remove/replace certification, quota validation, provider-side
cleanup, disconnect, and data-delete behavior are certified.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Audience destinations: `POST /api/v1/audience-destinations`
- Readiness: `POST /api/v1/audience-destinations/snap/readiness`
- Manual sync: `POST /api/v1/audience-destinations/{id}/sync`
- Scheduled/manual sync surface: `POST /api/v1/audience-syncs/{id}/run`
- Jobs: `GET /api/v1/audience-destinations/{id}/jobs`
- Job diagnostics: `GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics`

## Setup

1. Store a Snap Marketing API access token in a Moosewave credential reference.
2. Create or identify the target Snap audience segment.
3. Create the audience destination with `provider=snap`, exactly one source
   (`list_id` or `segment_id`), the `ad_account_id`, the target
   `segment_id`/`external_audience_id`, and a credential reference.
4. Run readiness before the first sync.

Example destination config:

```json
{
  "provider": "snap",
  "segment_id": "00000000-0000-4000-8000-000000000123",
  "external_audience_id": "seg_123",
  "config": {
    "credential_ref": "vault://integrations/snap/audience",
    "ad_account_id": "acc_123",
    "segment_id": "seg_123"
  }
}
```

Example credential secret:

```json
{
  "access_token": "snap-access-token"
}
```

## Sync Behavior

The runtime:

- Rejects raw access tokens and tenant-supplied Snap API host overrides in
  public config.
- Hydrates credential references through the shared runtime secret resolver
  immediately before adapter delivery.
- Applies the activation firewall before hashing so non-consented or suppressed
  profiles do not leave Moosewave.
- Lowercases and trims email addresses, then hashes them as SHA-256
  `EMAIL_SHA256` identifiers.
- Sends `POST /v1/segments/{segment_id}/users` with
  `users[].schema=["EMAIL_SHA256"]` and nested `users[].data` rows.
- Sends `DELETE /v1/segments/{segment_id}/users` for explicit `REMOVE`
  actions and `DELETE /v1/segments/{segment_id}/all_users` followed by capped
  add batches for explicit `REPLACE` actions.
- Splits runs above Snap's 100,000-user segment-user request cap into
  sequential capped requests.
- Retries transient provider 429/5xx/network failures with bounded
  Retry-After-aware backoff.
- Records success, provider HTTP failures, member counts, excluded counts,
  external audience IDs, returned request IDs, batch counts, and partial success
  evidence in audience-destination job and audience-sync run history.
- Retrieves provider status through `GET /v1/segments/{segment_id}` and
  preserves Snap's `status`, `upload_status`, `targetable_status`, and audience
  size evidence without credential or member-payload data.
- Initializes background diagnostics when request/segment evidence is available
  so `provider_status` and provider check timestamps roll into
  audience-destination job and audience-sync run history.

## Disconnect Behavior

`DELETE /api/v1/audience-destinations/{id}` marks the local Snap audience
destination `disconnected`, stops future Moosewave delivery for that destination,
keeps sync job history/provider request evidence, returns `provider_cleanup`,
and persists the same object as `config.provider_cleanup`.

The cleanup evidence is operator-managed (`managed_provider_cleanup=false`).
Moosewave does not delete or clear the Snap audience segment, remove
provider-side membership, revoke Snap Marketing API credentials, or uninstall
the app during this disconnect; those remain Snap Ads Manager cleanup actions.

## Remaining Native Gaps

- Live Snap account validation for OAuth scopes, ad-account access, segment
  ownership, quotas, 4xx/429/Retry-After responses, reconnect, disconnect,
  token rotation, and data-delete evidence.
- Provider-side audience member removal or replacement certification for
  `REMOVE` and `REPLACE` actions.
- Provider-side OAuth revocation, segment cleanup, and app uninstall evidence.

## Validation Checklist

- Create a destination using only `credential_ref`/`credentials_ref` and confirm
  public reads mask the reference.
- Confirm public create/update rejects `access_token`, `api_base`, and raw token
  aliases in destination config.
- Run readiness without `ad_account_id`, `segment_id`, or credential refs and
  verify it fails closed.
- Run a small sync and confirm Snap receives nested `EMAIL_SHA256` rows.
- Attempt a sync with more than 100,000 deliverable members and confirm it is
  split into sequential capped requests, records the chunk count, and does not
  drop members.
- Run explicit `REMOVE` and `REPLACE` syncs and confirm the documented Snap
  DELETE endpoints are called without storing raw identifiers.
- Simulate a provider error on a later chunk and confirm job/run history keeps
  already-sent member count, batch count, and request-id evidence.
- Confirm `GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics`
  calls Snap `GET /v1/segments/{segment_id}` and normalizes
  `upload_status=COMPLETE` plus `targetable_status=READY` to `SUCCESS`.
- Validate failed consent lookup fails closed and records excluded members.
- Validate 4xx/429/5xx provider responses surface in sync job error details.
- Rotate the credential reference and verify the next sync uses the new token.
- Disconnect the destination and confirm the response plus saved config include
  `provider_cleanup` readiness evidence while Snap-side token/app/segment
  cleanup remains operator-managed.

## Official References

- Snap Customer Lists: https://developers.snap.com/api/marketing-api/Ads-API/audience-creation/customer-lists
