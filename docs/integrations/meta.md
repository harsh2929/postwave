# Meta Custom Audiences Native Integration

Catalog status: `Native / partial`.

Moosewave's Meta Custom Audiences connector is a managed audience-destination
runtime for pushing consented segment or list members to an existing Meta Custom
Audience. It supports credential-reference storage, runtime secret hydration,
targeted-ads consent filtering, SHA-256 email hashing, and Graph API
`/{audience_id}/users` delivery with sequential batches capped at 10,000 hashed
members per request.

The local runtime is complete for the current credential-resolution, consent
firewall, Graph delivery, retry, run-history, and operator-managed cleanup
evidence slice. The connector remains partial until live Meta app review,
ad-account permission, quota, reconnect, disconnect, and data-delete behavior
are certified.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Unified connection status: `GET /api/v1/integrations/connections`
- Facade connect start/callback: `POST /api/v1/integrations/meta/connect/start`, `POST /api/v1/integrations/meta/connect/callback`
- Facade sync/pause/disconnect: `POST /api/v1/integrations/meta/sync`, `POST /api/v1/integrations/meta/pause`, `DELETE /api/v1/integrations/meta`
- Audience destinations: `POST /api/v1/audience-destinations`
- Readiness: `POST /api/v1/audience-destinations/meta/readiness`
- Manual sync: `POST /api/v1/audience-destinations/{id}/sync`
- Scheduled/manual sync surface: `POST /api/v1/audience-syncs/{id}/run`
- Jobs: `GET /api/v1/audience-destinations/{id}/jobs`

## Setup

1. Create or identify the target Custom Audience in Meta Business Manager.
2. Store a Meta ads access token in a Moosewave credential reference. JSON
   secrets may use `access_token`; raw string secrets are treated as the access
   token.
3. Create the audience destination with `provider=meta`, exactly one source
   (`list_id` or `segment_id`), the Meta audience id, and `credential_ref` or
   `credentials_ref`.
4. Use readiness to confirm the audience id and token reference resolve before
   running the first sync.

Example destination config:

```json
{
  "provider": "meta",
  "segment_id": "00000000-0000-4000-8000-000000000123",
  "external_audience_id": "23850000000000000",
  "config": {
    "credential_ref": "vault://integrations/meta/ads-token"
  }
}
```

Example credential secret:

```json
{
  "access_token": "EAAB..."
}
```

## Sync Behavior

The runtime:

- Rejects raw access tokens and tenant-supplied Graph API host overrides in
  public config.
- Hydrates credential references through the shared runtime secret resolver
  immediately before adapter delivery.
- Applies the activation firewall before hashing so non-consented or suppressed
  profiles do not leave Moosewave.
- Hashes normalized email addresses as `EMAIL_SHA256`.
- Posts to Meta Graph API v25.0 at `/{audience_id}/users`, splitting large
  audiences into 10,000-member request chunks.
- Retries transient 429, 5xx, and network chunk failures with bounded backoff
  and `Retry-After` awareness before marking the sync failed.
- Records success, provider HTTP failures, member counts, batch counts,
  excluded counts, and safe Meta response counters such as `num_received`,
  `num_invalid_entries`, and invalid sample count in the audience sync job
  history. Invalid entry samples and member payloads are not persisted. If a
  later chunk fails, the sync result preserves how many members and batches were
  accepted before the provider error.

## Disconnect Behavior

`DELETE /api/v1/audience-destinations/{id}` marks the local Meta audience
destination `disconnected`, stops future Moosewave delivery for that destination,
keeps sync job history/provider request evidence, returns `provider_cleanup`,
and persists the same object as `config.provider_cleanup`.

The cleanup evidence is operator-managed (`managed_provider_cleanup=false`).
Moosewave does not delete the Meta Custom Audience, remove provider-side
membership, revoke tokens, uninstall apps, or change ad-account permissions
during this disconnect; those remain Meta Business/admin cleanup actions.

## Remaining Native Gaps

- Live Meta app review and permission evidence for Custom Audiences usage.
- Ad-account quota and rate-limit certification using real Meta responses.
- Provider-side audience deletion or membership remove behavior remains
  operator-managed and needs live cleanup certification.
- Provider-side token revocation/app uninstall/ad-account cleanup remains
  operator-managed and needs live cleanup certification.
- Facebook Lead Ads is documented separately at
  `docs/integrations/facebook-lead-ads.md`; it now has explicit Graph
  `/{form_id}/leads` REST pull support plus signed leadgen webhook ingest with
  managed Page `leadgen` subscription reconciliation/cleanup and lead-ID
  follow-up fetches, while page/form ownership certification and live app-review
  evidence remain open.
  This runbook covers Custom Audiences only.

## Validation Checklist

- Create a destination using only `credential_ref`/`credentials_ref` and confirm
  public reads mask the reference.
- Run readiness with a real credential reference and verify it reaches
  `configured`.
- Run a small audience sync and confirm Meta receives `EMAIL_SHA256` rows.
- Run an audience above 10,000 deliverable members and confirm Moosewave sends
  multiple capped `/{audience_id}/users` requests and records batch counts.
- Confirm Meta success responses add `num_received` and invalid-entry count
  evidence to `provider_message` without storing invalid entry samples.
- Simulate a 429/`Retry-After` or 5xx response followed by success and confirm
  the run records retry-attempt evidence without duplicate accepted members.
- Validate failed consent lookup fails closed and records excluded members.
- Validate 4xx/429/5xx Meta responses surface in sync job error details.
- Rotate the credential reference and verify the next sync uses the new token.
- Disconnect the destination and confirm the response plus saved config include
  `provider_cleanup` readiness evidence while Meta-side token/app/audience
  cleanup remains operator-managed.

## References

- Meta Custom Audience Users API: https://developers.facebook.com/docs/marketing-api/reference/custom-audience/users/
