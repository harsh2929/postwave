# @postwave/mcp-server

Candidate source for a Moosewave Model Context Protocol (MCP) REST adapter. It
wraps portions of the Moosewave API for MCP-aware clients.

> **Release hold (2026-08-20).** Do not use this package for production or
> prospective-client workloads. The npm registry artifact at `0.1.0` was
> observed exposing 133 tools while this repository candidate contains 292;
> the package version therefore does not identify one reproducible catalogue.
> Hosted DNS/TLS/workload, OAuth, tenant isolation, and registry-to-source
> parity have not been qualified. A new immutable package version, digest, and
> installed-artifact probe are required before this hold can be lifted.

> **MIT licensed.** Source: [Moosewave monorepo](https://github.com/harsh2929/postwave/tree/main/packages/mcp-server). Issues, PRs, and forks welcome.

## What it does

- **Migrate** from Mailchimp, ActiveCampaign, Klaviyo, HubSpot, ConvertKit, Brevo, Substack, Beehiiv, MailerLite, Sendy, or CSV — agent-driven, with dry-run + 7-day rollback. ActiveCampaign uses rebuild-review automation evidence, source-event shadowing, and final-delta proof before cutover; HubSpot uses a private-app-token CRM bridge with contact/property/list evidence, source-event replay, final-delta proof, and rollback rehearsal gates. Beehiiv credential handoff binds one explicit publication; frozen segment/list snapshots, sent-post history, and premium metadata are preserved while automations remain rebuild-only and Stripe billing continuity stays separate. Klaviyo uses an account-bound private API key; the primary email identity exposed by stable Get Profiles, suppression-filtered send-targetable audience snapshots, editable templates, and sent email campaign archive rows import while sent SMS/push remains non-executable source-archive evidence. The adapter does not expose raw audience membership counts separately. Profile reads request `predictive_analytics` and follow its stricter 10/s, 150/m tier; unnamed lists and segments receive deterministic provider-ID fallbacks. Stable Get Profiles does not expose secondary email identifiers or their independent per-address consent/suppression state, so a mandatory source-archive/manual review is required and full profile identity/consent parity is never inferred. Incremental replay fails closed on a stable-profile email A→B move until the full snapshot materializes B and disables A. Nullable draft-message/flow definitions remain incomplete rebuild evidence, and campaign tags retain provider IDs rather than resolved names. Eight static product-area source-archive rows are unconditional checklists (`source_total=1` is one checklist record), not evidence that those products are used. Flows, dynamic predicates, non-email identities, reporting, and ecosystem dependencies remain explicit review/rebuild gates.
- **Diagnose** deliverability — campaign-level reports from the deployment's active controlled seed roster, SPF/DKIM/DMARC/BIMI checks, and AI Diagnostician fixes. Controlled observations remain unavailable until a real roster is configured.
- **Predict** placement before you send.
- **Generate** voice-fingerprinted email sequences using your existing writing.
- **Manage** subscribers, segments, forms, behavioral automations, and first-party integrations.
- **Compose + send** campaigns including A/B tests.

The current repository candidate contains 292 tool definitions, 11 resources,
and 11 worked-example prompts. Those counts describe this source checkout—not
the installed npm artifact or a deployed service. Resources and prompts are
structurally unadvertised until each has explicit reviewed scope metadata and a
bounded output contract. See
[Tool catalogue](#tool-catalogue).

## Installation status

`mcp_distribution_release_held` is authoritative. This README intentionally
contains no package command, client configuration, hosted URL, transport launch
command, or working-key example. The repository transport code is available for
security review, but a source checkout is not an installed or deployed product.

A supported setup may be documented only after a new immutable version and
digest, installed-artifact catalogue parity, complete authorization/output
classification, hosted tenant isolation, and MCP lifecycle qualification are
independently verified.

## Tool catalogue

Candidate source snapshot: 292 definitions across 32 tool families. This is not a
published-artifact or deployed-runtime inventory. Tool call inputs are
Zod-validated in the proxy. Only selected URL fields currently receive the
proxy's static literal-range check; each destination API fetcher remains the
authoritative SSRF boundary. Results are capped at 5 MB and normally time out
at 30 seconds.

Discovery and calls now fail closed when API-key scope introspection is
unavailable or a tool lacks explicit reviewed scope metadata. Scope metadata
coverage is incomplete, so only the classified subset is discoverable in this
candidate; destination API authorization remains authoritative. MCP
annotations are emitted only when explicitly declared and are untrusted client
UX hints, not approval evidence.

For source-level template integration tests, `MOOSEWAVE_MCP_PROFILE=templates`
limits the candidate registry to `campaign_template_*` tools. It does not lift
the distribution release hold or authorize a production connector.

To inspect an exact local tarball without publishing it, run
`pnpm --dir packages/mcp-server verify:candidate` from the repository root.
The check rebuilds, packs, extracts, and loads the tarball, compares its
template-tool catalogue with the fresh build, and prints the package SHA-256
and catalogue SHA-256. The package remains private and release-held; this
check does not establish npm-registry parity, hosted OAuth, tenant isolation,
or a working client credential.

**Migration (20)**

- `migrate_start` — begin OAuth for an OAuth-capable source; pass an existing callback `job_id` for same-job reconnect.
- `migrate_credentials` — create a job for a credential-backed source. Beehiiv requires an API key plus one explicit publication ID; this MCP surface exposes Klaviyo's private-key path with an optional explicit account ID. Caller-managed Klaviyo bearer handoff is direct API/SDK-only and is not managed migration OAuth. An unrolled-back Klaviyo tenant/account lineage must reuse its original job for credential refreshes and delta/full snapshots; a second same-account job is rejected. Both jobs remain bound to the authenticated provider account/publication.
- `migrate_discover` — pre-flight inventory; Mailchimp can repeat this with explicit `selected_audience_ids` as an informative scoped preview.
- `migrate_dry_run` — start verification without destination writes; Mailchimp audience IDs become the authoritative reviewed scope.
- `migrate_commit` — execute the reviewed migration; Mailchimp must repeat the exact normalized dry-run audience scope.
- `migrate_status` — poll the raw migration job, including progress, authoritative scope, verification report, and rollback deadline.
- `migrate_source_session_refresh` — refresh an expired encrypted source session on the same source-bound job without exposing the credential.
- `migrate_verification` — read the source-bound authoritative verification report; verification alone is not cutover acceptance, and Klaviyo's multi-email identity/consent limitation remains a mandatory manual-review record.
- `migrate_delta_import` — run the explicitly approved, post-freeze final delta; poll it to completion before evidence.
- `migrate_shadow_check` — compare fresh source discovery with the latest verification report and persist bounded check history.
- `migrate_shadow_monitor_start` — start approved recurring source checks during the controlled overlap window.
- `migrate_shadow_monitor_status` — read monitor configuration, errors, and recent source-check history.
- `migrate_shadow_monitor_stop` — stop future shadow observations only with explicit approval.
- `migrate_automation_rebuild_list` — list durable automation or Klaviyo flow rebuild, test, and waiver items.
- `migrate_automation_rebuild_update` — update one item with explicitly approved, non-secret test or waiver evidence.
- `migrate_rollback_rehearsal` — generate and persist approved rollback-readiness evidence without executing rollback.
- `migrate_pilot_acceptance` — read strict post-delta acceptance; any warning or blocker means not ready.
- `migrate_cutover_evidence` — record approved ActiveCampaign, Beehiiv, HubSpot, Klaviyo, or Customer.io evidence only after the latest successful final delta/full snapshot. An initial import is never cutover approval.
- `migrate_rollback` — start reverting eligible tracked destination writes within the 7-day window, subject to whole-job later-edit/later-job conflict checks; append-only consent/audit evidence remains.
- `migrate_rollback_status` — poll asynchronous rollback state and per-resource deleted/total counters.

**Deliverability and Campaign Assurance (12)**

- `diagnose_campaign` — run the AI Diagnostician on a sent campaign; returns ranked fixes.
- `predict_placement` — predict inbox placement (Primary / Promotions / Spam) before send from raw HTML + subject.
- `check_reputation` — domain + IP sender reputation snapshot.
- `check_auth` — SPF, DKIM, DMARC, BIMI status.
- `render_cross_client` — render an HTML email across Gmail, Outlook, Apple Mail, Yahoo, etc.
- `inbox_report` — full Inbox Reality report for a campaign across the seedlist.
- `render_preview_html` — render unsaved HTML without implying that it passed Campaign Assurance.
- `campaign_assurance_run` — start a durable, potentially billable Predicted Agent Comprehension run over an exact revision and plan.
- `campaign_assurance_get` — read the latest receipt or an exact run, manifest, evidence, or aggregate progress snapshot.
- `campaign_assurance_apply_fix` — after explicit approval, apply only one server-stored deterministic patch under an exact strong campaign ETag; creates a new revision, stales the old run, and requires rerunning assurance.
- `campaign_assurance_override` — record a governed owner/admin decision for one immutable finding; it never changes content.
- `campaign_assurance_cancel` — cancel a queued/running run without erasing its evidence.

**Voice + Sequences (5)**

- `voice_profile_get` — current tenant voice fingerprint.
- `voice_source_add` — register a new ingestion source (RSS, Twitter, transcript, paste).
- `voice_profile_build` — rebuild the profile from currently-ingested sources.
- `sequence_generate` — generate a sequence from one of the 50 templates in the user's voice.
- `sequence_regenerate_email` — regenerate a single email in a sequence with an optional hint.

**Subscribers + Segments (10)**

- `subscribers_list`, `subscribers_search`, `subscriber_create`, `subscriber_suppress`.
- `custom_field_create` — declare a tenant custom field.
- `segment_create`, `segment_list`, `segment_delete` — manage saved segments.
- `segment_compile_from_text` — natural-language → SegmentNode AST.
- `segment_eval` — evaluate a canonical AST and return matching count + sample.

**Push suppression authority (5)**

- `push_suppression_list` — exact-admin read of one tenant-bound private snapshot page. It returns minimized 16-hex fingerprints and an opaque cursor, never raw customer tokens or full digests.
- `push_suppression_add` — after explicit approval, add or reassert one reversible `manual`/`dashboard` hold for a tenant-customer APNs, FCM, or Web token. The raw token is sensitive input only and must never enter logs or evidence.
- `push_suppression_remove` — exact-admin compare-and-swap removal of one reviewed manual row using its `expected_version`. Locked authority remains fail-closed, and `stillSuppressed=true` means another independent authority remains.
- `push_suppression_bulk_import` — atomically add or reassert 1–100 unique manual holds. Raw tokens are sensitive input only; any invalid, duplicate, storage, or audit result rolls back the operation.
- `push_suppression_bulk_remove` — atomically compare-and-swap remove 1–100 reviewed manual rows. One stale, missing, locked, invalid, storage, or audit result rolls back every removal.

List membership is pinned by a monotonic visibility revision. `snapshotAt` is
response-observation metadata rather than a row timestamp cutoff, so a valid
row timestamp may be later after database clock rollback.

These exact-admin tools govern a private tenant-customer APNs/FCM/Web registry,
not operator Expo devices. They do not lift the current **HOLD / NO-GO** on
customer push runtime, audience materialization, APNs/FCM providers, or
automatic provider feedback. Web is registry-only. Registry state is not proof
that a live send excluded or processed a customer token, and the MCP candidate
itself remains distribution-release-held as described above.

**Forms (5)**

- `form_create`, `form_update`, `form_delete`, `form_submissions_list`.
- `optin_confirm` — confirm a pending double-opt-in via token.

**Automations (6)**

- `automation_create`, `automation_list`, `automation_update`.
- `automation_create_behavioral_trigger` — wire open/click/no-open triggers.
- `automation_trigger` — fire for one subscriber.
- `automation_pause` — pause OR resume an automation.

**Campaigns + A/B (5)**

- `campaign_create`, `campaign_send`, `campaign_create_ab`, `campaign_ab_results`.
- `send_test_email` — one-off transactional preview.

**Visual campaign templates (40)**

- `campaign_template_search`, `campaign_template_compare`, `campaign_template_get` — page through stable server-sorted design metadata, compare 2–4 IDs/slugs, then fetch editable source only for a selected newsletter.
- `campaign_template_favorite`, `campaign_template_unfavorite` — idempotently manage the API-key-bound user's private favorites; legacy unbound keys fail closed.
- `campaign_template_recent_record`, `campaign_template_recent_list`, `campaign_template_recent_clear` — maintain the authenticated user's bounded recent history.
- `campaign_template_collection_list`, `campaign_template_collection_get`, `campaign_template_collection_create`, `campaign_template_collection_update`, `campaign_template_collection_replace_items`, `campaign_template_collection_delete` — manage user-private named collections with atomic ordered membership.
- `campaign_template_saved_search_list`, `campaign_template_saved_search_get`, `campaign_template_saved_search_create`, `campaign_template_saved_search_update`, `campaign_template_saved_search_results`, `campaign_template_saved_search_delete` — persist reusable filters (never cursors) and run them through opaque keyset pagination.
- `campaign_template_create`, `campaign_template_update`, `campaign_template_clone` — manage editable tenant-owned designs; updates require the exact current ETag so stale agents cannot overwrite newer work.
- `campaign_template_change_preview`, `campaign_template_change_apply` — review and apply one unambiguous exact HTML/MJML source-fragment change under a strong ETag and preview hash; they never compile or send.
- `campaign_template_revisions`, `campaign_template_revision_get` — inspect compact immutable history and fetch a selected full snapshot.
- `campaign_template_archive`, `campaign_template_restore` — recoverably hide or restore editable templates with explicit ETag concurrency guards. `campaign_template_delete` remains a deprecated safe-archive alias and never permanently deletes content.
- `campaign_template_adapt`, `campaign_template_generate` — start a durable design job from a chosen inspiration or up to three internal references.
- `campaign_template_design_list` — recover the exact authenticated actor's active, non-expired design jobs as compact newest-first pages with actor-bound cursors.
- `campaign_template_design_get`, `campaign_template_design_revisions` — poll status and inspect immutable, validated outputs.
- `campaign_template_design_refine`, `campaign_template_design_retry` — queue a revision or safely retry the exact failed request.
- `campaign_template_save` — persist only a reviewed `revision` + `output_hash`; caller-supplied generated HTML is not accepted.
- `campaign_template_design_create_campaign`, `campaign_template_design_archive` — create a never-sent campaign draft from an exact revision or archive abandoned work.
- `campaign_create_from_template` — create an editable campaign draft; sending remains a separate approval-gated action.

Every durable design mutation requires a caller-stable `idempotency_key` (1–255 control-free characters). Reuse it only when retrying the exact unchanged mutation after a lost or uncertain response; use a new key whenever any input changes.

**Topics (5)**

- `topic_create`, `topic_list`, `topic_delete`, `topic_subscribe`, `topic_unsubscribe`.

**Admin — Webhooks + API Keys (8)**

- `webhook_create`, `webhook_list`, `webhook_delete`, `webhook_test_fire`, `webhook_deliveries_list`.
- `api_key_create`, `api_key_list`, `api_key_revoke` — privileged; require explicit human approval.

**Agent primitives (6)**

- `audit_query`, `approvals_list`, `approvals_decide`, `sandbox_status`, `cost_aggregate`, `safety_check`.

**Events (1)**

- `events_subscribe` — declarative subscription; events flow to `moosewave://events/stream`.

**Integrations (23)**

- `integrations_catalog`, `integrations_connections` — search catalog tiles and inspect installed connector health.
- `native_integration_providers`, `native_integration_list`, `native_integration_get` — discover first-party providers and read stored connections. Support provider discovery is static; support list/detail rows are tenant-bound minimized historical projections with held runtime status, not evidence of live credentials, callbacks, synchronization, or run history. Support lists accept `limit` (1–100, default 50) plus an opaque `cursor`; detail reads require a lowercase canonical UUID.
- `native_integration_create` — create native connections for released families. Support creation fails locally with `support_integration_runtime_held` and sends no SDK request.
- `native_integration_sync`, `native_integration_backfill` — run family-aware sync/backfill jobs, or import canonical rows for released ingest-backed connectors. Support effects fail locally with `support_integration_runtime_held` and send no SDK request.
- `native_integration_pause`, `native_integration_disconnect`, `native_integration_runs` — operate and inspect released connection lifecycles. Support lifecycle and run-history tools fail locally with `support_integration_runtime_held` and send no SDK request.

## Resources

**Release-held:** these source definitions are not registered or advertised by
the candidate server. They remain an implementation inventory only.

- `moosewave://voice-profile` — current voice fingerprint JSON (~3 KB).
- `moosewave://recent-migrations` — last 10 migration jobs.
- `moosewave://recent-campaigns` — last 10 campaigns with placement summaries.
- `moosewave://templates` — full 50-template library.
- `moosewave://campaign-templates` — compact first page of the visual newsletter design library.
- `moosewave://campaign-templates/{template_id}` — one design with provenance and editable HTML/MJML when available (templated).
- `moosewave://sequences` — active sequences for the tenant.
- `moosewave://campaign-assurance/{campaign_id}` — latest applicable receipt with explicit source-class provenance (templated).
- `moosewave://inbox-reality/{campaign_id}` — full report for a specific campaign (templated).
- `moosewave://events/stream{?type,campaign}` — latest 50 deliverability events; pull-only, poll every 10–30s (templated, FF).

## Prompts

**Release-held:** these source definitions are not registered or advertised by
the candidate server because several direct agents toward held or unclassified
mutations.

Eleven non-invocable source-design examples retained for future review:

- `migrate-from-mailchimp`
- `diagnose-last-campaign`
- `write-welcome-sequence`
- `improve-deliverability`
- `audit-list-hygiene`
- `weekly-digest-from-rss`
- `re-engage-cold-subscribers`
- `email-from-jsx`
- `email-from-markdown`
- `assure-campaign-before-send`
- `setup-double-optin-form`

## Troubleshooting

- **Can I install or connect this package through a supported setup?** No.
  Public distribution and setup guidance remain release-held. A manually built
  source checkout can execute with a supplied API key, but that is unsupported
  private evaluation and carries no governed-write or compatibility guarantee.
- **Can I use the hosted connector?** No hosted/OAuth MCP deployment is
  qualified.
- **What does the catalogue prove?** Source definition inventory only; not
  installed discovery, authorization, output safety, or execution parity.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues: [SECURITY.md](./SECURITY.md).

## License

MIT. See [LICENSE](./LICENSE).
