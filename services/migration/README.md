# services/migration — Pillar 1

Owns ESP migration: ActiveCampaign, HubSpot, Mailchimp, Customer.io,
Kit, Brevo, Substack (official ZIP/CSV export), Beehiiv,
MailerLite, Klaviyo, Sendy CSV exports, generic CSV, and named CSV imports for
AWeber, Bento, Campaign Monitor, Constant Contact, Drip, Flodesk, Loops and
Omnisend (20 paths in total). Each adapter
normalizes to the canonical schema in `packages/schema/` and writes
through the Listmonk HTTP API — never via Go imports (see
`LICENSE-BOUNDARY.md`). Job records, cursors, OAuth states, and encrypted
source sessions are persisted when Postgres is configured. Accepted dry-runs
and commits are restart-resumable: the service scans durable runnable jobs at
startup and on a short interval, then continues from the stored cursor. Live
rollback counters remain process-local, but rollback itself is idempotent and
can be retried from the completed job.

## Persistence

`internal/jobstore/postgres.go` provides `PostgresJobStore`, a Postgres-
backed implementation of the `MigrationJobStore` interface. It writes
through to the `migration_jobs` table from
`infra/migrations/0004_migration_jobs.sql` using the request tenant to set the
RLS scope on every id-only read/write. `MemoryJobStore` remains for tests and
explicit local fallback; `main.go` selects Postgres only after a successful pool
ping and otherwise fails startup unless `POSTWAVE_ALLOW_MEMORY_FALLBACK=1`.
OAuth CSRF states are single-use rows in `migration_oauth_states`. Source
sessions are encrypted with `POSTWAVE_MIGRATION_SESSION_KEK` before storage in
`migration_sessions`, so source reconnects are not required after a service
restart. Source sessions default to a 30-day encrypted retention window; static
ActiveCampaign API-token sessions and HubSpot Service Key / existing-token bridge sessions
use a 90-day window so review work and a 7-14 day source-event shadow can
complete before final delta without forcing an avoidable reconnect. If an
adapter returns a shorter provider expiry, that expiry wins except for Kit v4
OAuth: its rotating access/refresh pair is retained encrypted for 30 days and
refreshed under a durable lock before source work.
ActiveCampaign credential-job responses intentionally redact the account API
host in `account_id`; the raw account host and API URL remain only in the
encrypted source session used for subsequent source reads.
HTTPS account hosts with exactly one account label under `api-us1.com` or
`activehosted.com` are accepted by default. If ActiveCampaign's Developer tab
provides a different provider-issued hostname, an operator may authorize that
exact DNS hostname through `ACTIVECAMPAIGN_ALLOWED_API_HOSTS`. Every accepted
URL must still use HTTPS on port 443 and `/api/3`; IP literals, localhost,
userinfo, queries, fragments, unconfigured hosts, and cross-host redirects are
rejected before `Api-Token` can be sent. Authentication calls
`/users/me` and binds the provider-issued account fingerprint to the migration
job; reconnect, commit, final delta, shadow, and source-event operations reject
credentials for a different ActiveCampaign account even when its hostname has
changed between the two supported domains.
Customer.io uses a Bearer App API key, not a Track API key. Authentication
requires an explicit numeric workspace ID returned by `/v1/workspaces` and an
exact `us` or `eu` region. The encrypted session and job cursor retain the
workspace/region binding and a non-secret fingerprint; reconnect, commit,
final delta, and shadow operations fail if credentials resolve to a different
workspace. Provider redirects are rejected so the App API key is never
forwarded to another host.
`GET /v1/migrations/{job_id}` includes `source_session_expires_at` when a
still-valid encrypted source session exists. Mailchimp jobs also include
non-secret `selected_audience_ids` when the customer scoped the migration to
specific audiences. Those IDs are also copied into the job cursor so recent,
review, and detail pages can confirm scope even after the source session
expires. The dashboard blocks dry-run, commit, final delta import,
shadow-monitor start, and source-event replay when the saved source session is
missing, expired, or near expiry so the customer can reconnect before a long
source read or cutover check starts. For ActiveCampaign and HubSpot bridge jobs,
the dashboard treats the final 14 days as near expiry so the 7-14 day
source-event shadow and final delta work do not start close to the credential
cliff; the migration API enforces the same near-expiry preflight before source
discovery, dry-run, commit, final delta import, direct shadow checks, shadow
monitoring, or source-event monitoring. ActiveCampaign and HubSpot recovery
refresh the existing migration job's encrypted source session instead of
creating a replacement job, including from the new-migration wizard's
discovery/review steps.

## Architecture

```
HTTP handler  ──>  adapters.Registry  ──>  source Adapter (mailchimp / convertkit / ...)
                                              │
                                              ├── OAuth + rate-limited HTTP
                                              └── canonical.{Subscriber,Segment,Automation,...}
                                                              │
                                                              v
                                                       Listmonk HTTP API
```

All adapters implement the `adapters.Adapter` interface
(`internal/adapters/adapter.go`):

- `Capabilities()` — feature matrix advertised to the UI
- `Authenticate(ctx, Credentials)` — OAuth code → `Session`
- `Discover(ctx, sess)` — pre-flight totals
- `ListSubscribers / ListSegments / ListAutomations / ListCampaignArchive / ListPaidSubs`
  — cursor-paginated pulls in canonical form

Adapters self-register from their `init()` so adding a new ESP is one new
package.

## Supported sources

| Source         | Auth                        | Subs      | Segments  | Automations                      | Archive                                 | Paid Subs            | Status                                                                               |
| -------------- | --------------------------- | --------- | --------- | -------------------------------- | --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| ActiveCampaign | API token + API URL         | yes       | partial   | source-definition rebuild review | yes + source archive evidence           | no                   | implemented foundation; forms/templates/CRM/ecommerce/SMS require rebuild/sign-off   |
| HubSpot        | Service Key / existing token           | yes       | snapshots | no                               | no                                      | no                   | Portal-bound CRM bridge with exact email preferences, frozen list tags, and hard cutover gates |
| Mailchimp      | OAuth2                      | yes       | yes       | yes                              | yes + editable templates/source archive | no                   | implemented with audience selection and cutover gates                                |
| Customer.io    | App API key + workspace     | yes       | snapshots | rebuild review only              | sent email newsletters + source archive | no                   | implemented with exact full snapshots, workspace binding, and cutover gates          |
| ConvertKit     | OAuth2                      | yes       | yes       | yes                              | yes                                     | via Stripe           | implemented                                                                          |
| Substack       | CSV or official export ZIP  | yes; source-active remains unconfirmed | no | no                    | email-sent posts + matching HTML/stats   | no; tier metadata only | implemented export path; billing handoff remains manual                              |
| Beehiiv        | API key                     | yes       | frozen snapshots | rebuild review only              | eligible sent posts + reports           | no; tier metadata only | assisted beta; exact publication binding and live rehearsal required                 |
| MailerLite     | API token                   | yes       | groups runtime; saved rules rebuild | rebuild review only                | sent metadata/plain text/variants + reports; drafts/ready preserved; no rendered HTML | no                   | assisted beta; exact live-account rehearsal still required                            |
| Brevo          | API key                     | yes       | yes       | yes                              | yes                                     | no                   | implemented                                                                          |
| Sendy          | CSV upload                  | yes       | no        | no                               | no                                      | no                   | implemented as CSV export because Sendy's official API has no full subscriber export |
| CSV            | upload                      | yes       | n/a       | n/a                              | n/a                                     | n/a                  | implemented                                                                          |

`Paid Subs = via Stripe` applies only to adapters that advertise the capability.
Substack deliberately does not: an account ID alone cannot prove publication,
product, customer, or entitlement ownership, and Apple in-app purchases are a
separate payment rail.
`GET /sources` preserves the historical `supports.automations` boolean, but
also emits `supports.automation_mode`; sources including ActiveCampaign,
Beehiiv, Klaviyo, Customer.io, and MailerLite set `rebuild_review` when source
definitions are preserved for owner review
rather than activated as runtime Moosewave automations. Customer.io segment and
subscription-topic membership is an exact final-snapshot projection; provider
predicates do not continue evaluating after cutover.

ActiveCampaign and HubSpot bridge discovery are required preflights. HubSpot
authentication binds the job to the provider-reported portal ID and returns
only `[redacted-hubspot-portal]` to clients. Its private app needs
`crm.objects.contacts.read`, `crm.schemas.contacts.read`, `crm.lists.read`,
`subscriptions-definition-read`, and `subscriptions-status-read`. The adapter
uses the `2026-03` account-info, CRM objects/properties/lists, and
communication-preferences APIs and requests only
`dataSensitivity=non_sensitive` property values. If ActiveCampaign `/contacts`
counting fails, or if HubSpot cannot read exact contacts, non-sensitive
property definitions, exact list membership and allowlisted structural list
metadata, active email subscription
definitions, per-contact subscription statuses plus portal/brand-wide opt-outs,
or the API budget needed to complete that snapshot, discovery and dry-run/commit
fail instead of returning guessed zeroes or partial sendability evidence.
HubSpot also fails closed above 1,000,000 contacts, 10,000 traversal pages,
64 MiB of aggregate retained snapshot data, or 10,000 results in one
changed-contact CRM Search window. The last condition requires more frequent
polling or a narrower search window; truncated search results never count as
overlap evidence. Full discovery probes daily API usage before preference
reads and requires two reads per email-addressable contact plus a reserve of
`max(1000, 5% of the daily limit)`. Requests are chunked at 100 contacts per
contact page/preference batch, 100 properties, and 500 list rows.
Other ActiveCampaign inventory counts are best-effort and attach
discovery warnings when a plan, permission, or endpoint shape prevents counting
optional surfaces such as forms, CRM, custom objects, ecommerce, or SMS.

ActiveCampaign saved-segment summaries use `/audiences` and hydrate raw
definitions through `/segmentsV2/{id}`; list-backed segments are executable,
while unsafe saved predicates remain rebuild-only. An active membership in a
known email list receives the matching targeting tag even when exclusion
coverage is incomplete, but that contact remains unconfirmed until the
separate sendability review passes; a non-active or conflicting status on the
same list suppresses that tag. Because an ActiveCampaign exclusion may coexist
with an active list status and API v3 does not expose a documented complete
exclusion inventory, the cutover review must remove any affected targeting
tags before activation. Completed campaign rows are
hydrated through campaign detail plus linked message content. Automation
summaries are enriched with available blocks, goals, linked campaigns, and SMS
relationships but remain rebuild definitions rather than runtime rows. SMS
inventory uses `/sms/broadcasts` and stays archive-only. Available custom-object
schemas and records plus ecommerce connections, customers, orders, and
per-order products are preserved. This does not claim coverage for every
custom-object relationship, ecommerce catalog, abandoned cart, or executable
commerce trigger.

## Translator (write side)

`internal/translator/listmonk` is the WRITE half of the migration pipeline.
It takes canonical resources and materialises them via Listmonk's admin HTTP
API and Moosewave-owned tables.

| Resource         | Where it lands                                        | Notes                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscribers      | Listmonk `/api/subscribers` (upsert)                  | Tags + provenance flow into `subscribers.attribs` (JSONB)                                                                                                                                                                                                       |
| Lists            | Listmonk `/api/lists`                                 | Public/private + opt-in style preserved                                                                                                                                                                                                                         |
| Segments         | Compiled to parameterised Postgres SQL fragment       | Listmonk segmentation is raw SQL against `subscribers`                                                                                                                                                                                                          |
| Templates        | Listmonk `/api/templates`                             | Campaign HTML body                                                                                                                                                                                                                                              |
| Automations      | Moosewave-owned `automations` table                    | Listmonk has no automation runtime; `services/automation` executes                                                                                                                                                                                              |
| Campaign archive | Moosewave-owned `campaign_archive` table               | Read-only sent-campaign history; never re-sent                                                                                                                                                                                                                  |
| Source archive   | Moosewave-owned `migration_source_archive_items` table | Read-only preservation for source records Moosewave does not execute natively yet, including ActiveCampaign CRM/deals and explicit parity-gap rows from other source adapters. HubSpot-backed pilots keep CRM in HubSpot rather than archiving it into Moosewave. |

ActiveCampaign and HubSpot subscriber writes use source-authoritative status
only for matched rows during base import/final delta/source-event replay: the
existing Listmonk row must already carry the same source platform and source
contact ID before an incoming source status can re-enable or otherwise replace
the destination status. Unrelated local suppressions keep the stricter
destination status and receive protected-source evidence so later deltas cannot
re-enable them accidentally.

For the same ActiveCampaign source contact, final-delta and source-event writes
also treat the current provider snapshot as authoritative for provider-owned
tags and custom fields. Removed contact tags and inactive/removed list-targeting
tags are deleted from both Listmonk and Moosewave, and removed source fields no
longer linger; locally curated or different-source tags and fields are
preserved. This applies only to contacts the provider returns. Hard-deleted
contacts and stale pre-change email identities still require the final stable-
source-ID reconciliation described below.

ActiveCampaign list status and `sdate` are retained as audit provenance but do
not establish email or SMS consent. Unknown channel or incomplete exclusion
evidence stays unconfirmed; preserving a known active email-list targeting tag
does not make that subscriber sendable. SMS-only activity never grants email sendability,
and email-less/phone-only contacts are preserved as
`activecampaign_non_email_contact` review evidence instead of being written to
the email-keyed subscriber destination.

Mailchimp additionally imports editable templates from `/templates` plus
`/templates/{id}/default-content`, writes Mailchimp tags into native Listmonk
subscriber tags and provenance attributes, preserves richer fetched
campaign-report payloads in migration resource metadata, and materializes
signup-form, landing-page, and ecommerce-store evidence as paused/draft
Moosewave records for rebuild/audit. Customer Journeys are never materialized:
Mailchimp exposes trigger actions but no supported general Journey graph
inventory/export endpoint, so the service records one explicit manual-review
gap instead. Discovery returns Mailchimp audiences as
`{id,name,subscribers_total}`. `POST /mailchimp/dry-run` and
`POST /mailchimp/commit` require non-empty `selected_audience_ids`; dry-run
persists the authoritative normalized scope and commit must repeat it exactly.
Audience-bound reads are limited to those lists, invalid IDs fail source reads,
and account-global surfaces are labeled instead of silently importing
everything as though it were selected.

Per `LICENSE-BOUNDARY.md` the translator package contains zero upstream or
downstream Listmonk source imports; it uses HTTP only. CI enforces the rule.

## HTTP API

All routes mounted at `/v1/migrations`:

Non-health routes are sidecar-internal. Set `POSTWAVE_INTERNAL_API_TOKEN`
in deployed environments; callers must send `Authorization: Bearer <token>`.
When unset, non-health routes only accept loopback requests for local dev.

| Method | Path                                        | Purpose                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                                         | list recent jobs for the tenant                                                                                                                                                                                                                                                                                       |
| GET    | `/sources`                                  | list source adapter capability matrix                                                                                                                                                                                                                                                                                 |
| GET    | `/capabilities`                             | backwards-compatible alias for `/sources`                                                                                                                                                                                                                                                                             |
| POST   | `/{source}/oauth/start`                     | returns `{authorize_url, state}`                                                                                                                                                                                                                                                                                      |
| GET    | `/{source}/oauth/callback`                  | exchanges `code`, creates job                                                                                                                                                                                                                                                                                         |
| POST   | `/{source}/credentials`                     | create a job from API-key/private-app credentials                                                                                                                                                                                                                                                                     |
| PUT    | `/{source}/uploads/{upload_id}`             | upload one resumable CSV/export chunk                                                                                                                                                                                                                                                                                 |
| POST   | `/{source}/uploads/{upload_id}/complete`    | validate uploaded bytes and create a job                                                                                                                                                                                                                                                                              |
| POST   | `/{source}/discover`                        | synchronous pre-flight count                                                                                                                                                                                                                                                                                          |
| POST   | `/{source}/shadow-check`                    | rerun source discovery against a connected job and flag cutover deltas/manual-review blockers                                                                                                                                                                                                                         |
| POST   | `/sources/{source}/shadow-monitor`          | enable periodic shadow checks for a pilot overlap window and run the first check immediately                                                                                                                                                                                                                          |
| POST   | `/sources/{source}/source-events`           | enable incremental source-event polling and run the first sync immediately                                                                                                                                                                                                                                            |
| POST   | `/{source}/dry-run`                         | 202 + `job_id`; runs Discover + Verification; Mailchimp requires non-empty `selected_audience_ids` and persists them as authoritative scope                                                                                                                                                                           |
| POST   | `/{source}/commit`                          | 202 + `job_id`; runs full migration; Mailchimp requires the exact normalized audience scope approved by dry-run                                                                                                                                                                                                       |
| POST   | `/{source}/delta-import`                    | 202 + `job_id`; idempotently replays an authenticated job after source-side changes                                                                                                                                                                                                                                   |
| GET    | `/{job_id}`                                 | poll job status, including non-secret `source_session_expires_at` and selected Mailchimp audience IDs when available                                                                                                                                                                                                  |
| DELETE | `/{job_id}`                                 | cancel a pending/running migration; response includes progress and rollback availability                                                                                                                                                                                                                              |
| GET    | `/{job_id}/events`                          | SSE stream of job snapshots                                                                                                                                                                                                                                                                                           |
| POST   | `/{job_id}/source-session`                  | refresh an existing job's encrypted source session from new credentials without creating a new migration                                                                                                                                                                                                              |
| GET    | `/{job_id}/verification`                    | full `VerificationReport` JSON                                                                                                                                                                                                                                                                                        |
| GET    | `/{job_id}/shadow-monitor`                  | read monitor state and recent shadow-check history                                                                                                                                                                                                                                                                    |
| DELETE | `/{job_id}/shadow-monitor`                  | disable periodic shadow checks                                                                                                                                                                                                                                                                                        |
| GET    | `/{job_id}/source-events`                   | read source-event monitor state and recent captured events                                                                                                                                                                                                                                                            |
| DELETE | `/{job_id}/source-events`                   | disable source-event polling                                                                                                                                                                                                                                                                                          |
| PATCH  | `/{job_id}/source-events/{event_id}/review` | record or reopen row-level evidence for an intentionally unapplied manual-review event; automatic replay failures cannot be waived                                                                                                                                                                                    |
| GET    | `/{job_id}/pilot-acceptance`                | hard-gate acceptance report for first-customer cutover                                                                                                                                                                                                                                                                |
| PATCH  | `/{job_id}/cutover-evidence`                | record allow-listed ActiveCampaign cutover evidence such as consent/exclusion, deliverability, audience-schema, campaign-archive-fidelity, review-surface, discovery-warning, and source-archive-warning sign-off, plus an SMS-readiness marker clients must submit only after the separate readiness endpoint passes |
| GET    | `/{job_id}/rollback-rehearsal`              | verify rollback window and delete order before cutover                                                                                                                                                                                                                                                                |
| GET    | `/{job_id}/automation-rebuilds`             | top unsupported automations that must be rebuilt/tested                                                                                                                                                                                                                                                               |
| PATCH  | `/{job_id}/automation-rebuilds`             | update one automation rebuild status                                                                                                                                                                                                                                                                                  |
| POST   | `/{job_id}/rollback`                        | 202; kicks off rollback as a background task                                                                                                                                                                                                                                                                          |
| GET    | `/{job_id}/rollback-status`                 | live rollback progress (poll while running)                                                                                                                                                                                                                                                                           |
| GET    | `/{job_id}/audit`                           | operator audit/debug rows for a migration                                                                                                                                                                                                                                                                             |

ActiveCampaign and HubSpot source-event monitor responses intentionally redact
raw source-event IDs and scrub event payloads before returning JSON. The raw
stored records remain internal so changed-contact replay can keep stable dedupe
and retry semantics without exposing provider contact IDs or emails through the
API.

## Environment

| Var                                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                | HTTP listener (default 8081)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POSTWAVE_INTERNAL_API_TOKEN`                         | bearer token for non-health routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POSTWAVE_API_URL`                                    | Moosewave application API base URL exposing `/api/v1/sms/pilot-readiness`; required when `ACTIVECAMPAIGN_LIVE_SMS_READINESS=1`                                                                                                                                                                                                                                                                                                                                                                                             |
| `POSTWAVE_API_KEY`                                    | tenant-scoped Moosewave application API key with `read:reports`, used only to query SMS pilot readiness; required when `ACTIVECAMPAIGN_LIVE_SMS_READINESS=1` and never replaced by the migration service's internal token                                                                                                                                                                                                                                                                                                  |
| `OAUTH_REDIRECT_URI`                                  | absolute URL configured with each provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAILCHIMP_CLIENT_ID/SECRET`                          | Mailchimp OAuth app. Mailchimp Marketing API OAuth tokens follow the approving user's role and do not use granular read-only scopes in this authorize URL.                                                                                                                                                                                                                                                                                                                                                                |
| `MAILCHIMP_ACCESS_TOKEN` + `MAILCHIMP_DC`             | optional live-certification direct-token path for `pnpm test:migrations:live`; `MAILCHIMP_ACCOUNT_ID` may be used instead of `MAILCHIMP_DC`                                                                                                                                                                                                                                                                                                                                                                               |
| `MAILCHIMP_AUDIENCE_IDS`                              | comma-separated, explicitly reviewed audience IDs; required whenever live Mailchimp dry-run or commit certification is enabled, and never inferred from discovery order                                                                                                                                                                                                                                                                                                                                                   |
| `MAILCHIMP_LIVE_DRY_RUN`                              | set to `1` to make `scripts/validate-live-migrations.mjs` run a selected-audience Mailchimp dry-run and verify the report                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MAILCHIMP_LIVE_COMMIT`/`ROLLBACK`                    | set both to `1` only against an isolated tenant/Listmonk/Postgres stack to certify commit followed by rollback cleanup                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LISTMONK_TENANT_MODE`                                | legacy single-destination mode: `dedicated` is required unless `LISTMONK_TENANT_ROUTES` supplies an isolated destination; shared subscriber storage cannot accept commits                                                                                                                                                                                                                                                                                                                                                               |
| `LISTMONK_DEDICATED_TENANT_ID`                        | exact Moosewave tenant UUID bound to this dedicated Listmonk deployment; must match the authenticated migration tenant before any destination mutation                                                                                                                                                                                                                                                                                                                                                                     |
| `POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR`                | optional directory where live-certification JSON evidence is written; required whenever ActiveCampaign, HubSpot, Beehiiv, Klaviyo, or Customer.io live certification flags are enabled; `MIGRATION_LIVE_ARTIFACT_DIR` is accepted as an alias                                                                                                                                                                                                                                                                             |
| `MIGRATION_LIVE_ARTIFACT_RUN_ID`                      | optional stable run id used in live-certification artifact filenames                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MIGRATION_LIVE_WAIT_MS`                              | optional live-certification wait budget for migration jobs and rollback polling; defaults to 15 minutes                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MIGRATION_LIVE_RATE_LIMIT_MAX_WAIT_MS`               | optional extra wait budget when a migration job is paused by provider rate limiting; defaults to 30 minutes                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MIGRATION_LIVE_RATE_LIMIT_GRACE_MS`                  | optional grace window added after a provider `Retry-After` timestamp before the live harness times out; defaults to 60 seconds                                                                                                                                                                                                                                                                                                                                                                                            |
| `ACTIVECAMPAIGN_API_URL`                              | optional live-certification ActiveCampaign account API URL for `pnpm test:migrations:live`; must use HTTPS/443 and either a built-in one-label `api-us1.com`/`activehosted.com` host or an exact hostname authorized through `ACTIVECAMPAIGN_ALLOWED_API_HOSTS`                                                                                                                                                                                                                                                           |
| `ACTIVECAMPAIGN_ALLOWED_API_HOSTS`                    | optional comma-separated allowlist of exact provider-issued DNS hostnames copied from ActiveCampaign's Developer tab when they fall outside the built-in domains; use hostnames only (no scheme, port, path, wildcard, IP, localhost, or empty entry)                                                                                                                                                                                                                                                                     |
| `ACTIVECAMPAIGN_API_TOKEN`                            | optional live-certification ActiveCampaign API token; `ACTIVECAMPAIGN_API_KEY` is accepted as a compatibility alias                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ACTIVECAMPAIGN_LIVE_DRY_RUN`                         | set to `1` to run ActiveCampaign discovery plus dry-run and verify the generated report                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ACTIVECAMPAIGN_LIVE_SHADOW_CHECK`                    | set to `1` with dry-run or commit to rerun ActiveCampaign source discovery against the verified migration job and compare current source totals                                                                                                                                                                                                                                                                                                                                                                           |
| `ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS`                   | set to `1` in the retained `prepare`, `finish`, and retry-only `cleanup` phases; ActiveCampaign no longer accepts one immediate sync followed by monitor cleanup as live-certification evidence                                                                                                                                                                                                                                                                                                                           |
| `ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE`              | required with ActiveCampaign source-event certification: `prepare` retains a committed job/monitor, `finish` reuses it after seven days, and `cleanup` resumes only post-pilot rollback/monitor cleanup without rerunning source sync or final delta                                                                                                                                                                                                                                                                      |
| `ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID`             | required for `finish` and `cleanup`; exact retained job ID is written only to the confidential prepare artifact and supplied to the official workflow as a repository/environment secret, never a dispatch input                                                                                                                                                                                                                                                                                                          |
| `ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_INTERVAL_SECONDS`   | source-event polling interval used by prepare/finish; defaults to 900 seconds. Finish must use the retained monitor's exact interval so a configuration change cannot reset or counterfeit continuous-overlap evidence.                                                                                                                                                                                                                                                                                                   |
| `ACTIVECAMPAIGN_LIVE_DELTA_IMPORT`                    | required in `finish`; runs final delta against the retained completed base import only after the continuous source-event preflight and clean final sync pass                                                                                                                                                                                                                                                                                                                                                              |
| `ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE`                | set to `1` with commit, source-event replay, final delta import, post-delta shadow check, rollback rehearsal, consent/exclusion evidence, deliverability evidence, manual-review sign-off, and verified SMS readiness when SMS inventory is detected; fails certification unless the final report is `pass`                                                                                                                                                                                                               |
| `ACTIVECAMPAIGN_LIVE_ROLLBACK_REHEARSAL`              | set to `1` with commit to verify rollback rehearsal before rollback cleanup; ActiveCampaign live certification requires a `pass` rehearsal; cleanup is still attempted if rehearsal fails                                                                                                                                                                                                                                                                                                                                 |
| `ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW`        | set to `1` only after the operator reconciles email/SMS consent by channel, ActiveCampaign exclusions, email-less contact handling, and the final source-ID-to-email plus source-owned tag/list mappings; compare imported mappings with a reviewed final source export/audit, disable destination identities for removed contacts or stale pre-change emails, require exactly one current identity per source ID, and remove exclusion-covered targeting tags before recording `activecampaign_consent_exclusion_review` |
| `ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF`  | required with consent/exclusion review; a non-secret ticket/artifact/screenshot/runbook reference. The harness rejects references containing email addresses, ActiveCampaign API URLs, token-like fields, passwords, or credentials.                                                                                                                                                                                                                                                                                      |
| `ACTIVECAMPAIGN_LIVE_DELIVERABILITY_REVIEW`           | set to `1` after operator-held DNS/sender evidence is attached to the confidential cutover record; records `activecampaign_deliverability_review` before pilot acceptance                                                                                                                                                                                                                                                                                                                                                 |
| `ACTIVECAMPAIGN_LIVE_MANUAL_REVIEW_SIGNOFF`           | set to `1` after operator-held rebuild/out-of-scope evidence is attached for ActiveCampaign audience-schema, saved-segment, automation, template, form, custom-object, ecommerce, CRM, campaign-archive-fidelity, discovery-warning, and source-archive-warning rows; never records `sms_readiness`                                                                                                                                                                                                                       |
| `ACTIVECAMPAIGN_LIVE_SMS_READINESS`                   | set to `1` when ActiveCampaign SMS inventory is detected to query `/api/v1/sms/pilot-readiness`; the harness records `sms_readiness` only after `can_pilot=true` and every returned check passes, never as an operator waiver or blanket manual sign-off                                                                                                                                                                                                                                                                  |
| `ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW`       | set to `1` after the operator resets/revokes the dedicated ActiveCampaign migration credential, verifies follow-up source access fails safely or shows reconnect guidance, and attaches that evidence to the confidential cutover record                                                                                                                                                                                                                                                                                  |
| `ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF` | required with credential cleanup review; a non-secret reference such as a ticket ID, artifact filename, screenshot bundle name, or runbook record ID pointing to the API-token reset/disconnect proof. The harness rejects references containing emails, ActiveCampaign API URLs, token-like fields, passwords, or credentials.                                                                                                                                                                                           |
| `ACTIVECAMPAIGN_LIVE_FAIL_ON_DISCOVERY_WARNINGS`      | set to `1` during representative account certification to fail when ActiveCampaign optional count endpoints return discovery warnings                                                                                                                                                                                                                                                                                                                                                                                     |
| `ACTIVECAMPAIGN_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS` | set to `1` during representative account certification to fail when optional source archive endpoints return preservation warnings; the discovery warning flag also enables this strict mode                                                                                                                                                                                                                                                                                                                              |
| `ACTIVECAMPAIGN_LIVE_COMMIT`/`ROLLBACK`               | for `prepare`, set `COMMIT=1` and leave `ROLLBACK` unset; for `finish`/`cleanup`, leave `COMMIT` unset and set `ROLLBACK=1`. Server-authorized cleanup pauses replay, disables and verifies the monitor, then starts rollback; credential-cleanup evidence requires durably persisted rollback success.                                                                                                                                                                                                                   |
| `HUBSPOT_PRIVATE_APP_TOKEN`                           | optional existing HubSpot token; prefer `HUBSPOT_SERVICE_KEY` for new setup; `HUBSPOT_ACCESS_TOKEN` remains an alias                                                                                                                                                                                                                                                                                                                                                                                                        |
| `HUBSPOT_HUB_ID`                                      | optional numeric Hub ID used as an expected portal selector; the provider identity response must match it, while the API/harness exposes only `[redacted-hubspot-portal]`; `HUBSPOT_ACCOUNT_ID` is accepted as an alias                                                                                                                                                                                                                                                                                                      |
| `HUBSPOT_LIVE_REQUIRE_FULL_CERTIFICATION`             | set to `1` for scheduled hard certification; credentials/discovery or a one-shot monitor cannot pass, and the retained prepare/finish/cleanup workflow must prove at least seven continuous days                                                                                                                                                                                                                                                                                                                            |
| `HUBSPOT_LIVE_SOURCE_EVENT_PHASE` / `..._JOB_ID`      | use `prepare` to retain the committed job and monitor, `finish` with that job ID after at least seven days to run final snapshot and strict gates, and `cleanup` only to resume authorized cleanup                                                                                                                                                                                                                                                                                                                          |
| `HUBSPOT_LIVE_DRY_RUN`                                | set to `1` in `prepare` to run exact HubSpot discovery plus dry-run and verify the generated bridge report                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `HUBSPOT_LIVE_COMMIT`/`ROLLBACK`                      | for `prepare`, set `COMMIT=1` and leave `ROLLBACK` unset; for `finish`/`cleanup`, leave `COMMIT` unset and set `ROLLBACK=1`. Cleanup requires durable strict-pilot authorization, disables replay, clears the local source session, persists both markers, completes rollback, then permits external token cleanup evidence.                                                                                                                                    |
| `HUBSPOT_LIVE_SHADOW_CHECK`                           | set to `1` with dry-run or commit to rerun HubSpot source discovery against the verified bridge job and compare current source totals                                                                                                                                                                                                                                                                                                                                                                                     |
| `HUBSPOT_LIVE_SOURCE_EVENTS`                          | retained changed-contact polling during the overlap; it does not detect list-membership-only changes, preference-only changes, deletions, or a contact losing email, so it can never replace the final full snapshot                                                                                                                                                                                                                                                                                                         |
| `HUBSPOT_LIVE_DELTA_IMPORT`                           | set to `1` in `finish`; reruns the authoritative full contact/list/preference snapshot before final shadow/pilot gates                                                                                                                                                                                                                                                                                                                                                                                                   |
| `HUBSPOT_LIVE_PILOT_ACCEPTANCE`                       | set to `1` in `finish` with replay, final full snapshot, shadow check, rollback rehearsal, manual scope review, and cleanup evidence; strict certification requires `pass` and does not allow warning acknowledgment as a consent bypass                                                                                                                                                                                                                                                                                    |
| `HUBSPOT_LIVE_ROLLBACK_REHEARSAL`                     | set to `1` with commit to verify the durable rollback rehearsal before rollback cleanup; required for HubSpot bridge pilot acceptance certification                                                                                                                                                                                                                                                                                                                                                                       |
| `HUBSPOT_LIVE_MANUAL_REVIEW_SIGNOFF` / `..._EVIDENCE_REF` | set to `1` with a non-secret evidence reference after reviewing all excluded identity/property, dynamic-list-rule, and unsupported product checklist rows against the latest final snapshot                                                                                                                                                                                                                                                                                                                              |
| `HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW`              | set to `1` after the operator revokes, rotates, or intentionally retains the dedicated HubSpot private app token and verifies follow-up source access behavior                                                                                                                                                                                                                                                                                                                                                            |
| `HUBSPOT_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF`        | required with HubSpot credential cleanup review; a non-secret reference such as a ticket ID, artifact filename, screenshot bundle name, or runbook record ID pointing to the private-app-token cleanup proof                                                                                                                                                                                                                                                                                                              |
| `HUBSPOT_LIVE_SOURCE_EVENT_INTERVAL_SECONDS`          | optional HubSpot source-event monitor interval for live certification; defaults to 900 seconds                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `HUBSPOT_LIVE_FAIL_ON_DISCOVERY_WARNINGS`             | set to `1` during representative account certification to fail when HubSpot discovery returns adapter warnings                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CUSTOMERIO_API_KEY`                                  | dedicated Customer.io App API key for live certification; Track API keys are not accepted                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CUSTOMERIO_WORKSPACE_ID` + `CUSTOMERIO_REGION`       | required numeric workspace ID returned by `/v1/workspaces` and exact `us` or `eu` API region; the harness verifies that the credential response preserves this binding                                                                                                                                                                                                                                                                                                                                                    |
| `CUSTOMERIO_LIVE_REQUIRE_FULL_CERTIFICATION`          | set to `1` for scheduled certification; credentials/discovery alone cannot pass, and the harness requires dry-run, commit, final full snapshot, post-delta shadow, destination-state rollback rehearsal, pilot acceptance, rollback, warning gates, reviews, cleanup evidence, and a durable enabled-mode artifact                                                                                                                                                                                                        |
| `CUSTOMERIO_LIVE_DRY_RUN`                             | set to `1` to run strict Customer.io capability, exact inventory, fifteen-row discovery-matrix, and dry-run verification checks                                                                                                                                                                                                                                                                                                                                                                                           |
| `CUSTOMERIO_LIVE_COMMIT`/`ROLLBACK`                   | set both to `1` only against an isolated tenant/Listmonk/Postgres stack; every committed certification attempts rollback cleanup even when a post-commit gate fails                                                                                                                                                                                                                                                                                                                                                       |
| `CUSTOMERIO_LIVE_DELTA_IMPORT`                        | set to `1` for the authoritative final full snapshot; Customer.io has no complete changed-profile migration feed, so this reruns every exact source projection and must rotate its import epoch                                                                                                                                                                                                                                                                                                                           |
| `CUSTOMERIO_LIVE_SHADOW_CHECK`                        | set to `1` after the final delta to require a clean full-source fingerprint comparison with `ready_for_cutover_review`, no blockers, and no remaining delta recommendation                                                                                                                                                                                                                                                                                                                                                |
| `CUSTOMERIO_LIVE_SOURCE_EVENTS`                       | must remain unset or `0`; the live harness explicitly rejects this flag because Customer.io does not expose a complete incremental profile-change feed for certification                                                                                                                                                                                                                                                                                                                                                  |
| `CUSTOMERIO_LIVE_ROLLBACK_REHEARSAL`                  | set to `1` with commit; Customer.io certification requires a durable `pass` rehearsal before rollback cleanup                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CUSTOMERIO_LIVE_MANUAL_REVIEW_SIGNOFF`               | set to `1` only after all six post-final-snapshot reviews are complete, including proof that email enablement requires global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default, while sender-specific SMS/WhatsApp `/v1/optouts` remain separate non-email evidence; the other gates cover `cio_id`/audience, workflow/transactional, non-email channel, deliverability, and ecosystem dependencies                                                                           |
| `CUSTOMERIO_LIVE_MANUAL_REVIEW_EVIDENCE_REF`          | required non-secret ticket/artifact reference for the six Customer.io cutover reviews; emails, API URLs, tokens, passwords, and credentials are rejected                                                                                                                                                                                                                                                                                                                                                                  |
| `CUSTOMERIO_LIVE_PILOT_ACCEPTANCE`                    | set to `1` with commit, rollback, final full-snapshot delta, post-delta shadow check, passing rollback rehearsal, all six recorded reviews, and credential-cleanup review; the final report must be `pass`                                                                                                                                                                                                                                                                                                                |
| `CUSTOMERIO_LIVE_CREDENTIAL_CLEANUP_REVIEW`           | set to `1` after the dedicated App API key is revoked or rotated and the retired key's bound-workspace access behavior is verified                                                                                                                                                                                                                                                                                                                                                                                        |
| `CUSTOMERIO_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF`     | required non-secret ticket/artifact/screenshot reference for App API key revocation/rotation proof                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CUSTOMERIO_LIVE_FAIL_ON_DISCOVERY_WARNINGS`          | set to `1` during representative-workspace certification to fail on Customer.io discovery warnings                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CUSTOMERIO_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS`     | set to `1` to fail when any exact Customer.io workflow, newsletter, transactional, template-rebuild, topic, suppression, opt-out, object, or checklist source record cannot be preserved                                                                                                                                                                                                                                                                                                                                  |
| `CONVERTKIT_CLIENT_ID/SECRET`                         | Kit OAuth app                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `LISTMONK_URL`                                        | base URL of the separately running upstream Listmonk process                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `LISTMONK_ADMIN_USER`                                 | Listmonk basic-auth user (admin API)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LISTMONK_ADMIN_PASSWORD`                             | Listmonk basic-auth password (admin API)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `STRIPE_SECRET_KEY`                                   | migration-only restricted key for source adapters that explicitly support the shared Stripe reader (currently Kit/ConvertKit); never inject the API service's billing key. Substack does not enumerate subscriptions from this key.                                                                                                                                                                                                                                                                                |
| `POSTWAVE_MIGRATION_SESSION_KEK`                      | 16/24/32-byte AES key, or `hex:`/`base64:` encoded key, for persisted source sessions                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SUBSTACK_SUBS_CSV`                                   | local direct-adapter fallback path to a Substack subscriber CSV; hosted flows use the resumable ZIP/CSV upload                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SUBSTACK_ARCHIVE_CSV`                                | local direct-adapter fallback path to Substack posts.csv (optional; hosted ZIP flows prepare this automatically)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SUBSTACK_ARCHIVE_STATS_CSV`                          | path to enriched/scraped Substack post stats CSV; overlays recipients, opens, clicks, rates, views, likes, comments, and related report metadata onto archive rows                                                                                                                                                                                                                                                                                                                                                        |

Production one-click OAuth requires `OAUTH_REDIRECT_URI` plus both halves of
the selected provider credential. Mailchimp and Kit OAuth start requests return
503 without those credentials unless the explicitly local demo mode is enabled;
they never fabricate a production authorization URL. The canonical AWS sidecar
task injects these values from Secrets Manager and binds the redirect template
to `https://app.<domain>/app/migrations/oauth/callback?source={source}`. Keep
these credentials, `POSTWAVE_MIGRATION_SESSION_KEK`, and the migration-sidecar
`STRIPE_SECRET_KEY` off the API task.

Run `node scripts/validate-live-migrations.mjs --self-test` or
`pnpm test:migrations:live -- --self-test` before live certification to verify
the script's selected-audience defaults, payload compaction, credential guards,
strict provider contracts, full-snapshot fingerprints, review-evidence writes,
and cutover gates without touching external providers.

ActiveCampaign source-event certification is a resumable two-run workflow. The
`prepare` run uses `ACTIVECAMPAIGN_LIVE_COMMIT=1`,
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS=1`, and
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=prepare`, with rollback and final-gate
flags unset. It performs discovery, dry-run, commit, and the first clean source-
event sync, then writes a `source-events-prepare` artifact containing the
retained job ID and leaves both the completed import and monitor active. The
initial ActiveCampaign rollback window is fourteen days: seven days of required
overlap plus a seven-day safety cushion for a failed final delta.

After at least seven days, resolve every pending source-event `manual_review`
row through
`PATCH /v1/migrations/{job}/source-events/{result UUID}/review` with a reviewed
status, handling detail, and a non-secret evidence reference. Run `finish` with
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS=1`,
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=finish`, the prepare artifact's
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID`, the same interval, rollback enabled,
and all final-delta/pilot-review flags. Finish reuses the encrypted session on
that job; it does not create or commit another job. Before mutation it verifies
the monitor is still enabled, has at least seven days of successful syncs with
no overlong gap, has a fresh clean sync, has no failed or pending review rows,
and retains enough base rollback-window headroom for the configured live wait.
The headroom reservation covers two independent budgets: final-delta wait plus
provider rate-limit extension/grace, followed by a full rollback-cleanup wait.

Once that preflight and a forced final sync are clean, finish runs final delta,
SMS readiness when applicable, final shadow check, rollback rehearsal,
consent/exclusion review, deliverability review, manual-review sign-off, and
strict pilot acceptance. A failure in any of those gates writes a sanitized
`source-events-finish-retryable` artifact and leaves the monitor/job intact for
operator resolution and retry. After every gate passes, the harness persists a
server-authorized post-pilot cleanup marker bound to the latest final
delta/overlap. While valid, that marker freezes every acceptance-affecting
mutation or rerun: source-event sync/review, final delta, shadow checks and
monitor restart, automation rebuild evidence, rollback rehearsal, other
cutover evidence, and ActiveCampaign credential refresh/reconnect. An operator
can explicitly reopen acceptance before cleanup by changing the cleanup marker
to `warning` or `blocker`. Cleanup calls
`DELETE /v1/migrations/{job}/source-events?post_pilot_cleanup=1`; under the
shared job lease the server revalidates authorization, records durable cleanup
start, and then disables the monitor. The lease serializes cleanup against
marker revocation; after cleanup start is durable, later revocation is refused.
The harness reads back both the disabled monitor and cleanup-start marker before
rollback. Once cleanup starts, authorization cannot be revoked; monitor stop
and rollback/retry remain allowed. A disable failure is non-certifying and
does not start rollback. A later rollback failure leaves the monitor disabled
and writes `source-events-cleanup-retryable`. Run
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=cleanup` with the retained job secret to
resume rollback without source sync, shadow checks, reviews, or final delta.
Only after rollback progress is confirmed by a fresh job read showing
`rolled_back` with a cleared deadline does the harness record
credential-cleanup evidence. That evidence is a sanitized harness artifact,
not a server-side migration or acceptance mutation.
Changed-contact polling cannot prove that a previously imported contact still
exists: a hard-deleted row may produce no changed-contact response at all.
Accordingly, the consent/exclusion review also reconciles the final source-ID-
to-email mapping and the final source-owned tag/list mapping against a reviewed
source export/audit. Same-source deltas automatically replace tags and custom
fields for contacts they observe; the review disables destination identities
for removed contacts and stale pre-change emails, removes any exclusion-covered
targeting tags, and leaves exactly one current identity per source ID. A lower
current contact count is an explicit shadow blocker that requires reconciliation
and a new final-delta baseline; older review evidence cannot clear that newly
lower inventory. Equal aggregate counts do not replace the mapping comparison:
additions can mask deletions, and an email change can preserve the total while
leaving the prior email identity stale.
The source-event gates fail when the returned monitor has `last_error`, even
though the API returns `202 Accepted`, because a failed sync is operational
state rather than certification evidence. A prepare failure cleans up its newly
started monitor and rolls back the failed isolated run. A finish readiness or
pilot-gate failure deliberately does not disable or roll back the retained job;
that state is needed for the next scheduled sync, row-level review, and retry.
Cleanup failures after a fully passing finish are captured in a sanitized
`source-events-cleanup-error`/`source-events-cleanup-retryable` artifact and
resume through the cleanup phase; they never trigger another overlap or final
delta.

The official `.github/workflows/live-migrations-nightly.yml` dispatch exposes
only a `configured | prepare | finish | cleanup` phase selector. Store the
prepare artifact's job ID in the protected
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID` repository/environment secret before
dispatching finish or cleanup. There is intentionally no workflow-dispatch job
ID input, and pass/failure messages omit the ID; it remains in the confidential
artifact and masked secret context. Scheduled runs can use the protected
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE` secret instead.
`ACTIVECAMPAIGN_LIVE_PILOT_ACCEPTANCE=1` requires
`ACTIVECAMPAIGN_LIVE_SOURCE_EVENTS=1`,
`ACTIVECAMPAIGN_LIVE_DELTA_IMPORT=1`, and
`ACTIVECAMPAIGN_LIVE_SHADOW_CHECK=1` because ActiveCampaign acceptance blocks
without changed-contact replay, final-delta evidence, and a clean shadow check
generated after the final delta import. It also requires
`ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1` and a non-secret
`ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF` because list status and
subscription dates are not channel-specific consent proof and API v3 does not
provide a complete exclusion-list read contract. It also requires
`ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW=1` so strict certification
cannot pass without operator-held API-token reset/disconnect proof, and
`ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF` so that proof is
traceable from the JSON evidence bundle without embedding secrets. Any
detected ActiveCampaign SMS inventory also requires
`ACTIVECAMPAIGN_LIVE_SMS_READINESS=1`, `POSTWAVE_API_URL`, and a tenant-scoped
`POSTWAVE_API_KEY` with `read:reports`. The migration evidence endpoint does
not run the separate SMS checks itself; the live harness queries
`/api/v1/sms/pilot-readiness` first and submits the marker only after every
readiness item passes. Any ActiveCampaign live certification flag, including
dry-run, commit, source-event,
final-delta, pilot-acceptance, rollback-rehearsal, consent/exclusion,
deliverability, manual-review, SMS-readiness, credential-cleanup, or
strict-warning checks,
requires `POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR` or
`MIGRATION_LIVE_ARTIFACT_DIR` so the run leaves durable JSON evidence. Rollback
cleanup remains automatic for ordinary isolated one-run certification failures.
The retained ActiveCampaign `finish` flow is intentionally different: a failed
final-delta/shadow/review/pilot gate keeps the monitor and job available for a
retry and records that disposition in its artifact. Cleanup and rollback start
only after those gates pass. A strict source-archive warning during `prepare`
still fails and rolls back before any overlap is retained.
When `ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW=1` is enabled, the
ordinary isolated one-run path attempts the credential-cleanup review after its
rollback attempt and combines failures. The retained `finish` path records
credential-cleanup review only after rollback succeeds; it never claims token
cleanup evidence for a job that remains live or failed to roll back.

HubSpot live certification is a retained hard profile, not a one-shot bridge
smoke test. `prepare` runs discovery, dry-run, commit, and the first
changed-contact sync, then retains the exact job and enabled monitor. `finish`
reuses that job only after at least seven days of continuous bounded polling,
runs a fresh source-event sync, the authoritative full contact/list/preference
snapshot, a same-count-sensitive fingerprint shadow check, rollback rehearsal,
and the strict pilot report. The report blocks unless every email-addressable
contact has complete preference and current-primary-email eligibility coverage.
Enabled requires `SUBSCRIBED` across every active email definition, no scoped
or wide opt-out, and no hard-bounce reason, quarantine, invalid-address,
non-marketing/unknown-marketing-contact, pending/unconfirmed double-opt-in, or
legacy opt-out restriction. `NOT_SPECIFIED` remains unconfirmed, and consent
timestamps require defensible evidence on every active subscribed row. This is
a conservative import projection, not exact HubSpot sendability parity.
Eligibility/DOI evidence is current-email-specific, so a primary-email change
requires a fresh full snapshot. There is no operator-warning acknowledgment
that can bypass either coverage gate.

After the final snapshot, `hubspot_crm_bridge_scope_review` must cover excluded
non-email contacts, non-sendable additional email identities, non-materialized
contact-property definitions, unavailable dynamic-list predicate definitions,
and every unsupported
product checklist. Passing strict acceptance permits the service to write
`hubspot_post_pilot_cleanup`. Only then can cleanup atomically claim its start,
disable replay, delete the locally encrypted HubSpot source session, persist
`hubspot_post_pilot_source_session_cleared_at`, complete rollback, and record
external private-app-token rotation/revocation evidence. A failed final
snapshot, shadow, review, or pilot gate retains the job and monitor for retry;
`cleanup` resumes only the already authorized cleanup path.
Any HubSpot live certification flag, including dry-run, commit, source-event
replay, final snapshot, shadow check, pilot acceptance, rollback rehearsal,
manual scope review, credential cleanup review, or strict discovery warnings, requires
`POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR` or `MIGRATION_LIVE_ARTIFACT_DIR` so the
run leaves durable JSON evidence.
Set `POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR` during certification to persist
source capabilities, credential job IDs, discovery snapshots, sanitized
dry-run/commit verification reports, source-event sync counters,
source-event cleanup failures, final delta evidence, final shadow checks,
pilot acceptance, rollback rehearsal, rollback cleanup, rollback cleanup
start/poll/timeout failures, credential cleanup review, and the final
pass/fail summary as JSON.
Credential artifacts
intentionally record whether an account identifier was returned without copying
the identifier into the evidence bundle, verification-report artifacts remove
email-bearing subscriber merge-conflict rows, and source-event artifacts
summarize event categories without copying raw event payloads or source-event
IDs into the evidence bundle. Delta-import cursor artifacts preserve key names, run mode, delta
snapshot/start/error presence, pre-delta source-event sync presence,
rollback rehearsal summary, and cutover-evidence keys
without copying raw cursor values; job-error artifacts redact email addresses,
token-like details, ActiveCampaign API URLs including bare account hosts
accepted by the connector, and ActiveCampaign/HubSpot source-event IDs.
Pilot-acceptance, rollback-rehearsal, shadow-check, and rollback-cleanup
artifacts also redact free-form detail, evidence, blocker, note, and error text
before writing. If rollback cleanup cannot start, polling fails, or polling
times out, the harness writes a sanitized failure artifact with the last
observed rollback state when one exists. Treat the bundle as
confidential cutover evidence even after sanitization because it can still
contain job IDs, aggregate customer/resource counts, campaign or resource
names, warnings, and operational readiness signals.

With Postgres enabled, migration OAuth states and source sessions are durable.
Sessions are encrypted before they hit `migration_sessions`; local Docker uses
a fixed development key, while private beta/prod should use a random 32-byte
key managed by the deployment secret store. Memory fallback remains available
only for isolated local demos via `POSTWAVE_ALLOW_MEMORY_FALLBACK=1`.

## Verification report

Every migration produces a `canonical.VerificationReport` at the end of both
dry-run and commit. The report tells the user exactly what landed, what got
dropped, and why. It is computed by `internal/orchestrator/verifier.go` from
observations the orchestrator feeds in during the run:

| Field                                                                                                | Source                                                                                 |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `subscribers_imported`                                                                               | `subscribers_seen − skipped − errored`                                                 |
| `suppression_list_size`                                                                              | count of disabled + blocklisted subscribers from source                                |
| `custom_fields_mapped` / `_unmapped`                                                                 | per-field classification table in `verifier.go`                                        |
| `segments_translated` / `_with_warnings`                                                             | translator output + adapter source-definition flags                                    |
| `automations_translated` / `_unsupported`                                                            | persistence success vs adapter unsupported list                                        |
| `automation_rebuilds`                                                                                | ranked rebuild/test ledger for the top unsupported automations                         |
| `paid_subs_imported` / `archive_imported` / `source_archive_imported`                                | orchestrator counters                                                                  |
| `discovery_warnings` / `campaign_archive_warnings` / `template_warnings` / `source_archive_warnings` | adapter-reported fidelity or endpoint warnings surfaced to review and pilot acceptance |
| `data_loss_estimate_pct`                                                                             | `(sub_loss·0.6 + seg_loss·0.2 + auto_loss·0.2) · 100`                                  |

Resource completeness statuses are intentionally explicit:

- `imported_runtime`: executable/imported Moosewave runtime data.
- `partial_runtime`: runtime data exists, but warnings or incomplete parity need review.
- `preserved_for_rebuild`: source evidence is archived for rebuild; it is not live parity.
- `manual_rebuild_required`: users/operators must rebuild or reconnect this surface.
- `not_supported`: this adapter has no supported migration path for the detected resource.
- `not_detected`: the source did not expose that resource in discovery.

The orchestrator emits a structured `event:posthog:migration_resource_metrics`
log on every run with discovered/imported counts, subscriber tag assignments,
Mailchimp static segment memberships, duplicate merges, template/archive
warning counts, preflight failures, and verification fidelity.

The report is stored on `MigrationJob.VerificationReport` and surfaced through
`GET /v1/migrations/{job_id}/verification`. The wizard's dry-run review step
and the per-job detail page both render it.

## Shadow checks for customer pilots

During a replacement pilot, keep the source live through shadow mode. If
HubSpot is in scope as the CRM bridge, keep HubSpot live too. For one-off
checks, call the source-specific route:

```
POST /v1/migrations/activecampaign/shadow-check
{ "job_id": "..." }

POST /v1/migrations/hubspot/shadow-check
{ "job_id": "..." }

POST /v1/migrations/beehiiv/shadow-check
{ "job_id": "..." }

POST /v1/migrations/customerio/shadow-check
{ "job_id": "..." }
```

The handler reuses the encrypted source session, reruns source discovery, and
compares current source totals with the job's latest verification report. The
response includes resource-by-resource deltas, manual-review blockers, and a
recommended action:

| Action                            | Meaning                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready_for_cutover_review`        | No count delta or unsupported detected-resource blocker was found. Human cutover review can proceed.                                                               |
| `run_delta_import_before_cutover` | The source changed after the reviewed import. Freeze relevant source edits, run the source-specific final delta import, then recheck.                              |
| `manual_review_required`          | Unsupported or preserved-for-rebuild resources exist, for example forms/templates/CRM/custom objects/SMS history. Get explicit sign-off or rebuild before cutover. |
| `check_failed`                    | The attempt did not complete durably. Provider, persistence, and execution-lease errors block pilot acceptance.                                                    |

Beehiiv shadow checks additionally compare the latest successful import's
bounded per-component source fingerprint with a full current traversal. This
detects same-count changes to subscribers, fields, tags, list/segment
membership and definitions, automations, sent posts, and source-archive
records that count-only discovery cannot see. Each successful destination-writing
Beehiiv run also rotates an opaque import epoch. A ready result must match both
that epoch and the exact baseline fingerprint digest. Each check also rotates
a durable attempt token before provider reads; history and pilot acceptance
require the current token, so replica clock skew cannot revive an older ready
row.

Customer.io shadow checks likewise perform a bounded full traversal instead of
trusting counts alone. The fingerprint covers email-addressable subscribers,
the non-reversible identity digest for every profile without a usable email,
segment/topic snapshot projections, exact-source editable templates, eligible
sent email newsletter history, and the exact source archive. A ready result must match every exact
count, all six component digests, the aggregate digest, and the import epoch
from the latest successful destination-writing run. This detects same-count
profile, non-email identity replacement, membership, content, workflow,
suppression, opt-out, object, and checklist changes. Every successful final full-snapshot delta rotates the
opaque epoch so an older ready shadow result cannot certify a newer import.

HubSpot shadow checks also use a bounded source fingerprint rather than totals
alone. The fingerprint covers email-addressable contacts, non-email contact IDs,
additional email identities, exact frozen list and subscription-tag
memberships, and all non-sensitive contact-property definitions. It is bound to
the provider-verified portal and the latest import epoch, so same-count identity,
membership, preference, or property-schema changes invalidate an older ready
result. Additional addresses never become independent sendable subscribers;
aliases on contacts without a usable primary email remain non-reversible
fingerprint evidence. Property definitions are inventoried and fingerprinted
but only populated values are written as custom fields—an empty definition is
not claimed as destination schema.

Customer.io newsletter history requires at least one explicit `language=""`
email content. When that default set contains A/B variants, the lowest stable
content ID is the representative, all variants remain evidence, and the
representative choice carries a warning. Missing defaults and invalid language
metadata fail closed; translations are never selected silently. An absent or
empty layout uses the exact non-empty source body with a fidelity warning, and
a non-empty layout composes only at exactly one documented `{{content}}` slot.
Other layout/body shapes remain source-archive-only. Design Studio templates
import non-empty exact source `content.html`. Neither path is provider-rendered
output: Liquid, CSS preprocessing, assets, components, global styles,
transformers, and per-recipient rendering require separate validation.

Beehiiv subscriber writes retain bounded per-source projections for safe
cross-job email merges. If one publication identity disappears while another
same-provider identity survives, final-delta reconciliation removes only the
retiring identity's tags, fields, and list memberships and transfers primary
status/identity authority. Legacy, conflicting, or cross-provider projections
fail before mutation. The resulting survivor ledger blocks ordinary rollback
because its historical before-image contains retired targeting state; this
edge case remains controlled-pilot-only until projection-aware rollback is
implemented and certified.

For continuous pilot monitoring, enable the durable shadow monitor:

```
POST /v1/migrations/activecampaign/shadow-monitor
{ "job_id": "...", "interval_seconds": 3600 }

POST /v1/migrations/hubspot/shadow-monitor
{ "job_id": "...", "interval_seconds": 3600 }

POST /v1/migrations/beehiiv/shadow-monitor
{ "job_id": "...", "interval_seconds": 3600 }

POST /v1/migrations/customerio/shadow-monitor
{ "job_id": "...", "interval_seconds": 3600 }
```

The monitor stores its schedule in `migration_shadow_monitors`, writes a
fail-closed attempt-start row and then every completed check snapshot to
`migration_shadow_check_results`, runs the first check
immediately, and is replayed by the service worker while the migration service
is running. The start row is durable before provider traversal and the final
row is written only after execution-lease release, so a crash or release error
cannot leave older ready evidence as the newest result. Completed rows retain
provider-observation time instead of later insert time, and history is ordered
first by the durable attempt token currently stored on the job and then by
observation time. Every check rotates that token before its sentinel is written,
and every new delta clears it, so stale ready rows cannot win because another
replica's wall clock is ahead. Failed monitor checks
persist a sanitized error in both the monitor
state and the shadow-check history, so pilot acceptance and the dashboard can
show the cause of `check_failed` evidence without leaking provider hosts or
tokens. Starting the monitor requires a still-valid encrypted source session;
if the session has expired, reconnect the source credential before enabling
shadow monitoring so the service does not leave behind an enabled monitor with
no usable credentials. The web migration detail page exposes enable/disable,
last action, next check, and recent history.

If a migration import/final delta is running, background shadow-monitor workers
defer until the job is completed. A deferred shadow-monitor pass only
reschedules the monitor; it does not update `last_checked_at`, clear
`last_error`, overwrite the last recommendation, or count as a new shadow-check
result.

This is a periodic source rediscovery monitor. For providers that expose an
updated-resource cursor, the service can also run continuous source-event
monitoring during the same overlap window:

```
POST /v1/migrations/sources/activecampaign/source-events
{ "job_id": "...", "interval_seconds": 300 }

POST /v1/migrations/sources/hubspot/source-events
{ "job_id": "...", "interval_seconds": 300 }
```

Customer.io is intentionally absent from this list. Its App API does not
provide a complete incremental profile-change feed suitable for migration
certification. Do not set `CUSTOMERIO_LIVE_SOURCE_EVENTS`; keep shadow
rediscovery running during the overlap, freeze source changes, and use the
authoritative full-snapshot `delta-import` immediately before cutover review.

Source-event monitoring is a writer path. The API and worker refuse replay
unless the migration job is `completed`, so changed-contact upserts cannot race
ahead of the base import or continue during rollback/failed states. The first
replay starts from the migration job's `started_at` timestamp, not
`completed_at`, so contacts changed while the base import was still running are
also replayed idempotently. Replay resolves the Listmonk destination through
the same configured secrets/env client factory as base import and rollback, so
AWS Secrets Manager-backed production deployments do not fall back to env-only
credentials for changed-contact writes. Starting source-event monitoring also
requires a live encrypted source session before the monitor is enabled.

The event monitor stores its schedule in `migration_source_event_monitors`,
writes every observed event to `migration_source_event_results`, and replays
canonical subscriber upserts when the adapter can project the source event into
a safe Moosewave write. Events that cannot be automatically applied are still
retained with an error/manual-review reason, rather than being dropped.
ActiveCampaign phone-only/email-less contact changes are intentionally stored
as `manual_review` with `applied=false`; that is not an automatic replay
failure and must not be relabeled as applied. The dashboard requires an
operator to attach reconciliation detail plus a non-secret evidence reference
to the immutable result row through
`PATCH /v1/migrations/{job_id}/source-events/{event_id}/review`. The separate
`review_status=reviewed` state clears only that manual-review row. Automatic
subscriber-upsert failures cannot be waived through this endpoint, reopening a
review makes it block again, and a later provider mutation creates a new
pending result rather than inheriting old evidence.

Today
ActiveCampaign base contact export uses ID pagination for large account safety.
Changed-contact replay treats the provider's documented `updated_after` and
`updated_before` inputs as date-only filters: it widens both UTC date edges,
hydrates candidates, filters them against the exact inclusive fixed timestamp
window, and advances the ID cursor over conservative false positives. An
all-skipped provider page is drained internally rather than returning an empty
event batch with a continuation cursor.
Changed-contact polling fixes an overlap window, drains that window in ascending
contact ID order, and advances the high-water mark only after the window is
complete; it does not rely on mutable `udate` ordering or offset pagination. The
ActiveCampaign changed-contact event IDs include a stable canonical subscriber
projection hash so idempotent overlap polls dedupe without masking same-second
contact updates that changed the projected subscriber state.
ActiveCampaign/HubSpot contact updates implement this path; other adapters
preserve known unsupported surfaces as source-archive parity-gap rows.
HubSpot polling searches by `lastmodifieddate` and can replay changed
email-addressable contacts with their current properties and communication
preferences. It is not a complete event feed: list-membership-only changes,
preference-only changes that do not advance the contact modification timestamp,
contact deletions, and contacts that lose their primary email may be absent.
The full final snapshot is therefore authoritative and must reconcile those
states before cutover. Exact `hubspot:list:{id}` membership and
`hubspot:subscription:{businessUnitId}:{subscriptionId}` tags are frozen
snapshots. Segment source evidence retains only allowlisted structural list
metadata (identity/version, object type, and processing type/status).
`filterBranch` predicates are deliberately not requested or persisted because
their operations can contain sensitive property and integration-event literals.
Operators must inspect those rules in HubSpot, then rebuild, retain, or retire
them explicitly; preference rules likewise remain source-owned.
The web migration detail page exposes ActiveCampaign and HubSpot source-event
replay state, last/next sync timestamps, seen/applied counters, latest event
status, pending manual-review reconciliation forms, durable row-level review
evidence, inspected completed reviews with an explicit reopen action, and
enable/disable controls. Reopening clears the old row evidence and makes that
row block pilot acceptance until fresh detail and evidence are recorded.
Starting replay from the dashboard is
blocked with the same reconnect guidance as final delta and shadow monitoring
when the saved source session is missing, expired, or near expiry.

Keep shadow monitoring and source-event monitoring enabled during the 7-14 day
overlap and still run one final check immediately after the source freeze.
If a final delta import is running, background monitor workers defer until the
job is completed so replay cursors do not race the import. A deferred
source-event worker pass only reschedules the monitor; it does not advance
`last_synced_at`, clear `last_error`, or count as replay evidence for pilot
acceptance. A source-event worker pass that reaches the provider but fails
also preserves the previous `last_synced_at`; `last_error` and the retry
schedule update, but the failed attempt does not count as completed replay
evidence. ActiveCampaign and HubSpot final delta imports snapshot the last clean
source-event replay sync that existed before the delta began; pilot acceptance
requires that captured pre-delta sync to be no older than one configured
monitor interval before final delta start, so stale overlap evidence cannot
pass a cutover review.

If the shadow-check recommends `run_delta_import_before_cutover`, freeze source
edits that affect the cutover audience and call the source-specific route:

```
POST /v1/migrations/activecampaign/delta-import
{ "job_id": "..." }

POST /v1/migrations/hubspot/delta-import
{ "job_id": "..." }

POST /v1/migrations/customerio/delta-import
{ "job_id": "..." }
```

The current delta path is deliberately conservative: it only starts from a
completed committed migration, uses the stored encrypted source session, and
reruns the idempotent import instead of relying on best-effort source
`updated_since` filters. Existing source IDs are upserted, new resources are
imported, progress/cursors are reset for the replay, and a fresh verification
report is produced. If the delta replay fails, the previous completed job
state, verification report, rollback window, and cursor ledger are restored and
the delta error is retained for operator review.

For Customer.io, this conservative replay is the required final synchronization
mechanism, not an incremental-event shortcut. Certification verifies exact
subscriber, segment/topic, eligible sent-newsletter, exact-source editable-template, and source-
archive completeness, persists a new six-component fingerprint including the
non-reversible non-email `cio_id` identity digest, and rejects a
delta that fails to rotate the import epoch.

Before the limited live pilot, call:

```
GET /v1/migrations/{job_id}/automation-rebuilds
PATCH /v1/migrations/{job_id}/automation-rebuilds
GET /v1/migrations/{job_id}/rollback-rehearsal
GET /v1/migrations/{job_id}/pilot-acceptance
PATCH /v1/migrations/{job_id}/cutover-evidence
PATCH /v1/migrations/{job_id}/source-events/{event_id}/review
```

The rebuild ledger is capped to the top 10 unsupported automations from the
verification report. Each item must be marked `test_passed` or
`approved_not_needed` before the acceptance report can pass. Those pass/waiver
updates require `test_evidence`, and pilot acceptance rechecks stored rows for
non-empty evidence so legacy/imported pass or waiver rows cannot satisfy the
ledger without proof. The dashboard quick actions attach a timestamped operator
assertion so the ledger cannot be satisfied by an empty status flip. The
acceptance report also blocks on contact-count mismatches,
unsupported detected source resources, and source SMS usage until the SMS
pilot readiness endpoint passes.

Customer.io pilot certification requires exactly six allow-listed cutover
evidence keys: `customerio_consent_subscription_review`,
`customerio_identity_audience_review`,
`customerio_automation_rebuild_review`,
`customerio_channel_dependency_review`,
`customerio_deliverability_review`, and
`customerio_ecosystem_dependencies_review`. The live harness records and
re-reads all six only after the authoritative final full snapshot. Every row
must be `pass`, carry the same non-secret evidence reference, and include its
source-specific reconciliation marker. The consent/subscription row must prove
the three-layer email rule: global subscribed state, the resolved email-channel
subscribed/default state, and the applicable topic subscribed/default state
must all allow email. It must also treat subscription-center channel
preferences as channel-type-wide state and keep sender-specific SMS/WhatsApp
`/v1/optouts` as distinct `(cio_id, channel, from)` non-email evidence. The
ecosystem row must also state that
the eight static checklist records were reviewed and are prompts rather than
provider inventory. Certification then requires a clean post-delta fingerprint
shadow check, a passing rollback rehearsal and pilot report, successful
rollback cleanup, and traceable App API key rotation/revocation evidence.

For ActiveCampaign, HubSpot, Beehiiv, Klaviyo, and Customer.io,
`GET /rollback-rehearsal` writes durable
rehearsal evidence into the job cursor: status, generated timestamp,
tracked-resource total, count source, and a versioned destination-validation
proof. The rehearsal runs the same tenant-bound Listmonk ownership and
Postgres after-image conflict checks as actual rollback without mutating the
destination or creating rollback progress. Pilot acceptance blocks until the
latest marker is `pass`, was generated after the latest completed import, and
was counted from the Postgres `migration_imported_resources` rollback ledger
rather than from job progress counters. Legacy/count-only passes do not
qualify. Re-run rollback rehearsal on the
Postgres-backed migration service after every final delta import. ActiveCampaign
and HubSpot pilot acceptance also consume source-event replay monitor evidence:
they block when replay was never enabled, never synced, has a current sync
error, or has any persisted failed/unresolved replay rows. ActiveCampaign and
HubSpot also require the final delta/full snapshot to capture an immutable
overlap snapshot proving at least seven days of successful polling, bounded
sync gaps, and a fresh clean pre-delta sync;
disabling a one-shot monitor is not evidence. A deliberately unapplied manual-
review row is accepted only after its row-level reviewed status, handling detail,
evidence reference, and timestamp are complete. Failed replay rows in pilot
acceptance are labeled by resource/action/timestamp rather than raw provider
event IDs. ActiveCampaign consent/exclusion,
deliverability, audience-schema, campaign-archive-fidelity, review-surface,
discovery-warning, source-archive-warning, and verified SMS-readiness evidence
are recorded through
`PATCH /cutover-evidence` with allow-listed ActiveCampaign keys such as
`activecampaign_consent_exclusion_review`,
`activecampaign_deliverability_review`, `activecampaign_segments_review`,
`activecampaign_automation_rebuild_review`,
`activecampaign_templates_review`, `activecampaign_forms_review`,
`activecampaign_custom_objects_review`, `activecampaign_ecommerce_review`,
`activecampaign_audience_schema_review`,
`activecampaign_campaign_archive_fidelity_review`,
`source_discovery_warnings`, `source_archive_warnings`, and
`activecampaign_crm_archive_review`, plus the programmatic `sms_readiness`
key; passing evidence is accepted only after
the final delta import, is rejected again if the latest final delta import
failed, and stale evidence blocks pilot acceptance. The endpoint redacts
token-like strings and ActiveCampaign account API hosts from operator-entered
detail/evidence before storing cursor state or returning the acceptance report,
but the sign-off packet is still confidential cutover evidence. Contact/runtime
count mismatches, hard automation rebuild blockers, unsupported-resource
blockers, and SMS readiness blockers still require the underlying issue to be
fixed. The live harness never includes `sms_readiness` in blanket manual
sign-off: it first fetches `/api/v1/sms/pilot-readiness` and records a passing
row only when `can_pilot` is true and every returned readiness check passes.
ActiveCampaign manual rebuild/archive blockers for audience schema,
templates/messages, forms, custom objects, ecommerce, CRM archive gaps, and
campaign archive fidelity can be cleared only by
fresh post-final-delta cutover evidence after the operator has rebuilt,
externally exported, or explicitly signed off the surface as out of cutover
scope.

For the full first-customer operating checklist, including SMS sender
certification and rollback criteria, use
`docs/first-customer-pilot-runbook.md`.

The web migration detail page can download a Markdown sign-off packet that
bundles the verification summary, checklist state, shadow-monitor status,
ActiveCampaign/HubSpot source-event replay counters/latest sync state, top
automation rebuild ledger, and pilot acceptance result. The browser export
applies the same sensitive-text redaction to ActiveCampaign and HubSpot
shadow/source-event errors and packet table values before writing Markdown,
including token-like fields and account API hosts, but the packet remains
confidential cutover evidence. The
onscreen acceptance checks also render backend evidence rows, including
pre-delta source-event timestamps and blocker details, so operators do not need
to export the packet to see why an ActiveCampaign or HubSpot gate is blocked.
The ActiveCampaign and HubSpot pilot-acceptance gates require source-event
monitoring to have started before the final delta import began; enabling replay
only after final delta does not prove the pilot overlap and remains a blocker
until replay is captured during the overlap and final delta is rerun. The
migration API also applies that ActiveCampaign/HubSpot redaction before
returning or persisting provider-originated error/evidence text from
credentials, discovery, job status, verification reports, reconnect responses,
shadow monitors, source-event monitors, source-event replay records, automation
rebuild notes, final-delta failure snapshots, pilot-acceptance
verification/parse/load evidence, and rollback-status progress errors.
ActiveCampaign and HubSpot source-event monitor errors and live certification
artifacts also omit raw source-event IDs and redact source-event cursor contact
IDs, so failed replay evidence remains actionable without exposing provider
contact identifiers. For the same detail page,
final delta import, shadow-monitor start, and
source-event replay start are disabled with reconnect guidance when the saved
source session is missing, expired, or near expiry, matching API-side cutover
preflight behavior. In that state, ActiveCampaign and HubSpot jobs show a
reconnect card that posts fresh API URL/token or private-app-token credentials
to `POST /v1/migrations/{job_id}/source-session`, refreshes only the existing
job's encrypted source session, and preserves the migration job, report, and
audit history. The new-migration wizard uses the same job-scoped reconnect card
during discovery and dry-run review, so an expired session can be refreshed
without restarting the migration or losing dry-run evidence. Shadow-monitor
start and source-event replay start are also
disabled until the migration job is completed, matching the backend's monitor
eligibility checks. Starting shadow monitoring or source-event replay from that
page refreshes pilot controls so the checklist and sign-off packet reflect the
latest persisted evidence without a separate manual refresh. When an in-flight
import or final delta run completes through the live progress stream, the page
also refreshes the verification report and pilot controls so final-delta and
acceptance gates update without a manual reload. While a job is still running,
verification and audit are treated as sidecars: if either is not ready yet, the
detail page still loads the job/progress view instead of showing a hard error.
After a job reaches a terminal state, verification failures are surfaced instead
of being hidden as an empty report so a completed cutover cannot silently lose
its acceptance evidence. Pilot-control sidecars are loaded independently; if
acceptance, automation rebuilds, shadow monitoring, or source-event replay
fails while other controls load, the detail page shows a warning naming the
failed sidecar and clears that sidecar's previous state instead of treating
missing evidence as current or clean unchecked evidence. A missing shadow or
source-event monitor record (`404`) is handled separately as a normal "not
started yet" state, so pre-cutover jobs do not show false sidecar-outage
warnings before those monitors are enabled.
For
non-browser control-plane checks, run `pnpm test:pilot:smoke` with the migration
job and SMS sender IDs.

## Rollback windows

After a successful commit, the default policy is
`MigrationJob.RollbackUntil = completed_at + 7d`. ActiveCampaign uses `+14d`
because its strict certification retains the base import through a mandatory
seven-day source-event overlap and needs a second seven-day cushion if final
delta fails. Every successful final delta establishes a new completion time and
renews the source-specific rollback window (`+14d` for ActiveCampaign, `+7d`
otherwise). The finish harness also refuses to begin final delta when the
retained base deadline lacks enough headroom for both the final-delta
job/rate-limit/grace budget and a separate full rollback-cleanup wait budget.

While the applicable timestamp is in the future, the user can click "Rollback
this migration" in the admin UI and `RollbackEngine.Rollback` reverses every
write the orchestrator made:

```
paid subscription mirrors  →  editable templates  →  materialized source surfaces
→  source archive  →  campaign archive  →  automations  →  segments  →  subscribers
```

Order matters: children before parents so foreign keys never refuse a delete
mid-sweep. Each delete is logged to `audit_log` via the engine's `Audit`
hook, and per-row 404s are swallowed so a retried partial rollback doesn't
fail at the half-way mark.
When the rollback engine has a Postgres connection, live rollback progress
counts are read from the active imported-resource ledger, matching the rows
that will actually be deleted. Rollback refuses to start or complete if
tracked resources require missing Listmonk credentials or the Postgres
imported-resource ledger, rather than silently skipping those deletes.

Contracts:

- **Idempotent.** A second `Rollback` on a `rolled_back` job is a no-op.
- **Window-bounded.** Past `RollbackUntil`, `Rollback` returns
  `ErrRollbackWindowExpired` and touches nothing.
- **State-gated.** Jobs not in `MigCompleted` are refused with
  `ErrNotRollbackable`.
- **Destination-gated.** Missing Listmonk/Postgres rollback dependencies return
  `ErrRollbackDestinationUnavailable`; the job stays retryable.

The HTTP layer (`StartRollback`) kicks the engine off in a goroutine and
returns 202; the UI polls `GET /{job_id}/rollback-status` until the engine
reports `state ∈ {completed, failed}`.

## Open follow-ups

- Move the session KEK from env-backed AES to managed envelope encryption.
- Persist rollback progress if we need multi-process live rollback status.
- Codegen Go canonical types from `packages/schema/src/index.ts`.

## Tests

```
go test ./...
```

Adapter tests use inline JSON fixtures and never hit the network. End-to-end
tests against real ESPs require sandbox credentials:

```
POSTWAVE_MIGRATION_URL=http://localhost:8081 \
POSTWAVE_INTERNAL_API_TOKEN=... \
BEEHIIV_API_KEY=... BEEHIIV_PUBLICATION_ID=... \
CUSTOMERIO_API_KEY=... CUSTOMERIO_WORKSPACE_ID=31415 CUSTOMERIO_REGION=eu \
CUSTOMERIO_LIVE_DRY_RUN=1 \
MAILERLITE_API_KEY=... \
pnpm test:migrations:live
```

For MailerLite, add `MAILERLITE_LIVE_DRY_RUN=1` to exercise the full
read-only traversal. Destructive certification requires a dedicated destination
tenant plus `MAILERLITE_LIVE_COMMIT=1` and
`MAILERLITE_LIVE_ROLLBACK=1`. Set
`MAILERLITE_LIVE_FAIL_ON_DISCOVERY_WARNINGS=1` and
`MAILERLITE_LIVE_FAIL_ON_SOURCE_ARCHIVE_WARNINGS=1` when warning-free evidence
is required. This still does not certify a final delta or live source-event
overlap because MailerLite has no adapter implementation for those paths.

For destructive Customer.io certification, use a dedicated test workspace and
isolated destination. Set commit and rollback together, then enable final delta,
shadow check, rollback rehearsal, pilot acceptance, all six manual-review
sign-off evidence, and credential-cleanup evidence. Keep
`CUSTOMERIO_LIVE_SOURCE_EVENTS=0` and configure a durable artifact directory.

Set `REQUIRE_LIVE_MIGRATIONS=1` in CI/private-beta certification if missing
provider credentials should fail the run instead of being reported as skipped.

## Local configuration prepared on 2026-10-11

No infrastructure was deployed while implementing these changes. The files
below prepare a later rollout; local fixtures and database tests do not certify
staging or real provider accounts.

### Per-workspace email destinations

Supply the same `LISTMONK_TENANT_ROUTES` secret to the API, migration and automation
services. It is a JSON array of `tenant_id`, `destination_id` (stable UUID),
`base_url`, `admin_user` and `admin_password` objects. Each tenant requires its own
Listmonk instance and subscriber database. Distinct URL aliases for one engine
are not separate destinations. Provision and verify the instances before adding
routes; the registry does not create them.

Migration `2069_tenant_email_destinations.sql` creates immutable database bindings.
Credentials can rotate while the destination UUID and canonical endpoint stay
the same. A different tenant, reused endpoint, changed destination, missing
route, or removed registry cannot silently fall back to the global engine.
Existing jobs pin the same destination for resume, event replay and rollback.
Do not delete bindings to bypass these protections; moving a destination needs
a separately reviewed data migration. The capability endpoint checks the
persisted binding through the same destination factory used by commit.

`TenantEmailRoutesSecretArn` is supported by both
`infra/aws/staging/services.yaml` (API) and
`infra/aws/cloudformation/postwave-sidecars.yaml` (migration/automation).
The ECS execution role must be allowed to read that secret and decrypt its KMS
key, if applicable. Keep secret values out of task-definition JSON and logs.

### Shared file uploads

The local provisioning template
`infra/aws/cloudformation/postwave-migration-storage.yaml` defines an encrypted,
retained regional EFS filesystem, two private mount targets, a task-role grant,
and an access point owned by UID/GID 10001. It requires the VPC, two subnets in
different availability zones, migration security group and task role ARN.
Network access to NFS/2049 is limited to that security group.

After a separately authorized provisioning step, pass both filesystem and access
point IDs to the sidecars stack. It mounts `/var/lib/postwave/migration-uploads`
with IAM authorization and encryption in transit. Set:

```text
POSTWAVE_MIGRATION_UPLOAD_BACKEND=efs
POSTWAVE_MIGRATION_UPLOAD_DIR=/var/lib/postwave/migration-uploads
```

The service rejects an absent/non-NFS mount and requires persistent job storage.
Local `filesystem` mode is limited to development/tests; production cannot
accept task-local uploads. All workers must mount the same access point/root.
The upload limit is 200 MiB, with chunks up to 16 MiB. Accepted offsets require
flushed bytes and atomic metadata. Completed files are immutable and checked
against a job-bound digest before source reads. Job creation can retry after a
session-write failure without duplicating jobs or discarding saved mappings.

The retention worker runs at startup and hourly. It removes source files after
30 days when there is no active execution or valid saved session, and physically
erases expired encrypted sessions/OAuth states. Small metadata tombstones and
lock files remain to prevent an expired upload ID from being reused. Backups
follow the EFS backup retention policy and are separate from application erasure.
Corrupt metadata is reported while cleanup continues for other uploads.

### OAuth and final cleanup

Mailchimp and Kit need separately registered OAuth apps, their client ID/secret,
and an exact registered callback in `OAUTH_REDIRECT_URI` (`{source}` is supported).
Blank credentials or an invalid callback make intake unavailable. Staging and
production require HTTPS; local loopback HTTP is only for development. Configure
the encrypted-session key before processing credentials. Source account access
and paid entitlements remain customer/provider prerequisites.

`DELETE /v1/migrations/{job_id}/source-session` is available in the completed-job
screen. It takes job/session leases, stops monitors, deletes raw uploads and
stored credentials, and fences OAuth callbacks issued before cleanup. It
preserves destination data, verification and rollback records. Retries are
idempotent; active migration execution is rejected. Reconnect a direct source
or start a new upload to read it again. The response always reports
`provider_access_revoked: false`: the account owner must revoke the dedicated
API key/Service Key or disconnect the OAuth app in the source account.


### Local qualification and later live qualification

`./scripts/test-migrations-local.sh` builds a disposable PostgreSQL database and runs the migration suite as `postwave_app`. It refuses to count skipped database tests as qualification. The export lifecycle test uses all eleven actual file adapters through upload, preview, commit, verification, rollback and stored-source cleanup with synthetic exports and a destination HTTP fixture. Provider protocol tests run separately with `go test ./packages/migrate/...`. Neither substitutes for authorized real source accounts.

The live harness now inventories all twenty paths. `REQUIRE_MIGRATION_LIFECYCLE=1` requires a successful preview, commit, rollback and stored-source cleanup for every path. OAuth-start and discovery success alone cannot satisfy it. Required credentials or exports that are missing produce an incomplete/failing run.

Before a later authorized live rehearsal:

1. Configure isolated test tenants, persistent sessions, EFS uploads and provider access as described above. Supply an explicitly reviewed Mailchimp audience scope. Use test accounts whose imported data may be rolled back.
2. Set `MIGRATION_CANDIDATE_SHA256` to the SHA-256 of the exact migration executable in the candidate image (not an image tag or Git revision). Deploy all migration workers from that same artifact. The service emits `X-Migration-Build-SHA256` and rejects a mismatching `X-Migration-Expected-Build-SHA256` before handling requests. Artifacts include the expected and observed executable hashes; all service replicas must match.
3. Set `POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR`, service/API credentials and the provider-specific environment variables. Explicit `*_LIVE_COMMIT=1` and `*_LIVE_ROLLBACK=1` authorize rehearsals. Kit token mode accepts `CONVERTKIT_ACCESS_TOKEN`, `CONVERTKIT_REFRESH_TOKEN`, and `CONVERTKIT_ACCOUNT_ID`; app credentials are needed for rotation. Production users connect through OAuth.
4. For files, set `MIGRATION_EXPORT_PATHS_JSON` to a JSON object from source slug to a local authorized export path. AWeber uses `AWEBER_LIVE_COMMIT` / `AWEBER_LIVE_ROLLBACK`; hyphens become underscores for Campaign Monitor and Constant Contact. The harness uploads in 4 MiB chunks and records a digest, without copying raw exports into evidence artifacts. Files remain subject to the 200 MiB cap.
5. In GitHub Actions, the optional `migration-source-test-exports` artifact from `vars.MIGRATION_EXPORT_ARTIFACT_RUN_ID` supplies `<source>.csv` files (or `substack.zip`). Setting that run ID authorizes their commit/rollback rehearsals in the configured test tenant. Keep the input artifact private and set its own short retention. Configure the expected executable digest as a repository/environment variable. Provider credentials remain secrets.
6. ActiveCampaign and HubSpot require separate prepare and finish runs across seven days. Prepare remains incomplete for full qualification. Finish needs `MIGRATION_RETAINED_EVIDENCE_DIR` containing that job's v2 preview/commit artifacts from the same executable. The workflow can download these from `vars.MIGRATION_RETAINED_EVIDENCE_RUN_ID`. Changing the executable requires a fresh qualification run. Cleanup-only retries do not establish a new full qualification.
7. Review unsupported resource rebuilds and provider revocation separately. Stored-source cleanup deletes our credentials/files and stops monitoring; its receipt explicitly states `provider_access_revoked=false`. A green technical rehearsal does not establish that workflows, billing, domains or excluded resources have been manually reviewed.

No deployment or live rehearsal is performed by the local test command. File exports must include every required status/suppression set and relevant audience; a successful import cannot recover rows the operator omitted from the export.
