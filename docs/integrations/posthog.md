# PostHog Native Analytics Integration

Last updated: 2026-10-25

## Runtime Status

PostHog remains `Native / partial` in the catalog, but the implemented Persons profile-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, PostHog next-page checkpoints, canonical profile mapping, analytics sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `posthog_retry:` cursors.

Event capture expansion, provider-managed webhooks, reporting/query workers, warehouse adapters, provider credential cleanup proof, and human-witnessed lifecycle certification remain open.

## Setup

- `provider`: `posthog`
- `settings.project_id`: PostHog project identifier.
- `credentials_ref`: vault reference containing a personal API key with `person:read` access to the selected project. The public project capture token is used for ingestion and does not establish access to the Persons read API.
- Optional: `host`, `api_base_url`, `page_size`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read PostHog Persons through `GET /api/projects/{project_id}/persons`. The runtime follows bounded provider pagination, stores PostHog next-page checkpoints, maps person properties into canonical profiles, and preserves Retry-After-aware retry cursors when provider calls fail.

Person IDs support current cloud UUID strings and older numeric IDs, with an explicit `uuid` preferred when present. On 2026-10-25, a single synthetic person exposed and verified the UUID-string compatibility fix through the real API. The local QA database then verified the imported email, names, traits, provider identity and unconfirmed status. The disposable tenant was removed after the automated lifecycle checks. These results supplement the required human-witnessed certification evidence; the catalog remains partial.

A subsequent free pagination check used two synthetic cloud persons with `page_size=1`. Disconnecting after the first persisted page blocked local and scheduled writes; reconnecting resumed the saved cursor, finished three real API pages (including the terminal empty page), and persisted exactly two unique profiles. Its disposable local tenant was removed. Both synthetic cloud persons remain available for future QA.

The live browser connection exposed a custom-field validation failure for PostHog's `$geoip_*` properties. The subscriber sink now retains the original provider JSON in system-owned `_analytics_traits`; compatible scalar properties also remain ordinary custom fields. Provider-supplied underscore keys cannot overwrite Moosewave's reserved metadata. Live database checks now include the production custom-field validator. A failed or partially applied provider page retains a retry checkpoint in connect-time, manual, and scheduled backfills; connect-time draining stops until the failed writes recover.

A manual sync requested before a retry deadline returns `deferred` without a provider request or a new completed run. It preserves the existing error and retry checkpoint. Connect-time retries respect the same deadline without clearing failure evidence.

## Validation Checklist

- Connect with `project_id` and `credentials_ref`.
- Run empty sync/backfill and confirm profile rows, run history, and PostHog cursor evidence.
- Confirm disconnected rows reject manual sync/backfill and scheduled pulls skip them.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm event/report/webhook objects are not advertised before live certification.
