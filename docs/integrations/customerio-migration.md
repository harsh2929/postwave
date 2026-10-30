# Customer.io Migration-To-Live Source

Status: Migration adapter available; repository verification and live Customer.io workspace certification remain open.

Customer.io also has a separate native `customerio` marketing-integration row. That row owns credential-reference lifecycle, pause/disconnect state, run history, and delegated migration handoff evidence. This guide covers the read-only App API migration adapter and the evidence required before cutover. It does not describe Track API writes or a native Customer.io runtime.

Customer.io renamed parts of its product UI in 2026: People are Profiles, Campaigns are Automations, and Newsletters are One-time sends. The App API retains the `/customers`, `/campaigns`, and `/newsletters` endpoint names used below.

## Authentication, Region, And Workspace Binding

Create a dedicated **App API key** with read access to every surface in scope. Do not use a Track API site ID/key: Track and Pipelines credentials are write-side ingestion credentials and cannot authenticate this import.

Create the migration job through:

```http
POST /api/v1/migrations/customerio/credentials
```

Send the App API key as `api_key`, choose `region` as `us` or `eu`, and optionally provide the numeric workspace ID as `account_id`. US uses `https://api.customer.io`; EU uses `https://api-eu.customer.io`. Moosewave validates `/v1/workspaces`, binds the encrypted session to the exact region and workspace, and sends `X-Workspace-Id` on subsequent requests. When the key exposes more than one workspace, explicit workspace selection is mandatory. A credential refresh cannot switch region or workspace.

For a tenant/workspace lineage that has not been rolled back, reconnect or continue the original migration job. A second active job for the same workspace is rejected, and destination writes share a workspace-scoped execution lease. This prevents concurrent jobs from claiming the same immutable Customer.io profile identity.

The general App API limit is 10 requests per second. The adapter admits at most nine requests per second to leave headroom and treats provider `429`/`Retry-After` responses as authoritative. Transactional-send-specific quotas do not apply to these read traversals.

Primary official references:

- [Customer.io App API reference](https://docs.customer.io/integrations/api/app/)
- [Customer.io API overview and credential types](https://docs.customer.io/integrations/api/customerio-apis/)
- [Customer.io App API OpenAPI document](https://docs.customer.io/files/journeys-app.json)
- [Exporting profiles](https://docs.customer.io/messaging/profiles/manage/exporting-users/)
- [Subscription options and channel preferences](https://docs.customer.io/messaging/channels/subscriptions/overview/)
- [Fetching topic and channel preferences](https://docs.customer.io/messaging/channels/subscriptions/set-preferences-outside-center/)

## Complete Profile Snapshot

`GET /v1/customers` is not an account-wide listing endpoint; it requires an email lookup. Moosewave performs two complete cursor-paginated `POST /v1/customers` searches instead: profiles where email exists and profiles where email does not exist. Every email-addressable result is then hydrated through the attributes and subscription-preferences endpoints with `id_type=cio_id`. The subscription-preferences response contains both subscription-topic preferences and channel-type preferences such as `email`; both are distinct from `/v1/optouts`.

Customer.io's immutable `cio_id` is the canonical source identity. Publisher IDs and email addresses can change, and separate profiles can share one email when email is not configured as a workspace identifier. Moosewave therefore:

- traverses, deduplicates, fingerprints, and ledgers profiles by `cio_id`;
- counts profiles without email separately instead of inventing destination email subscribers;
- preserves duplicate-email merge/conflict evidence when multiple `cio_id` values converge on one email-keyed destination subscriber;
- blocks cross-job ownership of the same active `cio_id`; and
- requires a later full snapshot to reconcile email moves, deletions, and profiles that lose email.

Customer.io exposes no complete incremental profile change feed for this migration contract. There is no Customer.io source-event monitor. Every delta, especially the final delta, is an authoritative full source snapshot.

## Subscriber, Consent, And Suppression Mapping

The adapter retains arbitrary non-system profile attributes and exact segment/topic snapshot tags. Customer.io timestamps such as profile creation or email-added time are provenance, not portable opt-in proof; `consent_timestamp` remains unset and `consent_source` remains `unknown` unless a separate reviewed proof is attached.

Email status is deliberately conservative:

- any matching ESP block, bounce, spam report, or invalid-email suppression becomes `blocklisted`;
- `unsubscribed=true` becomes `disabled`;
- email enablement requires all three applicable Customer.io layers to allow the send: global `unsubscribed=false`, the resolved email channel preference is subscribed (explicitly or by its configured default), and the applicable subscription topic is subscribed (explicitly or by its configured default);
- when no subscription-center topic applies, the topic layer does not add permission, and the global plus resolved email-channel layers must still allow email; and
- missing, malformed, or incomplete global/email-channel/topic evidence becomes `unconfirmed`, never implicitly enabled.

Subscription topics and subscription-center channel preferences are hydrated for every email-addressable profile. Opted-in topic membership becomes a source-qualified destination tag and a frozen tag-backed segment. Topic and channel definitions, including their configured defaults, are preserved in source archive; discovery reports the exact channel-definition count as `subscription_channels_count`. Channel preferences apply to a channel type as a whole: an email channel preference is not an email-sender opt-out.

`GET /v1/optouts` is a different contract. It returns only sender-specific SMS/WhatsApp opt-outs, where one profile can reject one `from` sender while remaining reachable from another sender on that channel. Those records are retained as non-email source evidence; they do not determine email status or import phone identity, sender registration, or channel runtime.

The four App API ESP suppression collections—blocks, bounces, spam reports, and invalid emails—are traversed completely. Their presence blocks the destination address and remains separately auditable. Customer.io workspace-level GDPR suppression is distinct from these ESP collections and may require a provider/support export.

## What Is Imported

| Resource                   | Migration behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email-addressable profiles | Imported under immutable `cio_id` with current email, non-system attributes, conservative global/email-channel/topic status, exact frozen audience tags, and ESP suppression evidence.                                                                                                                                                                                                                                                                                                                               |
| Profiles without email     | Counted explicitly and excluded from the email-keyed destination. Phone, device, push, and identifier-only continuity requires a separate migration or retirement decision.                                                                                                                                                                                                                                                                                                                                          |
| Segments                   | Exact membership is enumerated and frozen into source-qualified tag-backed destination segments. Customer.io does not expose complete dynamic rules through the App API, so predicates must be rebuilt or retired.                                                                                                                                                                                                                                                                                                   |
| Subscription topics        | Definitions and exact opted-in membership are preserved as tag-backed snapshots. Destination preference-center meaning and send scoping still require review.                                                                                                                                                                                                                                                                                                                                                        |
| Subscription channels      | Definitions/defaults are preserved and counted exactly in `subscription_channels_count`; resolved per-profile state contributes to conservative email status. These are channel-type preferences, not sender-specific opt-outs.                                                                                                                                                                                                                                                                                      |
| Design Studio templates    | Reusable emails with non-empty default `content.html` become editable templates using that exact source HTML—not provider-rendered output. Localized variants and the complete source definition are retained. Customer.io components, Liquid, global styles/assets, and transformers are not executed and require destination validation; a no-HTML definition remains a rebuild record.                                                                                                                            |
| Sent email one-time sends  | Only `/newsletters` records with `type=email`, a real `sent_at`, at least one email content whose `language` is explicitly `""`, and provably composable source HTML become immutable campaign archive. The lowest stable content ID in that default/A-B set is the representative; all variants remain source evidence and multiple defaults emit an explicit representative-selection warning. A missing explicit default or invalid language metadata fails closed, and a translation is never selected silently. |
| Source archive             | Campaign/automation definitions/actions; API-broadcast definitions/actions plus trigger IDs and created/processed timestamps; every newsletter definition/variant; transactional definitions/content; topic/channel definitions; ESP suppressions; sender-specific SMS/WhatsApp opt-outs; object-type metadata; unrenderable Design Studio definitions; and static review tasks. Original API-broadcast trigger payloads, audiences, and per-user data are not returned and remain manual reconciliation.            |

## Rebuild-Only And Out-Of-Scope Resources

Customer.io Campaigns/Automations and API-triggered Broadcasts are not one-time newsletter history. The App API exposes workflow metadata and actions, but not a portable executable graph. They remain `customerio_campaign_workflow` and `customerio_broadcast_workflow` source records for rebuild/test/retirement; Moosewave never activates them automatically.

Transactional definitions and available content are retained as `customerio_transactional_message` records. Trigger names/IDs, delivery guarantees, sender identity, event wiring, and runtime history must be rebuilt and tested separately. Draft/unsent newsletters and sent non-email newsletters remain source evidence, never email campaign history.

Newsletter HTML is source composition, not Customer.io rendering. A missing or empty layout uses the exact non-empty source body with a fidelity warning. A non-empty layout is composed only when it contains exactly one documented `{{content}}` slot, including whitespace-equivalent forms such as `{{ content }}`. Missing bodies, non-string layouts, and layouts with zero or multiple slots remain source-archive-only. Moosewave does not execute Liquid, preprocess CSS, resolve assets, or perform per-recipient rendering.

Object-type metadata is inventoried, but complete object profiles and relationships are not claimed. Customer.io object search requires an attribute filter and can duplicate records across pages; use the Customer.io export workflow for complete object/relationship reconciliation.

Eight unconditional `customerio_migration_checklist` rows cover:

1. historical profile and behavioral events;
2. lifetime delivery/report history;
3. original API-broadcast trigger payloads, audiences, and per-user data (the App API rows preserve trigger ID plus created/processed timestamps only);
4. custom object profiles and relationships;
5. Connected Forms;
6. commerce data;
7. collections, snippets, assets, and design components; and
8. sender/channel/deliverability configuration.

Each row is a static review obligation (`source_api_inventory=false`), not proof that the workspace uses the product or that data moved.

The adapter does not import or certify:

- Track/Pipelines writes, Customer.io event ingestion, or an incremental profile change feed;
- complete historical activities, deliveries, opens, clicks, conversion reports, or per-recipient lifetime history;
- phone/device identities, SMS, WhatsApp, push, in-app, LINE, Slack, or webhook runtime and consent continuity;
- complete custom object profiles/relationships, forms, commerce data, collections, snippets, assets, or external integrations;
- sender verification, domains, DNS, branded links, SSL, IP pools/warmup, channel credentials, or provider-side cleanup; or
- Customer.io-side deletion, pausing, or workflow retirement.

## Dry-Run, Commit, And Verification

Use the normal reviewed lifecycle:

```http
POST /api/v1/migrations/customerio/discover
POST /api/v1/migrations/customerio/dry-run
POST /api/v1/migrations/customerio/commit
GET  /api/v1/migrations/{job_id}/verification
```

Discovery is a complete, bounded snapshot. It rejects cursor cycles, duplicate or malformed IDs, membership outside the profile snapshot, incomplete topic or channel preferences, inconsistent child identities, invalid pagination metadata, and source-shape drift. Before the first subscriber write, commit re-traverses the full profile snapshot and validates the complete custom-field schema.

The verification report must prove exact discovery-bound counts for subscribers, segments/topics, subscription-channel definitions, editable templates, sent-email archive, and source archive. Review `profiles_without_email_count`, `subscription_channels_count`, duplicate merges, unknown consent, suppressions, SMS/push newsletter counts, every resource-completeness row, and all static/rebuild records. Archive/checklist preservation is evidence, not permission to send.

Every successful destination-writing run stores a bounded, non-reversible full-source fingerprint plus a fresh opaque import epoch. The fingerprint covers:

- `cio_id`, current email/status/fields, segment/topic tags, global/email-channel/topic preference state, and suppression projection;
- a non-reversible digest over the complete sorted `cio_id` set for profiles without a usable email, including invalid-email rows returned by the email-exists search;
- segment and topic snapshot definitions;
- editable Design Studio templates;
- sent email one-time-send archive; and
- the complete source archive.

A credentialed shadow check fully re-traverses those six components. Same-count edits, non-email identity replacements, or deletions therefore invalidate the final-delta baseline. Each shadow attempt is also bound to its current durable attempt token, import epoch, and baseline fingerprint so stale or pre-delta evidence cannot approve cutover.

## Mandatory Final Snapshot And Six Reviews

Before cutover:

1. Inventory and freeze relevant Customer.io profile, audience, subscription, template, newsletter, automation, broadcast, transactional, object, and integration changes.
2. Run a final delta import on the original job. For Customer.io, this is a complete authoritative snapshot, not incremental polling.
3. Reconcile every `cio_id`, duplicate-email merge, email move, deletion, lost-email profile, non-email profile, segment membership, global unsubscribe, resolved email-channel preference/default, and applicable topic preference/default against reviewed provider evidence.
4. Run a fresh credentialed shadow check bound to the final import epoch/fingerprint, review resource completeness, and resolve every warning or rebuild task.
5. Rehearse conflict-aware rollback while the rollback window remains open.
6. Record all six post-final-delta Customer.io evidence gates and pass pilot acceptance:

| Evidence key                               | Required review                                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customerio_consent_subscription_review`   | Global unsubscribe, subscription-center email-channel preference/default, applicable topic preference/default, ESP suppressions, GDPR suppression/export gaps, and any actual consent proof. Email is eligible only when every applicable layer allows it. |
| `customerio_identity_audience_review`      | Immutable `cio_id`, duplicate emails, moves/deletions/lost email, final segment/topic snapshots, and dynamic-rule rebuild/retirement.                                                                                                                      |
| `customerio_automation_rebuild_review`     | Campaign/Automation, API-broadcast, transactional, template, trigger, and source-retirement rebuild/test evidence.                                                                                                                                         |
| `customerio_channel_dependency_review`     | SMS, push, in-app, Slack, WhatsApp, webhook, phone/device identity, consent, sender, quiet-hour, routing decisions, and sender-specific SMS/WhatsApp `/v1/optouts`.                                                                                        |
| `customerio_deliverability_review`         | Destination sender/domain/DNS/link/SSL/IP/warmup, bounce/complaint handling, suppression continuity, and rollback ownership.                                                                                                                               |
| `customerio_ecosystem_dependencies_review` | Objects, events, Data Pipelines, reporting webhooks, destinations, forms, commerce, content libraries, analytics/export retention, and external integrations.                                                                                              |

Rollback uses the migration write ledger: it removes records created by the job and restores tracked before-images only when the destination still matches the recorded after-image and ownership evidence. It does not undo sends, mutate Customer.io, restore a source workflow, or change billing/DNS/channel state. A conflict blocks rollback instead of overwriting newer or ambiguous destination state.

## Certification Status

Repository-level implementation and tests are necessary but not sufficient. No real Customer.io workspace and isolated live destination have yet completed the strict certification matrix. Do not describe the integration as live-certified or self-serve production-ready until a frozen candidate proves region/workspace binding, real multi-page responses, 10-request/second throttling and `429` handling, global plus email-channel plus applicable-topic eligibility (including configured defaults), the separate sender-specific SMS/WhatsApp `/v1/optouts` contract, per-domain ESP/GDPR suppression semantics, duplicate-email/deletion/non-email-identity reconciliation, full fingerprints/shadow binding, rebuild fidelity, destination-state rollback rehearsal and rollback, and credential cleanup.
