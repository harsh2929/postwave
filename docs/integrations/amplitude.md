# Amplitude Native Analytics Integration

Last updated: 2026-10-25

## Runtime Status

Amplitude remains `Native / partial` in the catalog, but the implemented Behavioral Cohort export profile-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `amplitude:` request/status/download checkpoints, canonical profile mapping, analytics sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `amplitude_retry:` cursors.

HTTP event ingestion, provider-managed webhooks, reporting/export expansion beyond cohort users, warehouse adapters, provider credential cleanup proof, reconnect/data-delete certification, and live Amplitude project validation remain open.

## Setup

- `provider`: `amplitude`
- `settings.cohort_id`: Behavioral Cohort ID exported by the native puller.
- `credentials_ref`: vault reference containing Amplitude API key or secret material.
- Optional: `project_id`, `api_base_url`.

Raw API credentials are not accepted in settings.

The account needs Behavioral Cohorts API entitlement. The [Amplitude plan comparison](https://amplitude.com/pricing) lists this API as an add-on for Growth and Enterprise, and excludes it from Free and Plus. Free one-time audience syncs are a separate feature and do not qualify this API puller. The current Free QA account returns HTTP 403 for cohort export; keep live certification pending rather than selecting a paid upgrade.

## Free manual fallback

The Free QA account's cohort page successfully exported a CSV using **Export CSV → All configured user properties**. In Moosewave, choose **Migrations → CSV upload**, select that file, and map `gp:email` to Email. The local dry-run on 2026-10-25 recognized the one disposable contact and preserved `amplitude_id`, `user_id`, `library`, and `gp:qa_fixture` as attributes. Missing marketing-consent evidence leaves the contact unconfirmed.

This fallback transfers the exported contacts and properties only; it does not provide automatic cohort updates or certify the native API integration. After provisioning and binding a separate local Listmonk instance and database for the QA workspace, the CSV import completed on 2026-10-25 with one synthetic contact and all four properties preserved. Moosewave kept the contact unconfirmed; Listmonk stored it disabled with no list subscriptions. The existing shared instance received no copy of the contact. Tenant destination access and isolation are still checked before commit writes begin.

## Sync Behavior

Empty sync/backfill calls start or resume Amplitude Behavioral Cohort export. The runtime records request, poll, and file-download checkpoints, maps cohort users into canonical profiles, and preserves Retry-After-aware retry cursors when provider calls fail.

The CSV parser preserves all exported columns as traits with their original names and string values, plus canonical names, phone and identifiers when present. Email uses an exact property match (`email`, `gp:email`, `$email`, or the supported email-address aliases); an email-consent flag cannot become the address. Duplicate headers, malformed records, missing job statuses and unsuccessful export jobs fail rather than certifying a partial import. Downloads exceeding 64 MiB fail, including chunked responses without a Content-Length. Records are parsed individually to avoid retaining a second complete CSV matrix in memory.

The canonical subscriber sink preserves the complete original trait map in system-owned `_analytics_traits`, including `gp:` names and nested values that cannot be auto-registered as custom fields. Compatible scalar keys also remain ordinary custom fields. This preserves export data with the production validator enabled without treating provider-supplied reserved metadata as authoritative.

On 2026-10-25 the actual Free UI export passed canonical database mapping and replay checks: all properties and provider IDs survived, a new profile stayed unconfirmed, replay kept the same subscriber ID, and an existing opt-out was preserved. These are supplemental CSV/sink checks, not a successful native API download or human-witnessed lifecycle evidence. Disposable database tenants were removed.

## Validation Checklist

- Connect with `cohort_id` and `credentials_ref`.
- Run empty sync/backfill and confirm profile rows, run history, and `amplitude:` cursor evidence.
- Confirm disconnected rows reject manual sync/backfill and scheduled pulls skip them.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm event/report/webhook objects are not advertised before live certification.
