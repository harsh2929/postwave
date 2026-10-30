# Klaviyo Migration-To-Live Source

Status: Migration adapter available; live Klaviyo account certification remains open.

Klaviyo also has a separate native `klaviyo` marketing-integration row. That row owns native credential lifecycle, scheduled profile/list/segment pulls, webhooks, and writeback foundations. This guide covers only the migration adapter and its cutover evidence.

## Authentication And Account Binding

Create a dedicated Klaviyo private API key with read access to accounts, profiles, lists, segments, flows, campaigns and campaign messages, templates, and forms. Reporting API, ecommerce, and SMS-runtime scopes are not part of this migration.

Create the migration job through:

```http
POST /api/v1/migrations/klaviyo/credentials
```

The supported interactive path is a dedicated private key sent as `api_key`. `account_id` is optional when the credential exposes exactly one Klaviyo account and required when it exposes more than one. Authentication validates `/accounts`, binds the job to the selected account, and rejects a later credential refresh for a different account.

Direct API and SDK callers may instead send a caller-managed OAuth access token as `access_token` (plus an optional `refresh_token`). The adapter then sends `Authorization: Bearer ...`. This is credential handoff only: the migration API does not start an authorization-code flow, exchange or refresh tokens, or become their lifecycle owner. The caller must obtain and rotate the token and submit a fresh `access_token` to the source-session refresh endpoint. Web, desktop, CLI, and MCP migration setup intentionally expose only the private-key path.

The migration adapter sends `Authorization: Klaviyo-API-Key ...` for `api_key` or `Authorization: Bearer ...` for `access_token`, and pins the Klaviyo `revision` header to `2026-07-15`. Do not confuse caller-managed migration bearer handoff with the separate native Klaviyo integration's managed OAuth install/refresh/revocation lifecycle.

For a tenant/account lineage that has not been rolled back, reuse the original Klaviyo migration job: refresh credentials and run delta/full snapshots on that job. Starting a second job for the same tenant/account is rejected to prevent duplicate active identities after an email change.

Profile inventory and changed-profile polling request `subscriptions,predictive_analytics`. Because `predictive_analytics` uses Klaviyo's stricter profile-read tier, the adapter throttles those requests below the documented 10 requests/second and 150 requests/minute limits instead of using the higher base profile limit.

## What Is Imported

- Email-addressable profiles using the primary email address exposed by Klaviyo's stable Get Profiles response, including the available primary-address subscription state, consent timestamps, custom properties, and predictive fields.
- Enumerated list and dynamic-segment membership snapshots represented as tag-backed destination segments after validated list-level suppressions are excluded. Counts and tags are the send-targetable projection; the adapter does not expose a separate raw Klaviyo membership count. Klaviyo names are nullable, so an unnamed audience receives the deterministic display fallback `Klaviyo list <id>` or `Klaviyo segment <id>`. Source predicates are retained as evidence but are not translated into live Klaviyo-equivalent predicates.
- Templates that expose rendered HTML. Structured-only templates become rebuild records.
- Sent email campaigns as immutable campaign-archive evidence. A sent campaign message must have a content definition or the adapter fails closed. Campaign tag relationships are preserved as provider IDs only; display names and groups are not hydrated. Campaigns are not recreated as executable campaigns, and Reporting API metrics or per-recipient activity are not imported.
- Sent SMS and mobile-push campaign records as non-executable source-archive evidence. They never become campaign-archive rows or destination channel runtime.
- Forms, non-sent campaigns, and structured-only templates as source-archive rebuild tasks. A draft/non-sent campaign message may have a null definition; metadata is retained, but content and channel settings then require provider-export recovery or explicit retirement.
- Eight unconditional static checklist/gap records covering commerce, reviews, service, CDP, Multi-Email Profiles, omni-channel state, deliverability, and marketplace dependencies. Each is a checklist row with `source_total=1`; none proves that the source account contains an object or provides source inventory.

## Rebuild-Only And Out-Of-Scope Resources

Klaviyo flows are always `rebuild_review`. Flow definitions and graph evidence are preserved so an operator can rebuild, test, or explicitly retire each flow, but Moosewave never activates a source flow automatically. Klaviyo can return a null flow definition; in that case available metadata is retained, the graph is explicitly not rebuild-complete, and the operator must recover it from a provider export or retire the flow.

The adapter does not import:

- Multi-Email Profile secondary addresses or their independent per-address consent/suppression state. Stable profile retrieval exposes only the primary address, so imported profile and consent counts are not automatic identity/consent parity.
- Klaviyo Reporting API metrics, opens, clicks, recipient activity, benchmarks, or report dashboards.
- SMS identities, SMS consent continuity, sender configuration, or executable SMS/WhatsApp/push runtime. Sent SMS and push campaigns can appear only as non-executable source-archive evidence.
- Ecommerce catalog, orders, carts, product feeds, reviews, CDP/warehouse configuration, service/helpdesk state, deliverability configuration, or marketplace integrations. The adapter emits one unconditional checklist row for each corresponding product area; that row is a migration obligation, not evidence that source inventory exists.
- Draft, scheduled, cancelled, or otherwise non-sent campaigns as sent history. They remain rebuild records, and a nullable campaign-message definition means content/settings recovery or explicit retirement is required.
- Form layout, targeting, A/B state, rewards, coupon behavior, or live capture installation.

## Dry-Run, Commit, And Verification

Use the normal reviewed lifecycle:

```http
POST /api/v1/migrations/klaviyo/discover
POST /api/v1/migrations/klaviyo/dry-run
POST /api/v1/migrations/klaviyo/commit
GET  /api/v1/migrations/{job_id}/verification
```

Discovery and dry-run warnings are migration evidence, not optional informational copy. Review profile exclusions, enumerated post-list-suppression send-targetable membership counts, templates without rendered HTML, nullable flow/draft-message definitions, campaign-channel and tag-ID warnings, and every flow/source-archive rebuild or checklist record before commit. Do not compare the membership counts to a raw Klaviyo count: the adapter does not expose one separately.

`resource_metadata` must include the eight static checklist resources: `ecommerce`, `reviews`, `service`, `cdp`, `multi_email_profiles`, `omni_channels`, `deliverability`, and `marketplace`. Each row has `source_total=1`, `imported=1`, `supported=false`, and `status=manual_rebuild_required`. Here, `imported=1` means a checklist/source-archive record was preserved; it does **not** mean that a corresponding Klaviyo resource was discovered or imported.

For `multi_email_profiles`, the underlying record is `klaviyo_multi_email_profiles`. Use a provider export or retained Klaviyo access to inventory and reconcile secondary identities, then attach the same non-secret evidence reference to both `klaviyo_consent_suppression_review` and `klaviyo_ecosystem_dependencies_review` before cutover.

Klaviyo discovery exposes explicit nonnegative inventory counts:

- `profiles_without_email_count`: profiles excluded from subscriber import because they do not have an email address.
- `source_archive_count`: total rebuild/source-archive rows. It always includes the eight unconditional static checklist rows described above, which do not prove source inventory, plus any actual flow, form, non-sent campaign, SMS/push campaign, or structured-template evidence records.
- `sms_campaigns_count`: sent SMS campaign records retained as non-executable source-archive evidence, not imported SMS identities, consent, or sending runtime.
- `push_campaigns_count`: sent mobile-push campaign records retained as non-executable source-archive evidence, not imported push identities, consent, or sending runtime.

A completed initial import is not cutover certification.

## Shadow Window And Mandatory Final Snapshot

Changed-profile polling can reduce drift during a shadow window:

```http
POST   /api/v1/migrations/sources/klaviyo/source-events
GET    /api/v1/migrations/{job_id}/source-events
DELETE /api/v1/migrations/{job_id}/source-events
```

The monitor polls profiles changed after its high-watermark and emits canonical profile upserts. If stable profile ID `P` was previously imported at email A and polling later sees `P` at email B while the source-owned A destination remains active, replay fails before any destination write. Run the full-snapshot/final delta to materialize B and disable A, then resume replay. The monitor also does **not** prove profile deletion, profiles that lost email addresses, secondary Multi-Email Profile identities, independent per-address consent, or current list/segment membership. It therefore cannot replace the final delta.

Before cutover:

1. Freeze Klaviyo profile, list, segment, campaign, template, form, and flow changes.
2. Run a final delta import. For Klaviyo this must be treated as a final full source snapshot, including fresh list and segment membership enumeration after validated list-level suppressions are excluded. Treat the resulting counts/tags as the send-targetable projection, not a separately available raw membership count.
3. Run a fresh shadow check and verification review against that final snapshot. Confirm every blocked stable-ID email transition has exactly one current destination identity: B is materialized and prior source-owned A is disabled before changed-profile replay resumes.
4. Rebuild, test, or explicitly retire every flow, including flows whose definitions are null; recover or retire draft campaign messages with null definitions; resolve campaign tag IDs against provider taxonomy where needed; and resolve every source-archive task, static checklist, and warning. Reconcile the `multi_email_profiles` record against a provider export or retained Klaviyo access, including every secondary address and its independent consent/suppression state.
5. Rehearse rollback and retain non-secret evidence for the credentialed run.

Do not certify a Klaviyo cutover from fixtures, an initial import, or changed-profile polling alone.

## Optional Live Validation

`scripts/validate-live-migrations.mjs` has an optional Klaviyo path. A credential/discovery smoke requires `KLAVIYO_API_KEY`; set `KLAVIYO_ACCOUNT_ID` when the key exposes multiple accounts. Any Klaviyo live-certification flag fails closed when credentials or a durable artifact directory are missing.

Strict pilot certification additionally requires commit plus rollback, source-event replay, the final full delta, a clean shadow check, rollback rehearsal, manual flow/rebuild review evidence, Multi-Email Profile evidence tied to consent and ecosystem review, and credential-cleanup evidence. Until a real account run passes those gates, the integration remains live-certification pending.

## Disconnect And Cleanup

Migration rollback removes or restores destination writes tracked by the migration ledger. It does not change Klaviyo data, stop Klaviyo sends, remove forms, retire flows, revoke a private API key or caller-managed bearer, or undo external DNS/billing/channel state. Rotate or revoke the supplied credential and complete provider-side cleanup separately after the rehearsal.

## Remaining Certification Work

- Live-certify account binding, pagination, rate limits, `Retry-After`, and pinned-revision behavior against a real Klaviyo account.
- Live-certify changed-profile polling plus final full-snapshot membership reconciliation.
- Live-certify provider-export or retained-account reconciliation of Multi-Email Profile secondary identities and independent per-address consent/suppression state.
- Live-certify sent-email campaign-archive fidelity, SMS/push source-archive fidelity, and rebuild evidence for non-sent campaigns/templates/forms.
- Live-certify flow rebuild review, rollback, credential rotation/revocation, reconnect, disconnect, and data-delete handling.

The native integration's OAuth, managed webhook, writeback, and provider-cleanup certification are tracked separately in [`docs/integrations/klaviyo.md`](./klaviyo.md).
