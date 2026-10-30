# Mixpanel Native Analytics Integration

Last updated: 2026-10-25

## Runtime Status

Mixpanel remains `Native / partial` in the catalog, but the implemented Engage profile-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `mixpanel:` session/page checkpoints, canonical profile mapping, analytics sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `mixpanel_retry:` cursors.

Event import/export expansion, provider-managed webhooks, reporting workers, warehouse adapters, provider credential cleanup proof, reconnect/data-delete certification, and live Mixpanel project validation remain open.

## Setup

- `provider`: `mixpanel`
- `settings.project_id`: Mixpanel project identifier.
- `credentials_ref`: vault reference containing a service-account `username` and `secret`, preferably with read-only project access. A legacy project `api_secret` is also supported. A public project token identifies an ingestion project and does not authorize reading profiles.
- Optional: `region`, `api_base_url`, `page_size`.

Raw API credentials are not accepted in settings.

If an older secret stored a legacy project API secret under `token`, rename that JSON field to `api_secret`. Token-only secrets are now rejected before HTTP; a public ingestion token cannot be converted into read access by renaming it.

The Engage endpoint belongs to Mixpanel's Query API. The [plan comparison](https://mixpanel.com/pricing/) currently lists Query API access as unavailable on Free; check the account's entitlement before creating credentials. Ingestion and event-export access on Free does not establish access to Engage profiles. Do not upgrade the account as part of a no-cost qualification run. See [Mixpanel authentication](https://docs.mixpanel.com/reference/authentication) for the distinction between ingestion project tokens and service accounts.

## Sync Behavior

Empty sync/backfill calls read Mixpanel Engage profiles through `POST /api/query/engage`. The runtime records session and page checkpoints, maps Engage profiles into canonical profiles, and preserves Retry-After-aware retry cursors when provider calls fail.

The project ID stays in the URL query. Pagination uses a form-encoded POST body, as specified by the [Query Profiles API](https://docs.mixpanel.com/reference/engage-query). A full result page continues with the response session and next page, even when `total` is absent or describes only the current payload. Numeric distinct IDs retain their exact digits. Rejected responses, missing result metadata, unexpected page numbers, and full pages without a resumable session fail rather than being recorded as a completed read.

## Validation Checklist

- Connect with `project_id` and `credentials_ref`.
- Run empty sync/backfill and confirm profile rows, run history, and `mixpanel:` cursor evidence.
- Confirm disconnected rows reject manual sync/backfill and scheduled pulls skip them.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm event/report/webhook objects are not advertised before live certification.
