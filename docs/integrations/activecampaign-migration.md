# ActiveCampaign Migration Source

Status: Migration-only adapter with delegated native-foundation handoff support.

ActiveCampaign also has a separate `activecampaign` native-foundation row for provider lifecycle, credential-reference storage, required account API URL capture, pause/disconnect, run history, and delegated handoff evidence. This `activecampaign-migration` tile remains the API v3 cutover surface.

## Setup

Create or reference an ActiveCampaign API token and account API URL in the secure credential store, then create the migration job through the migration flow. The migration API accepts the account URL as `account_id`, `extra.api_url`, `extra.account_api_url`, `extra.account_url`, or `extra.base_url`; a bare account host and a URL ending in `/api/3` both normalize to the API v3 root. HTTPS hosts with exactly one account label under `api-us1.com` or `activehosted.com` are accepted by default. When the Developer tab supplies another provider-issued host, a deployment operator can add that exact DNS hostname to the comma-separated `ACTIVECAMPAIGN_ALLOWED_API_HOSTS` allowlist. The URL must still use HTTPS on port 443 and `/api/3`; IPs, localhost, unconfigured hosts, credential-bearing URLs, queries/fragments, and cross-host redirects are rejected. Allowlist entries are hostnames only, without schemes, ports, paths, or wildcards.

ActiveCampaign API URL/token credentials are user-specific account credentials, so use a dedicated migration user and keep that user active through dry-run, commit, shadow monitoring, final delta import, and rollback validation. Authentication reads `/users/me`; the resulting account fingerprint is bound to the job so a reconnect cannot silently switch the same migration to another ActiveCampaign account. Built-in hostname aliases for the same account share an identity; an operator-authorized custom hostname uses its exact canonical host as the stable identity and rate-limit key.

The native provider row can store `migration_job_id`, `source_event_job_id`, and source-event cursor fields so `/api/v1/marketing-integrations/{id}/sync` can record `activecampaign_handoff` evidence.

## Coverage

Runtime imports:

- email-addressable contacts with phone, custom fields, source IDs, tags, channel-specific list evidence, and unsubscribed/inactive/bounce audit fields
- lists as tag-backed Moosewave segments for active memberships classified as email; this preserves targeting structure even when exclusion coverage is incomplete, while the subscriber remains unconfirmed. A non-active or conflicting status on the same list suppresses its tag. Because ActiveCampaign can separately exclude an address that remains active on a list and API v3 has no documented complete exclusion inventory, operator reconciliation must remove affected targeting tags before activation. Saved-segment summaries from `/audiences` and definitions from `/segmentsV2/{id}` remain review-only unless safely translated
- completed campaign archive hydrated from campaign detail plus linked message HTML/text; a row with missing expected content fails rather than becoming an apparently complete archive item
- changed-contact source events drained through immutable lower/upper update-time windows in ascending contact ID order

Contacts with no complete email-channel and exclusion evidence import as unconfirmed rather than immediately sendable subscribers. A known active email-list tag expresses source membership for segment matching; it is not consent or permission to send. A list status of active and its `sdate` are retained as provenance, not treated as email or SMS consent proof. SMS-only memberships do not grant email list tags or email sendability; malformed or unknown-channel memberships never grant sendability. Email-less and phone-only contacts are preserved as source review evidence and are not fabricated into the email-keyed subscriber destination.

Preserved for rebuild/review:

- automation summaries and available blocks, goals, linked campaigns, and SMS relationships as rebuild ledger definitions; no ActiveCampaign automation is materialized into Moosewave runtime before rebuild/testing
- saved-segment predicates from the current audiences/segmentsV2 contract
- message/template records
- forms
- CRM deals and pipelines
- available custom-object schemas and records; record/relationship completeness requires explicit review
- available ecommerce connections, customers, orders, and per-order products; catalogs, abandoned carts, and executable commerce triggers are not claimed
- SMS broadcasts and available recipient/metric evidence from `/sms/broadcasts`; this is archive-only and does not establish SMS consent

If an optional preservation endpoint is unavailable, the migration report surfaces a `source_archive_warnings` entry and pilot acceptance blocks until permissions are fixed, the migration is rerun, or the operator records explicit cutover sign-off. Warning-only markers do not count as imported source archive records.

Large base exports use ActiveCampaign's recommended ID pagination shape (`orders[id]=ASC` plus `id_greater`) instead of offset pagination. Delta/source-event reads fix lower and upper update-time bounds, bind the resumable cursor to those bounds and the verified provider account, paginate the immutable window by ID, and advance the high-water mark to its upper bound only after every page succeeds. Because ActiveCampaign documents `updated_after` and `updated_before` as date values, the provider query widens both UTC date edges and the adapter filters hydrated contacts against the exact inclusive timestamp window. It advances the ID cursor over conservative false positives and internally drains all-skipped pages, so no row is lost and callers never receive an empty page with a continuation cursor. The traversal does not depend on undocumented `orders[udate]` behavior or mutable offset pagination.

Changed-contact traversal does not prove source deletions: a hard-deleted
contact can disappear without producing a row, and equal aggregate totals can
hide a deletion behind an addition. The final shadow check blocks when the
current email-addressable inventory is lower than the imported inventory, but
strict cutover always requires the operator to compare imported source IDs,
their email mapping, and their source-owned tag/list mapping with a reviewed
final ActiveCampaign export/audit,
disable destination identities whose source contact was removed or whose prior
email became stale after a source email change, require exactly one current
identity per source ID, and remove targeting tags covered by reconciled
exclusions. Changed contacts replay at their current email but do not
automatically retire that prior destination email. For contacts returned by the
provider, same-source deltas do automatically replace provider-owned tags and
custom fields while preserving local/different-source data. This review is recorded through
`activecampaign_consent_exclusion_review`; deletion reconciliation is not
claimed as automatic runtime behavior.

Phone-only/email-less changed-contact events remain `applied=false` because no
email subscriber is fabricated. They carry a separate row-level
`review_status`: use
`PATCH /v1/migrations/{job_id}/source-events/{event_id}/review` with
reconciliation detail and a non-secret evidence reference after handling the
contact. This clears only an intentional `manual_review` result; it cannot
waive a failed automatic subscriber upsert, and later source changes create new
pending results.

## Boundaries

This surface does not claim native ActiveCampaign webhooks, writeback, provider-side cleanup automation, OAuth/public app installation, editable template reconstruction, landing-page import, hosted-form publishing, live SMS sending, ecommerce-trigger execution, custom-object-trigger execution, or live certification. Promote the separate native `activecampaign` row only after those provider behaviors are implemented and certified.

Before cutover, run shadow monitoring, source-event monitoring, final delta import, pilot acceptance, rollback rehearsal, sender/domain readiness, automation rebuild review, channel-consent/exclusion and source-contact identity reconciliation, and dedicated migration-credential reset/disconnect review. Operators can exercise the executable portions through `pnpm test:migrations:live` with the `ACTIVECAMPAIGN_*` flags documented in `services/migration/README.md`.

Live source-event proof uses resumable `prepare`, `finish`, and cleanup-only phases. `ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=prepare` commits an isolated job, performs the first clean sync, and retains the enabled monitor/job; its confidential artifact records the job ID. After at least seven days of successful scheduled polling, resolve every pending row-level review and run `finish` with that exact secret-backed `ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID` and polling interval. Finish performs a read-only continuous-overlap, unresolved-row, and rollback-headroom check before another source sync or final delta. The headroom covers the complete final-delta/rate-limit/grace budget plus a separate rollback-cleanup wait. Any final-delta/shadow/review/pilot blocker writes retryable evidence and leaves the job and monitor intact.

After strict pilot acceptance passes, Moosewave persists server-authorized cleanup evidence bound to the latest final delta and overlap snapshot. While valid, that marker freezes source-event sync/review, final delta, shadow checks and monitor restart, automation rebuild evidence, rollback rehearsal, other cutover evidence, and ActiveCampaign credential refresh/reconnect. To reopen evidence, change the cleanup marker to `warning` or `blocker` before cleanup starts. Cleanup uses `DELETE /v1/migrations/{job}/source-events?post_pilot_cleanup=1`; while holding the shared job lease, the server revalidates the marker, records durable cleanup start, and then disables the monitor. The lease serializes cleanup against marker revocation, and once cleanup start is durable, later revocation is refused. The harness then reads back the disabled monitor and cleanup-start claim before rollback. Monitor disable is crash-safe and retryable rather than a single database transaction with the marker write. A failed/timeout rollback leaves the monitor disabled and remains retryable through `ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=cleanup`, without rerunning source sync, final delta, shadow checks, reviews, or pilot gates. Credential-cleanup evidence is a sanitized harness artifact, not a server mutation, and is recorded only after a fresh job read proves durable `rolled_back` state and a cleared rollback deadline. ActiveCampaign base and final-delta commits retain a fourteen-day rollback window so the mandatory seven-day overlap cannot consume the cleanup deadline.

The official workflow dispatch exposes only the phase selector. Retrieve the retained ID from the protected prepare artifact and store it as the `ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID` repository/environment secret; the workflow intentionally has no plain job-ID input or log message.

Strict pilot certification requires `ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1` plus a non-secret `ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF`, and also requires `ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW=1` plus `ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF`. A production-ready claim still requires preserving the resulting live account, verification, consent/exclusion/contact-identity, pilot acceptance, continuous source-event, rollback rehearsal, rollback, and credential-cleanup evidence.

Before requesting pilot acceptance, resolve every pending
`activecampaign_non_email_contact manual_review` row in the migration dashboard
or through its row-level review endpoint. Preserve handling detail and a
non-secret artifact/ticket reference for each result.
