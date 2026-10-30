// Moosewave docs - per-source migration guide.
//
// One static guide per ESP. Each guide covers: authentication mode, what
// migrates, what does NOT migrate, the in-app walkthrough, expected timing,
// and common errors.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { Callout } from "@/components/docs/Callout";
import { CodeBlock } from "@/components/docs/CodeBlock";

interface PageProps {
  params: Promise<{ source: string }>;
}

interface Guide {
  slug: string;
  name: string;
  authType:
    | "OAuth"
    | "API key"
    | "App API key"
    | "Private app token"
    | "API token + account API URL"
    | "CSV upload";
  eta: string;
  migrates: string[];
  doesNotMigrate: { item: string; why: string }[];
  steps: { title: string; body: string }[];
  errors: { situation: string; cause: string; fix: string }[];
  apiSource: string;
}

const GUIDES: Record<string, Guide> = {
  mailchimp: {
    slug: "mailchimp",
    name: "Mailchimp",
    authType: "OAuth",
    eta: "20 minutes for a 50k-subscriber audience, plus report/template archive time",
    migrates: [
      "Selected audiences and subscribers with status, available consent provenance, tags, interests, and merge-field attributes",
      "Custom fields as mapped canonical fields or preserved subscriber attributes",
      "Static segment membership and the supported subset of saved-segment predicates; unsupported predicates are called out for manual rebuild",
      "Native Mailchimp tags plus audience and static-segment membership tags",
      "Suppression list (bounces, complaints, unsubscribes)",
      "The validated Classic welcome-series subset as paused runtime records after destination audience and template references are resolved",
      "Campaign archive, report payloads, editable templates, signup forms, landing-page/ecommerce source evidence, and explicit rebuild tasks where exposed",
    ],
    doesNotMigrate: [
      {
        item: "Customer Journey / Automation Flow execution graphs",
        why: "Mailchimp's public Marketing API does not expose a general Journey graph export. Moosewave records an explicit source-archive/manual-review gap instead of fabricating an executable automation.",
      },
      {
        item: "Mandrill transactional templates",
        why: "Mandrill (Mailchimp Transactional) is a separate product with its own API surface and is not part of a Marketing API migration. Rebuild transactional sends on Moosewave's own send API (POST /api/v1/emails), or keep them at your existing provider.",
      },
      {
        item: "Unsupported saved-segment behavior",
        why: "Mailchimp-specific rating, engagement, date, and ecommerce predicates that cannot be proven against imported subscriber fields remain manual-review items.",
      },
      {
        item: "RSS-driven campaigns",
        why: "Sent campaigns can appear in history, but the RSS schedule and feed-trigger behavior must be rebuilt and tested in Moosewave.",
      },
      {
        item: "Mailchimp webhooks and Mandrill",
        why: "Webhook subscriptions are provider configuration, and Mandrill is a separate API product. Recreate integrations after cutover.",
      },
    ],
    steps: [
      {
        title: "Open the migration wizard",
        body: 'Sign in to Moosewave, then go to Migrations and click "Start a migration". Choose Mailchimp.',
      },
      {
        title: "Authorize Moosewave",
        body: "You'll be redirected to login.mailchimp.com. Mailchimp grants a Marketing API OAuth token tied to the approving user's role; use an admin user for a complete discovery.",
      },
      {
        title: "Pre-flight inventory",
        body: "Moosewave shows the inventories Mailchimp returned, along with discovery warnings. Review warnings before treating a zero count as an empty source.",
      },
      {
        title: "Choose audiences",
        body: "Select one, many, or all Mailchimp audiences. The dry run and commit use the same scope for audience-bound contacts and merge data, groups/interests, segments, signup-form and audience-schema evidence, list-triggered Classic Automations, campaigns, and reports. Templates, landing pages, and ecommerce evidence are account-wide; other source-archive guidance is account-global or non-detected, and all of it is labeled for review.",
      },
      {
        title: "Dry run",
        body: 'Click "Run dry-run". Moosewave reads and validates the selected scope without writing destination records. If the saved Mailchimp session is unavailable, reconnect the same migration job. The report separates runtime imports, partial translations, preserved rebuild evidence, manual rebuild requirements, and unsupported resources.',
      },
      {
        title: "Commit",
        body: 'Review the report, including every account-global resource label, then click "Commit". The same selected-audience IDs are sent again. Live commit requires a dedicated Listmonk process whose configured tenant ID exactly matches the authenticated tenant. Progress is durable and can be reopened from the migrations list; do not infer completeness from an estimate alone.',
      },
      {
        title: "Verify and (optionally) roll back",
        body: "Spot-check destination subscribers, audience memberships, static segments, templates, and paused Classic Automation runtime records. The API cannot inventory Customer Journeys, so attach a manual Mailchimp Journey rebuild/waiver checklist; do not treat the generic warning as a zero count. Rollback first verifies exact tracked after-images and ownership for the whole job; conflicts stop cleanup. It then removes job-created records and restores recorded before-images. Append-only consent/audit history remains with compensating rollback evidence.",
      },
    ],
    errors: [
      {
        situation: "OAuth consent was not completed",
        cause: "User declined the OAuth consent screen.",
        fix: "Restart the migration; ensure the user has admin role on the Mailchimp account.",
      },
      {
        situation: "Workspace contact limit reached",
        cause: "The import would exceed the contact limit shown in Billing.",
        fix: "Review the live contact limit in Billing, then upgrade or reduce the selected audience scope before retrying.",
      },
      {
        situation: "Mailchimp temporarily throttled inventory",
        cause:
          "Mailchimp reported too many simultaneously processing requests.",
        fix: "Moosewave pauses according to Retry-After when present and resumes from durable job state. If the job fails, keep its displayed error and job ID for support.",
      },
    ],
    apiSource: `curl -X POST "https://api.moosewave.com/api/v1/migrations/mailchimp/oauth/start" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json"

# Open the returned authorize_url. The OAuth callback returns a job_id.

curl -X POST "https://api.moosewave.com/api/v1/migrations/mailchimp/dry-run" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"job_id\\": \\"$JOB_ID\\", \\"selected_audience_ids\\": [\\"$AUDIENCE_ID\\"] }"

curl -X POST "https://api.moosewave.com/api/v1/migrations/mailchimp/commit" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"job_id\\": \\"$JOB_ID\\", \\"selected_audience_ids\\": [\\"$AUDIENCE_ID\\"] }"`,
  },
  activecampaign: {
    slug: "activecampaign",
    name: "ActiveCampaign",
    authType: "API token + account API URL",
    eta: "30-90 minutes for a controlled-cutover dry run, depending on CRM and campaign history size",
    migrates: [
      "Email-addressable contacts, phone, custom fields, source IDs, tags, and channel-specific list evidence; unsafe consent/exclusion states remain unconfirmed",
      "Email-less and phone-only contacts as review evidence instead of fabricated email subscribers",
      "Lists as executable tag-backed Moosewave segments; saved summaries from `/audiences` and details from `/segmentsV2/{id}` are preserved for review",
      "Completed campaign archive hydrated from campaign detail and linked message HTML/text, with aggregate metrics where exposed",
      "Automation summaries plus available blocks, goals, linked campaigns, and SMS relationships as rebuild/review definitions; no ActiveCampaign automation is activated until rebuilt and tested",
      "Messages/templates, forms, CRM, available custom-object schemas/records, ecommerce order/relationship evidence, and SMS broadcasts as read-only source archive records",
      "Changed-contact source events through fixed overlap windows drained in ascending contact ID order",
    ],
    doesNotMigrate: [
      {
        item: "Editable templates, landing pages, and hosted forms as ready-to-publish Moosewave surfaces",
        why: "Message/template and form records are preserved as rebuild evidence; landing pages are not imported in this adapter slice. Rebuild and review these surfaces in Moosewave before switching capture points.",
      },
      {
        item: "Executable ActiveCampaign automations",
        why: "ActiveCampaign automation definitions are preserved for rebuild review. They are not materialized into live Moosewave automation rows because unsupported nodes, goals, CRM/ecommerce triggers, and SMS steps need owner testing before activation.",
      },
      {
        item: "Live SMS sending before carrier registration",
        why: "US A2P 10DLC and toll-free verification must be approved before Moosewave can send production SMS.",
      },
      {
        item: "Custom object, CRM, and ecommerce trigger execution on day one",
        why: "Available schemas, records, orders, and relationships are preserved first, but schema/order counts do not prove every custom-object or ecommerce relationship is complete. Executable trigger parity requires reviewed rebuilds.",
      },
    ],
    steps: [
      {
        title: "Create an ActiveCampaign API token",
        body: "Open Settings → Developer → API Access in ActiveCampaign and copy the account API URL plus API token. Use a dedicated migration user because API tokens follow that user's account access.",
      },
      {
        title: "Connect in Moosewave",
        body: "Go to Migrations → ActiveCampaign, paste the exact Developer-tab API URL and token, then start discovery. HTTPS one-label account hosts under `api-us1.com` or `activehosted.com` work by default; a different provider-issued hostname must be authorized by the deployment operator through the exact-host allowlist. Moosewave validates `/users/me` and binds later reconnect/cutover work to that same account.",
      },
      {
        title: "Review the inventory",
        body: "Compare email-addressable and email-less contacts, lists, tags, exclusions, hydrated campaigns, automation rebuild definitions, CRM, available custom-object/ecommerce records, and SMS broadcast counts against ActiveCampaign.",
      },
      {
        title: "Run a dry run",
        body: "Moosewave reads base contacts with ID pagination and produces a resource-by-resource parity report. List status and subscription dates remain provenance; unknown consent or exclusion coverage stays unconfirmed. Saved segments and automations appear as rebuild review inventory, not activated runtime targeting or automations.",
      },
      {
        title: "Shadow and cut over",
        body: "Keep ActiveCampaign live, enable fixed-window source-event monitoring for the full overlap, test or approve rebuilds, freeze edits, then run final delta import. Returned same-source contacts replace provider-owned tags and fields, but polling cannot prove hard deletions or retire stale pre-change emails. Reconcile email/SMS consent and exclusions, compare source-ID-to-email and tag/list mappings with a reviewed final source export/audit, disable removed or stale-email identities, and review phone-only evidence before pilot acceptance. A 100% ready claim also needs rollback rehearsal and dedicated API-token reset/disconnect evidence.",
      },
    ],
    errors: [
      {
        situation: "Missing account API URL",
        cause:
          "The ActiveCampaign API URL was not provided with the API token.",
        fix: "Paste the full URL from Settings → Developer, e.g. https://account.api-us1.com/api/3.",
      },
      {
        situation: "Token rejected by ActiveCampaign",
        cause: "The token is invalid or lacks access to the account.",
        fix: "Generate a fresh token from the dedicated migration user and retry the dry run.",
      },
      {
        situation: "API URL rejected before connection",
        cause:
          "The URL is not the trusted HTTPS account host from ActiveCampaign Developer settings, uses a custom port, or includes unsafe URL data.",
        fix: "Use the exact HTTPS/443 Developer-tab account URL. A host outside api-us1.com or activehosted.com must be authorized by the deployment operator. Do not use redirects, IPs, localhost, userinfo, query strings, or fragments.",
      },
      {
        situation: "Contacts remain unconfirmed",
        cause:
          "List status or subscription dates did not prove channel-specific consent, or complete exclusion evidence was unavailable.",
        fix: "Reconcile email and SMS consent separately, compare ActiveCampaign exclusions, and attach the consent/exclusion cutover evidence before activation.",
      },
      {
        situation: "Automation rebuild required",
        cause:
          "An ActiveCampaign automation was inventoried as source definition evidence but is not executable as-is in Moosewave.",
        fix: "Open the parity report, rebuild and test the automation or explicitly waive it, then rerun pilot acceptance.",
      },
    ],
    apiSource: `curl -X POST "https://api.moosewave.com/api/v1/migrations/activecampaign/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"api_key\\": \\"$ACTIVECAMPAIGN_API_TOKEN\\", \\"extra\\": { \\"api_url\\": \\"https://account.api-us1.com/api/3\\" } }"`,
  },
  hubspot: {
    slug: "hubspot",
    name: "HubSpot",
    authType: "Private app token",
    eta: "15-45 minutes for a CRM contact bridge, depending on contact and property count",
    migrates: [
      "Email-addressable contacts with conservative exact per-type and wide email-preference evidence",
      "Exact excluded non-email and additional-email identity counts without fabricating sendable subscribers",
      "Populated non-sensitive HubSpot contact properties; all non-sensitive definitions remain fingerprint evidence",
      "Exact frozen list and subscription tags plus allowlisted structural list metadata; filter predicates are not fetched or stored",
      "Changed-contact polling during a retained overlap, followed by an authoritative final full snapshot",
    ],
    doesNotMigrate: [
      {
        item: "Deals, pipelines, tasks, tickets, companies, and notes",
        why: "HubSpot remains the CRM system of record. Moosewave mirrors only the fields it needs to send email and SMS.",
      },
      {
        item: "HubSpot workflows",
        why: "Workflow ownership stays in HubSpot unless a workflow explicitly calls Moosewave via webhook/API to trigger an email or SMS.",
      },
      {
        item: "Marketing-email history",
        why: "This adapter is a CRM contact bridge, not an email-history importer. If you also send from another ESP, import campaign history using that platform's guide instead.",
      },
    ],
    steps: [
      {
        title: "Create a HubSpot private app",
        body: "Create a dedicated private app with crm.objects.contacts.read, crm.schemas.contacts.read, crm.lists.read, subscriptions-definition-read, and subscriptions-status-read. The adapter also reads 2026-03 account details and private-app daily API usage. Enterprise-only batch subscription scopes are not required because the bridge uses per-contact status reads.",
      },
      {
        title: "Connect in Moosewave",
        body: "Go to Migrations → HubSpot, paste the private app token, and optionally enter the Hub ID.",
      },
      {
        title: "Review contact scope",
        body: "Confirm email contacts, excluded non-email contacts, additional email identities, non-sensitive property definitions, lists, active subscription definitions, and complete preference plus current-primary-email eligibility coverage. Enabled requires SUBSCRIBED across every active email definition with no scoped/wide opt-out, hard-bounce reason, quarantine, invalid address, marketing-contact uncertainty, pending/unconfirmed double opt-in, or legacy opt-out. This is conservative import eligibility, not exact HubSpot sendability parity.",
      },
      {
        title: "Run shadow mode",
        body: "Keep HubSpot live as CRM and retain changed-contact polling for at least seven days. Polling does not cover every list-only or preference-only change, deletion, or contact that loses email.",
      },
      {
        title: "Freeze and cut over",
        body: "Freeze contact, list/rule, and preference edits; run the authoritative full snapshot and fingerprint shadow check; inspect source-owned dynamic rules whose predicates are not stored by Moosewave and review all excluded product surfaces; rehearse rollback; require strict pilot pass; then delete the local source session, roll back the rehearsal tenant, and rotate/revoke the external token.",
      },
    ],
    errors: [
      {
        situation: "HubSpot rejected the private app token",
        cause:
          "The token is invalid/expired, lacks contacts, property-schema, lists, subscription-definition, or subscription-status reads, or cannot read 2026-03 account/API-usage information.",
        fix: "Create a dedicated token with the five documented read scopes. Do not add Enterprise-only subscription batch scopes; this bridge uses per-contact reads.",
      },
      {
        situation: "Some HubSpot list logic needs review",
        cause:
          "Exact memberships and allowlisted structural metadata are retained, but filter predicates are deliberately not fetched or stored because their operations can contain sensitive literals.",
        fix: "Use the imported hubspot:list:{id} frozen audience, rebuild and test the predicate in Moosewave, retain HubSpot ownership, or explicitly retire the dependency.",
      },
      {
        situation: "Communication-preference coverage is incomplete",
        cause:
          "An active subscription definition/status, wide opt-out envelope, or current-primary-email eligibility check is missing or malformed for at least one email-addressable contact.",
        fix: "Fix token scope/provider data and rerun the full snapshot. This is a blocker, not an acknowledgeable warning; incomplete/NOT_SPECIFIED contacts and contacts with bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restrictions remain non-sendable.",
      },
      {
        situation: "HubSpot discovery reached a hard bound",
        cause:
          "The portal exceeds 1,000,000 contacts, 10,000 traversal pages, 64 MiB of retained snapshot data, the 10,000-result CRM Search window, or the available daily API budget after reserving max(1,000 calls, 5% of the daily limit).",
        fix: "Do not accept a partial import. Narrow or increase polling frequency for CRM Search, reduce the explicitly supported source scope where the workflow allows it, or restore sufficient daily quota before rerunning discovery.",
      },
    ],
    apiSource: `curl -X POST "https://api.moosewave.com/api/v1/migrations/hubspot/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"api_key\\": \\"$HUBSPOT_PRIVATE_APP_TOKEN\\", \\"account_id\\": \\"12345678\\" }"`,
  },
  customerio: {
    slug: "customerio",
    name: "Customer.io",
    authType: "App API key",
    eta: "Workspace-dependent: every run traverses a complete snapshot, followed by rebuild and review work",
    migrates: [
      "Email-addressable Profiles under immutable Customer.io cio_id identity, with current email, non-system attributes, conservative status, and duplicate-email review evidence",
      "Exact segment and subscription-topic membership as frozen, source-qualified tag-backed snapshots",
      "Global unsubscribe plus subscription-center topic and channel-type preferences as the three-layer email eligibility state; ESP suppressions remain blocking evidence",
      "Subscription-center channel definitions/defaults with an exact subscription_channels_count discovery total",
      "Sender-specific SMS/WhatsApp /v1/optouts as separate non-email evidence, never as the email-channel preference",
      "Design Studio email templates with non-empty exact source HTML—not provider-rendered output; localized variants/source definitions are preserved, while components, Liquid, global styles/assets, and transformers require destination validation",
      'Sent email One-time sends become immutable campaign history only with at least one explicit language="" default and provably composable source HTML; the lowest stable content ID represents a multi-default/A-B set with an explicit warning, translations are never silently selected, and raw body/layout plus every variant remain evidence',
      "Campaign/Automation and API Broadcast definitions/actions as rebuild evidence; broadcast trigger IDs and created/processed timestamps are retained, but original trigger payloads, audiences, and per-user data are not returned",
      "Transactional, object-type, suppression, channel, and ecosystem records as non-executable source archive and rebuild evidence",
    ],
    doesNotMigrate: [
      {
        item: "Executable Campaigns/Automations, API Broadcasts, or transactional runtime",
        why: "Customer.io exposes definitions and actions, not a portable Moosewave execution graph. Rebuild, test, retire, or explicitly waive each workflow; Moosewave never activates one automatically.",
      },
      {
        item: "Incremental profile-change or source-event replay",
        why: "The App API does not expose a complete profile change and deletion feed for this contract. Every delta, including the final delta, is an authoritative full snapshot.",
      },
      {
        item: "Dynamic segment predicates or complete custom-object relationships",
        why: "Enumerated audience membership is a frozen snapshot. Object search is filter-bound and cannot prove a complete object/relationship export.",
      },
      {
        item: "Non-email identity, consent, sender, or channel runtime",
        why: "Phone/device identities and SMS, WhatsApp, push, in-app, LINE, Slack, or webhook execution require separate identity, consent, registration, routing, and retirement decisions.",
      },
      {
        item: "Historical events, lifetime reporting, forms, commerce, content libraries, or provider configuration",
        why: "Static checklist rows preserve these as review obligations, not detected inventory or proof that data moved. Customer.io broadcast trigger rows retain trigger IDs plus created/processed timestamps, but original trigger payloads, audiences, and per-user data remain manual reconciliation. DNS, domains, links, IPs, credentials, billing, and Customer.io cleanup remain operator-owned.",
      },
      {
        item: "Provider-rendered newsletter or Design Studio output",
        why: "Newsletter HTML is source composition only: an absent/empty layout uses the exact non-empty body, and a non-empty layout must contain exactly one documented {{content}} slot. Missing bodies and invalid, zero-slot, or multi-slot layouts remain source-archive-only. Moosewave does not execute Liquid, preprocess CSS, resolve assets/components, apply global styles/transformers, or perform per-recipient rendering.",
      },
    ],
    steps: [
      {
        title: "Create a dedicated App API key",
        body: "Create a Customer.io App API key with read access to every surface in scope. Do not use a Track API site ID/key; Track and Pipelines credentials are write-side ingestion credentials and cannot authenticate this import.",
      },
      {
        title: "Bind the region and workspace",
        body: "Choose the US or EU App API region and, when the key exposes multiple workspaces, provide the exact numeric workspace ID. Moosewave validates /v1/workspaces and binds the encrypted session and all reconnects to that region/workspace. Continue the original unrolled-back job rather than opening a parallel lineage.",
      },
      {
        title: "Discover and dry-run a complete snapshot",
        body: "Moosewave uses cursor-paginated POST /v1/customers searches for Profiles with and without email; GET /v1/customers is an email lookup, not a global list. Review every cio_id, profiles without email, duplicate-email merge, global/email-channel/topic eligibility state and defaults, ESP suppressions, the separate sender-specific SMS/WhatsApp /v1/optouts evidence, frozen membership, rebuild record, and static checklist before commit.",
      },
      {
        title: "Commit the reviewed initial import",
        body: "Commit only after the exact discovery-bound counts and custom-field schema pass validation. A completed initial import is not cutover certification: keep Customer.io active while owners reconcile identity and rebuild required workflows and dependencies.",
      },
      {
        title: "Rebuild and test non-portable behavior",
        body: "Rebuild, test, retire, or waive Campaigns/Automations, API Broadcasts, transactional triggers, dynamic audience rules, topic semantics, templates without safe HTML, objects, forms, and non-email dependencies without enabling duplicate sends.",
      },
      {
        title: "Freeze and run the final full snapshot",
        body: "Freeze relevant Customer.io edits, then run final delta import on the original job. Because there is no supported complete source-event feed, this delta re-traverses the full email-addressable cio_id population and must reconcile duplicate ownership, email moves, deletions/lost email, fields, segment membership, global subscribed state, resolved email-channel subscribed/default state, applicable topic subscribed/default state, ESP suppressions, and separate sender-specific SMS/WhatsApp opt-outs.",
      },
      {
        title: "Pass the post-delta cutover gates",
        body: "Run a fresh credentialed fingerprint shadow check, rehearse conflict-aware rollback inside the displayed 7-day window, record all six Customer.io reviews (consent/subscriptions, identity/audiences, automation/transactional rebuild, channel dependencies, deliverability, and ecosystem dependencies), and pass pilot acceptance. Rotate or revoke the App API key only when the rollback plan permits it.",
      },
    ],
    errors: [
      {
        situation: "Customer.io rejected the credential",
        cause:
          "A Track API site key was supplied, or the App API key is invalid or lacks required read access.",
        fix: "Create a dedicated App API key and reconnect the same migration job. Never paste a Track/Pipelines write credential into this importer.",
      },
      {
        situation: "Workspace selection is required",
        cause:
          "The App API key can access multiple Customer.io workspaces and no numeric workspace ID was selected.",
        fix: "Choose the intended /v1/workspaces ID. A reconnect cannot switch the original job's US/EU region or workspace binding.",
      },
      {
        situation: "Profiles need identity review",
        cause:
          "Profiles without email, duplicate email addresses, or a changed/lost email cannot map one-to-one into an email-keyed destination.",
        fix: "Reconcile every immutable cio_id and destination owner; do not treat email deduplication as proof that every source Profile migrated independently.",
      },
      {
        situation: "Consent or suppression remains unconfirmed",
        cause:
          "Customer.io creation timestamps are not opt-in proof, or global, resolved email-channel, applicable-topic, ESP, or GDPR-suppression evidence is incomplete.",
        fix: "Keep the destination status conservative. Enable email only when global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default is proven and no ESP suppression applies. Review sender-specific SMS/WhatsApp /v1/optouts separately; they are not the email-channel preference.",
      },
      {
        situation: "A source-event monitor is unavailable",
        cause:
          "Customer.io does not expose the complete incremental profile-change feed required by this migration contract.",
        fix: "Freeze edits and use the mandatory final full-snapshot delta plus a fresh post-delta shadow check; do not substitute incremental polling.",
      },
    ],
    apiSource: `curl -X POST "https://api.moosewave.com/api/v1/migrations/customerio/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\\"api_key\\\": \\\"$CUSTOMERIO_APP_API_KEY\\\", \\\"account_id\\\": \\\"$CUSTOMERIO_WORKSPACE_ID\\\", \\\"extra\\\": { \\\"region\\\": \\\"$CUSTOMERIO_REGION\\\" } }"

curl -X POST "https://api.moosewave.com/api/v1/migrations/customerio/discover" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\\"job_id\\\": \\\"$JOB_ID\\\" }"

curl -X POST "https://api.moosewave.com/api/v1/migrations/customerio/dry-run" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\\"job_id\\\": \\\"$JOB_ID\\\" }"

# After review, commit the initial import. This is not cutover approval.
curl -X POST "https://api.moosewave.com/api/v1/migrations/customerio/commit" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\\"job_id\\\": \\\"$JOB_ID\\\" }"`,
  },
  convertkit: {
    slug: "convertkit",
    name: "ConvertKit (Kit)",
    authType: "OAuth",
    eta: "15 minutes for a 25k-subscriber list",
    migrates: [
      "Subscribers (state, consent timestamp, custom fields)",
      "Tags",
      "Sequences and their emails (translated to Moosewave Sequences with original step ordering preserved)",
      "Broadcasts (the full sent history, paginated, as archive entries)",
      "Suppression list",
      "Paid subscriptions linked to your connected Stripe account, read through Kit's supported Stripe path and tagged with Kit provenance. This capability is source-specific; the Substack file adapter deliberately does not enumerate an arbitrary Stripe account. Connect Stripe first: without an account id the Kit paid-subscription pull is skipped, not failed.",
    ],
    doesNotMigrate: [
      {
        item: "Visual automations",
        why: "The adapter reads Sequences and their emails; ConvertKit's visual builder exposes a node graph that is not exported at all. Rebuild those flows in the Moosewave automation editor.",
      },
      {
        item: "Forms and landing pages",
        why: "Both are counted in the discovery report so you can see what needs rebuilding, but neither is imported. Recreate forms in Moosewave, and export landing-page HTML to re-import via the GrapesJS editor.",
      },
      {
        item: "Commerce products and purchase events",
        why: "The adapter sets Supports.Ecommerce = false and records an explicit commerce parity gap: Kit's products and purchase events need Stripe/Moosewave commerce reconciliation. Paid subscriptions themselves do come across — see what gets migrated above; this entry is only the product catalogue and purchase history.",
      },
    ],
    steps: [
      {
        title: "Open the migration wizard",
        body: "Migrations → Start a migration. Choose ConvertKit (Kit).",
      },
      {
        title: "Authorize, or paste a v3 API secret",
        body: "Kit moved to OAuth 2.0 for new apps, so authorize Moosewave when prompted. Accounts still on v3 keys can fall back to a key from ConvertKit's Account Settings → Account info — use the API *secret*, not the public API key: the public key is less privileged and segment and automation reads can return 403, so sequences and tags may come through empty. Credentials are stored KMS-encrypted and discarded after commit unless you opt into incremental sync.",
      },
      {
        title: "Pre-flight inventory",
        body: "Moosewave fetches counts: subscribers, tags, sequences, forms, broadcasts.",
      },
      {
        title: "Dry run",
        body: "Verification report: tag overlap with existing Moosewave tags, sequence step parity, and the counts of forms and landing pages you will need to rebuild.",
      },
      {
        title: "Commit",
        body: "Typically 5-10 minutes for 25k subscribers.",
      },
      {
        title: "Verify and (optionally) roll back",
        body: "Spot-check sequence ordering, tag membership, and a sample of imported subscribers against ConvertKit.",
      },
    ],
    errors: [
      {
        situation: "ConvertKit rejected the API key",
        cause: "API key is mistyped or has been rotated.",
        fix: "Re-paste from ConvertKit Account Settings.",
      },
      {
        situation: "Subscriber counts differ after verification",
        cause:
          "The source changed during migration or some rows could not be translated.",
        fix: "Compare the dry-run and completion reports, then rerun discovery if the source changed.",
      },
    ],
    apiSource: `# Legacy v3 fallback. Send the API *secret* — the public api_key is
# less privileged and can 403 on segment and automation reads.
curl -X POST "https://api.moosewave.com/api/v1/migrations/convertkit/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"api_key\\": \\"$CONVERTKIT_API_SECRET\\", \\"extra\\": { \\"api_secret\\": \\"$CONVERTKIT_API_SECRET\\" } }"`,
  },
  brevo: {
    slug: "brevo",
    name: "Brevo (Sendinblue)",
    authType: "API key",
    eta: "15 minutes for a 30k-contact account",
    migrates: [
      "Contacts (status, attributes, source platform)",
      "Lists (translated to Moosewave segments with one-membership-per-contact)",
      "Campaigns (the full sent history, paginated, as archive)",
      "Suppression list",
    ],
    doesNotMigrate: [
      {
        item: "Marketing automations",
        why: "Brevo's automation graph does not translate into an executable Moosewave flow. Rebuild and test each automation in the Moosewave automation editor before activating it.",
      },
      {
        item: "Transactional templates",
        why: "The adapter counts /v3/smtp/templates during discovery so you can see the scope, but template bodies are not imported. Rebuild them in Moosewave, or keep transactional sends where they are.",
      },
      {
        item: "Conversations (chat)",
        why: "Outside Moosewave's product surface.",
      },
      {
        item: "WhatsApp / SMS campaigns",
        why: "This adapter imports Brevo's email surface only, so WhatsApp and SMS campaigns are not carried over. Moosewave does send SMS — set those campaigns up directly rather than expecting them to migrate.",
      },
    ],
    steps: [
      {
        title: "Generate a v3 API key",
        body: "In Brevo, go to SMTP & API → API Keys, create a key with Read access for Contacts, Templates, and Campaigns.",
      },
      {
        title: "Paste into the wizard",
        body: "Migrations → Start → Brevo. Paste the key.",
      },
      {
        title: "Inventory",
        body: "Moosewave queries /v3/contacts, /v3/lists, /v3/smtp/templates, /v3/campaigns.",
      },
      {
        title: "Dry run",
        body: "Verification report shows attribute → custom field mapping. Numeric attributes go to NUMBER fields, dates to DATE fields, multi-select to ENUM.",
      },
      {
        title: "Commit",
        body: "Typically 4-8 minutes for 30k contacts.",
      },
      {
        title: "Reconnect Stripe",
        body: "If you used Brevo's Stripe integration, reconnect via /docs/integrations/stripe. Subscription history is fetched from Stripe directly.",
      },
    ],
    errors: [
      {
        situation: "Brevo key cannot read a required resource",
        cause: "Key lacks read scope on one of the four required surfaces.",
        fix: "Edit the key in Brevo's API Keys page and grant the missing scope.",
      },
      {
        situation: "Suppression inventory is incomplete",
        cause:
          "The source did not return every blocked contact during discovery.",
        fix: "Do not commit until the dry-run suppression count matches the source export; retry discovery or contact support with the job ID.",
      },
    ],
    apiSource: `curl -X POST "https://api.moosewave.com/api/v1/migrations/brevo/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"api_key\\": \\"$BREVO_API_KEY\\" }"`,
  },
  beehiiv: {
    slug: "beehiiv",
    name: "Beehiiv",
    authType: "API key",
    eta: "Depends on subscriber, segment-membership, post, and source-archive volume",
    migrates: [
      "Cursor-paginated subscribers with source status, stable Beehiiv source IDs, custom fields, newsletter-list memberships, and premium-membership metadata",
      "Custom-field definitions plus newsletter-list definitions and cursor-paginated active/pending/inactive/paused subscription history, with one durable completion manifest per discovery-bound list",
      "Newsletter-list memberships as tag-backed segments, segment metadata as source evidence, and eligible completed memberships as frozen tag-backed cutover snapshots",
      "Automation metadata, trigger labels, email metadata, and statistics as rebuild-review definitions, with one durable email-inventory completion manifest per discovery-bound automation",
      "Past published email/both posts as campaign archive entries with available HTML and aggregate statistics",
      "Draft, scheduled, web-only, and other non-campaign posts as read-only source archive evidence",
      "Accessible premium tiers, referral milestones, polls/responses, and post-template metadata as source-preserved rebuild/reference records",
    ],
    doesNotMigrate: [
      {
        item: "Portable marketing-consent proof",
        why: "Beehiiv subscription creation time, status, and list membership do not prove channel-specific consent. Imported subscribers retain unknown consent provenance until another reviewed source supplies proof.",
      },
      {
        item: "Dynamic segment predicates or executable automations",
        why: "API v2 does not expose portable saved-segment predicates or an executable automation graph/message bodies. Rebuild and test dynamic segments and automations before activation.",
      },
      {
        item: "Stripe billing continuity",
        why: "Premium membership metadata is preserved, but this adapter does not migrate Stripe customers, products, prices, subscriptions, renewals, or tenant-bound billing ownership.",
      },
      {
        item: "Website, Boosts, recommendations, and ad-network configuration",
        why: "These Beehiiv-owned surfaces are not reproducible from the migration API. Preserve required exports and rebuild or replace them explicitly.",
      },
      {
        item: "Live webhook bridge",
        why: "The adapter has no continuous Beehiiv webhook/source-event bridge. Use a final full delta and reconcile the verification report before cutover.",
      },
    ],
    steps: [
      {
        title: "Generate a Beehiiv API key",
        body: "In Beehiiv, open Settings → Integrations → API and create a key with read access to the publication, subscriptions, newsletter lists and their subscription history, segments, automations/emails, posts, and custom fields. Moosewave validates it against `/workspaces/identify` and the publications available to that workspace. Missing required access fails closed rather than becoming a waivable archive warning.",
      },
      {
        title: "Bind one publication",
        body: "A workspace with one available publication can be selected automatically. If the key can access multiple publications, provide the intended `pub_...` publication ID explicitly; there is no chooser yet.",
      },
      {
        title: "Pre-flight inventory",
        body: "Moosewave inventories subscriptions, custom fields, newsletter lists, segments and their available completed memberships, automations/emails, posts, and accessible source-archive endpoints for tiers, referrals, polls, and templates. Each subscription must include the requested custom-field and newsletter-list expansion keys; explicit empty/null values are valid, but omitted keys fail closed before authoritative final-delta writes.",
      },
      {
        title: "Dry run",
        body: "Review subscriber status and unknown-consent provenance, frozen segment memberships, automation rebuild items, sent-post archive eligibility, optional-endpoint warnings, and premium metadata. No Stripe billing objects are created.",
      },
      {
        title: "Commit and verify",
        body: "Commit the reviewed job, then verify subscriber source IDs, newsletter-list and segment snapshot tags, eligible sent-post history, exact newsletter-list/automation archive coverage, and every rebuild/source-preservation warning. Rebuild dynamic predicates, automations, website/growth surfaces, and billing separately.",
      },
      {
        title: "Run the final full delta",
        body: "There is no live Beehiiv bridge. Freeze relevant source edits and run a final full delta before cutover. Deletion reconciliation runs only after cursor integrity and the discovery-bound unique source-ID count are proven; it then disables same-job IDs that are now absent. Strict acceptance also requires separate post-delta evidence for website/theme/capture rebuild, Boosts/recommendations rebuild, and Ad Network export/ownership review; evidence cannot waive a missing parity-gap archive record. The automated certification harness is present, but the target publication still needs a credentialed live run.",
      },
    ],
    errors: [
      {
        situation: "Publication selection is required",
        cause:
          "The API key can access more than one publication and no explicit publication ID was supplied.",
        fix: "Copy the intended `pub_...` ID from Beehiiv and send it as `account_id`/`publication_id`; the current migration has no chooser.",
      },
      {
        situation: "Publication is not available to this API key",
        cause:
          "The supplied publication ID is invalid or is not in the workspace publication list returned for the key.",
        fix: "Use a valid `pub_...` ID from the same Beehiiv workspace or create a key with access to the intended publication.",
      },
      {
        situation: "A required archive surface cannot be read",
        cause:
          "The key cannot read newsletter-list definitions/history or automation definitions/email inventory, or the endpoint returned incomplete pagination metadata.",
        fix: "Restore the required Beehiiv scope or endpoint access and rerun the migration. These surfaces cannot be waived as optional archive warnings.",
      },
      {
        situation: "Optional source evidence is unavailable",
        cause:
          "The plan or API key does not expose an optional tier, referral, poll, response, or post-template endpoint.",
        fix: "Review the source-archive warning and preserve the missing evidence manually; do not interpret the warning as a zero-record inventory.",
      },
    ],
    apiSource: `curl -X POST "https://api.moosewave.com/api/v1/migrations/beehiiv/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"api_key\\": \\"$BEEHIIV_API_KEY\\", \\"account_id\\": \\"$BEEHIIV_PUBLICATION_ID\\" }"`,
  },
  substack: {
    slug: "substack",
    name: "Substack",
    authType: "CSV upload",
    eta: "30 minutes (manual export + 5-minute import)",
    migrates: [
      "De-duplicated subscriber identities with conservative email state",
      "Free, paid, founding, gift, and comp membership-tier metadata (not billing objects)",
      "Email-sent posts from posts.csv joined to matching HTML fragments",
      "Aggregate delivery/open counts when the ZIP contains per-post evidence, without retaining recipient identities",
      "A durable export inventory plus explicit consent, billing, content, social, media, web, and integration review records",
    ],
    doesNotMigrate: [
      {
        item: "Portable email consent",
        why: "Signup dates and source membership are provenance, not proof that Moosewave may send. Source-active rows remain unconfirmed until reviewed consent evidence authorizes destination sending.",
      },
      {
        item: "Live Stripe or Apple billing and entitlements",
        why: "A tier label, email, or arbitrary Stripe account ID does not prove publication/product/customer ownership. Moosewave does not move, cancel, recreate, or attach subscriptions through this file import.",
      },
      {
        item: "Notes, restacks, comments, reactions, chat, and recommendations",
        why: "These social/network surfaces are not part of the portable publication ZIP contract and remain explicit review or rebuild work.",
      },
      {
        item: "Drafts/pages as sent history, audience-specific variants, media, assets, and publication settings",
        why: "Only rows with email-send evidence become campaign history. Conditional/paywalled renderings, files, feeds, theme, domain, pages, embeds, and capture settings require separate preservation and rebuild.",
      },
    ],
    steps: [
      {
        title: "Create the official publication export",
        body: "In the Substack dashboard, open Settings, choose Exports, then Create new export. Download the ZIP when ready. For a subscriber-only run, export All columns from the Subscribers dashboard instead.",
      },
      {
        title: "Upload one ZIP or CSV",
        body: "Open Migrations → Substack and upload the untouched ZIP (preferred) or one current subscriber CSV. The backend validates ZIP paths and size, finds email_list.*.csv, posts.csv, post HTML, and aggregate delivery/open files.",
      },
      {
        title: "Review identity, status, and consent separately",
        body: "Confirm de-duplicated counts, suppression state, namespaced extra fields, membership tiers, and unconfirmed consent. Signup dates are stored as substack_created_at provenance, never consent timestamps.",
      },
      {
        title: "Plan the paid-reader handoff",
        body: "Inventory Stripe and Apple billing separately. Coordinate publication-bound products/customers, trials, renewals, gifts/comps, disputes, taxes, checkout/webhooks, entitlements, and Substack shutdown with the providers. This import does not touch billing.",
      },
      {
        title: "Commit",
        body: "Commit the subscriber and archive snapshot only after every parity row has an owner. The file snapshot is authoritative for source-owned status and tier metadata, not destination send permission or billing.",
      },
      {
        title: "Rebuild and validate cutover surfaces",
        body: "Recreate sender DNS, domain/redirects, forms, pages, embeds, media, integrations, welcome behavior, and any social/network replacement. Keep Substack active until content, capture, billing, and renewal checks pass.",
      },
    ],
    errors: [
      {
        situation: "The ZIP has no unambiguous subscriber CSV",
        cause:
          "The file is not a complete publication export, contains multiple equally likely audience CSVs, or lacks an email column.",
        fix: "Upload the untouched official publication ZIP, or choose one current All columns subscriber CSV.",
      },
      {
        situation: "Substack CSV columns are not recognized",
        cause:
          "Substack updated their CSV columns and we don't recognize the new shape.",
        fix: "Use Substack's current All columns export without opening it in a spreadsheet. If it still fails, send only the header row and migration job ID to support; do not send subscriber data by email.",
      },
      {
        situation:
          "Paid readers appear in the report but billing is not connected",
        cause: "Expected: the report counts membership-tier metadata only.",
        fix: "Complete a separate provider-approved Stripe/Apple billing and entitlement handoff before source shutdown.",
      },
    ],
    apiSource: `UPLOAD_ID=$(uuidgen)
BYTES=$(wc -c < substack-export.zip | tr -d ' ')

curl -X PUT "https://api.moosewave.com/api/v1/migrations/substack/uploads/$UPLOAD_ID?filename=substack-export.zip" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/octet-stream" \\
  -H "Content-Range: bytes 0-$((BYTES - 1))/$BYTES" \\
  --data-binary @substack-export.zip

curl -X POST "https://api.moosewave.com/api/v1/migrations/substack/uploads/$UPLOAD_ID/complete" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY"`,
  },
  mailerlite: {
    slug: "mailerlite",
    name: "MailerLite",
    authType: "API key",
    eta: "15 minutes for a 30k-subscriber account",
    migrates: [
      "Subscribers (active, unsubscribed, unconfirmed, bounced, junk)",
      "Custom-field definitions and values, including empty definitions, plus exact group memberships",
      "Groups → executable tag-backed Moosewave segments",
      "Saved-segment metadata → rebuild review (dynamic predicates are not exposed)",
      "Automation trigger/step definitions → rebuild review (never auto-activated)",
      "All API-visible sent campaign metadata, plain text, email variants, preview references, and aggregate reports",
      "Draft and ready campaign metadata → source-archive rebuild evidence",
      "Form and ecommerce-shop metadata → source-archive rebuild evidence",
    ],
    doesNotMigrate: [
      {
        item: "Rendered campaign HTML and reusable templates",
        why: "MailerLite's documented read API does not expose rendered campaign HTML or reusable-template inventory.",
      },
      {
        item: "Live forms, popups, sites, and landing pages",
        why: "Form metadata is archived, but capture UI, consent settings, embeds, sites, and landing pages must be rebuilt and tested.",
      },
      {
        item: "Ecommerce catalogs, customers, purchases, attribution, and triggers",
        why: "Only shop metadata is source-preserved. Reconnect commerce through Moosewave integrations.",
      },
    ],
    steps: [
      {
        title: "Generate a dedicated API token",
        body: "MailerLite → Integrations → MailerLite API → Generate new token. MailerLite tokens do not have selectable read scopes, so create one only for this migration and revoke it afterward.",
      },
      {
        title: "Paste into the wizard",
        body: "Migrations → MailerLite. Paste the token.",
      },
      {
        title: "Inventory",
        body: "Moosewave validates with /api/subscribers?limit=0, then inventories subscribers with include=groups, custom-field definitions, groups, segments, automations, sent/draft/ready campaigns, all three form types, and ecommerce shops.",
      },
      {
        title: "Dry run",
        body: "Review suppressions, consent evidence, custom-field definitions, group tags, sent campaign archive counts, and draft/ready rebuild records. Every saved segment and automation is rebuild-review because MailerLite does not expose portable dynamic predicates or a complete executable/message-body contract.",
      },
      {
        title: "Commit",
        body: "Freeze MailerLite changes first, then commit the authoritative snapshot. Runtime depends on account size and MailerLite's 120 requests/minute global limit.",
      },
      {
        title: "Verify",
        body: "Spot-check status and group-tag parity, rebuild/test forms, segments, automations, templates, sites, and commerce dependencies, run a controlled test send, then revoke the MailerLite token.",
      },
    ],
    errors: [
      {
        situation: "MailerLite account uses the legacy API",
        cause: "You're on the legacy 'MailerLite Classic' API.",
        fix: "Moosewave only supports the new MailerLite (post-2022). Upgrade your MailerLite account first; MailerLite provides a guide.",
      },
      {
        situation: "Some subscribers are still unconfirmed",
        cause: "Subscribers in 'unconfirmed' state.",
        fix: "Moosewave preserves them as unconfirmed. Do not promote or re-mail them without reviewed permission evidence and a compliant signup path.",
      },
      {
        situation: "A saved segment or automation is marked for rebuild",
        cause:
          "MailerLite does not expose saved-segment predicates, and its workflow graph/message bodies are not safely portable as executable Moosewave runtime state.",
        fix: "Use the preserved source definition and MailerLite account review to rebuild, test, approve, or explicitly retire the dependency before cutover.",
      },
    ],
    apiSource: `curl -X POST "https://api.moosewave.com/api/v1/migrations/mailerlite/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"api_key\\": \\"$MAILERLITE_API_KEY\\" }"`,
  },
  sendy: {
    slug: "sendy",
    name: "Sendy CSV",
    authType: "CSV upload",
    eta: "10 minutes for a 100k-row export",
    migrates: [
      "Subscribers from Sendy's Export all subscribers CSV",
      "Email, name, status, consent/subscribed timestamp when columns are present",
      "Custom fields and tags auto-detected from headers",
      "Sendy provenance fields so rollback and audit reports show the source",
    ],
    doesNotMigrate: [
      {
        item: "Saved segments",
        why: "Sendy's official API and subscriber CSV do not expose saved segment definitions in a portable way.",
      },
      {
        item: "Campaign archive and reports",
        why: "The subscriber CSV does not carry sent campaign HTML or aggregate report metrics.",
      },
      {
        item: "Forms and install settings",
        why: "Hosted forms, embed snippets, AWS SES credentials, and Sendy cron settings should be recreated or decommissioned during cutover.",
      },
    ],
    steps: [
      {
        title: "Export from Sendy",
        body: "Open the Sendy list, choose Export all subscribers, and download the CSV. Repeat per list if the account uses multiple independent lists.",
      },
      {
        title: "Upload in Moosewave",
        body: "Go to Migrations → Sendy CSV and upload the export. The desktop and web apps use resumable chunked uploads.",
      },
      {
        title: "Review the dry run",
        body: "Confirm total row count, status mapping, custom fields, tags, and any unknown columns before committing.",
      },
      {
        title: "Commit and verify",
        body: "Moosewave imports subscribers with source_platform=sendy and preserves the original file name in the migration session for auditability.",
      },
    ],
    errors: [
      {
        situation: "Sendy export has no recognizable email column",
        cause:
          "The export does not include an email column or recognizable email values.",
        fix: "Export the subscriber list again and keep the email column header intact.",
      },
      {
        situation: "A Sendy status value is unfamiliar",
        cause:
          "A status value could not be mapped to Moosewave's enabled/disabled/blocklisted states.",
        fix: "The raw status is preserved as a custom field; review the dry-run report and normalize if needed.",
      },
    ],
    apiSource: `curl -X PUT "https://api.moosewave.com/api/v1/migrations/sendy/uploads/$UPLOAD_ID?filename=sendy.csv" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/octet-stream" \\
  -H "Content-Range: bytes 0-1048575/1048576" \\
  --data-binary @sendy.csv

curl -X POST "https://api.moosewave.com/api/v1/migrations/sendy/uploads/$UPLOAD_ID/complete" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY"`,
  },
  csv: {
    slug: "csv",
    name: "CSV import",
    authType: "CSV upload",
    eta: "10 minutes for a 100k-row file",
    migrates: [
      "Subscribers (one row each)",
      "Email, status, consent timestamp, source IP, language",
      "Custom fields (auto-detected from headers)",
      "Tags (comma-separated in one column)",
    ],
    doesNotMigrate: [
      {
        item: "Automations / sequences",
        why: "CSV is flat data. Define automations after import via the Moosewave editor.",
      },
      {
        item: "Past campaign archive",
        why: "CSV files don't carry campaign history. If you need an archive, use one of the dedicated importers above.",
      },
    ],
    steps: [
      {
        title: "Prepare the CSV",
        body: "First column should be 'email'. Required columns: email. Recommended: status (one of enabled, disabled, blocklisted), consent_timestamp (ISO 8601), source_platform.",
      },
      {
        title: "Upload",
        body: "Migrations → CSV. Drag and drop or click to upload. Files up to 200MB are supported in the UI; larger files via the API.",
      },
      {
        title: "Map columns",
        body: "Moosewave shows a preview of the first 50 rows and a column mapper. Map unknown columns to existing custom fields, or click 'Create new field' to add a custom field on the fly.",
      },
      {
        title: "Consent decision",
        body: "Pick a consent stance: import as enabled (existing GDPR/CAN-SPAM consent), import as pending (re-confirm via double-opt-in), or import as suppressed (load straight to suppression list).",
      },
      {
        title: "Commit",
        body: "Moosewave validates rows, deduplicates by email, and writes. Bad rows surface in a downloadable error CSV.",
      },
    ],
    errors: [
      {
        situation: "CSV has no email column",
        cause: "No 'email' header in the file.",
        fix: "Add an 'email' header (or rename the column) and re-upload.",
      },
      {
        situation: "Consent timestamps are invalid",
        cause: "consent_timestamp values are not valid ISO 8601.",
        fix: "Re-export from your source with ISO 8601 dates, or drop the column entirely (Moosewave will use the import time as a fallback).",
      },
      {
        situation: "CSV has more custom fields than the workspace permits",
        cause:
          "The file defines more custom fields than the workspace's cap allows.",
        fix: "The cap is per-tenant and configurable; it defaults to 1,000 custom fields, of which 3 may be searchable. Check Settings → Custom Fields for your workspace's current limit and usage, then drop low-value columns or ask support to raise it.",
      },
    ],
    apiSource: `UPLOAD_ID=$(uuidgen)
BYTES=$(wc -c < subscribers.csv | tr -d ' ')

curl -X PUT "https://api.moosewave.com/api/v1/migrations/csv/uploads/$UPLOAD_ID?filename=subscribers.csv" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/octet-stream" \\
  -H "Content-Range: bytes 0-$((BYTES - 1))/$BYTES" \\
  --data-binary @subscribers.csv

curl -X POST "https://api.moosewave.com/api/v1/migrations/csv/uploads/$UPLOAD_ID/complete" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY"`,
  },
};

export function generateStaticParams(): { source: string }[] {
  // Derived from GUIDES, the way the sibling /docs/integrations/[integration]
  // route already does it. This was a separate hand-written ORDER array
  // repeating all eleven slugs — despite its name it ordered nothing, its only
  // consumer was this function, and a twelfth guide added to GUIDES (and to
  // lib/docs/catalog, which the sidebar test does pin) would have been left
  // out of the prebuild silently, with every existing check still green.
  return Object.keys(GUIDES).map((source) => ({ source }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { source } = await params;
  const g = GUIDES[source];
  if (!g) return { title: "Migration · Moosewave docs" };
  return {
    title: `Migrate from ${g.name} · Moosewave docs`,
    description: migrationGuideDescription(g),
    alternates: { canonical: `/docs/migrations/${g.slug}` },
  };
}

function migrationGuideDescription(g: Guide): string {
  if (g.slug === "activecampaign") {
    return "Step-by-step guide to migrating ActiveCampaign contacts, lists, campaign archive, automation rebuild evidence, source-event shadow checks, and final-delta cutover to Moosewave.";
  }
  if (g.slug === "hubspot") {
    return "Step-by-step guide to bridging HubSpot contacts, properties, list-membership tags, source-event replay, final-delta cutover, rollback rehearsal, and private-app-token cleanup to Moosewave.";
  }
  if (g.slug === "beehiiv") {
    return "Step-by-step guide to a workspace-validated Beehiiv publication migration with cursor subscribers, frozen audience snapshots, automation rebuild evidence, eligible sent-post archive, and a final full delta.";
  }
  if (g.slug === "customerio") {
    return "Step-by-step guide to a region/workspace-bound Customer.io migration with immutable cio_id profiles, frozen audience snapshots, rebuild-only workflows, a mandatory final full snapshot, shadow and rollback gates.";
  }
  return `Step-by-step guide to migrating ${g.name} subscribers, segments, automations, and archive to Moosewave.`;
}

export default async function MigrationGuidePage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { source } = await params;
  const g = GUIDES[source];
  if (!g) notFound();

  return (
    <article className="space-y-10">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Migrations", href: "/docs/migrations" },
          { label: g.name },
        ]}
      />

      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          Migrate from {g.name}
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          Authentication: <strong>{g.authType}</strong> · Estimated time:{" "}
          <strong>{g.eta}</strong>
        </p>
      </header>

      <Callout variant="info" title="Reversible for 7 days">
        Eligible commits keep a tenant-scoped write ledger until the displayed
        rollback deadline. Rollback removes records created by that job and
        restores recorded before-images for pre-existing records it updated; it
        does not undo sends or provider-side changes.
      </Callout>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">
          What gets migrated
        </h2>
        <ul className="space-y-2">
          {g.migrates.map((m) => (
            <li key={m} className="flex gap-2 text-sm">
              <span
                aria-hidden
                className="mt-2 inline-block h-1 w-1 flex-none rounded-full bg-emerald-600"
              />
              <span className="leading-relaxed">{m}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">
          What does NOT migrate
        </h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {g.doesNotMigrate.map((d) => (
            <div
              key={d.item}
              className="rounded-md border border-pw-line bg-white p-3"
            >
              <dt className="text-sm font-semibold text-pw-ink2">{d.item}</dt>
              <dd className="mt-1 text-xs text-pw-muted-on-paper leading-relaxed">
                {d.why}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">UI walkthrough</h2>
        <ol className="space-y-4">
          {g.steps.map((s, i) => (
            <li
              key={s.title}
              className="rounded-md border border-pw-line bg-white p-4"
            >
              <h3 className="text-sm font-semibold text-pw-ink2">
                {/* Padded, not prefixed: the longest guide runs to seven
                    steps today, and a literal "0" would render step ten as
                    "010" the moment one grows. */}
                <span className="text-pw-muted-on-paper font-mono mr-2">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {s.title}
              </h3>
              <p className="mt-2 text-sm text-pw-muted-on-paper leading-relaxed">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">API equivalent</h2>
        <CodeBlock code={g.apiSource} language="bash" caption="curl" />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">Common errors</h2>
        <div
          role="region"
          aria-label={`Common errors migrating from ${g.name}`}
          tabIndex={0}
          className="overflow-x-auto rounded-md border border-pw-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
        >
          <table className="w-full text-sm">
            <thead className="bg-pw-surface">
              <tr className="text-left">
                <th scope="col" className="px-3 py-2 font-medium">
                  Situation
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Cause
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Fix
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-pw-line">
              {g.errors.map((e) => (
                <tr key={e.situation}>
                  {/* The situation is the row header: without it a screen
                      reader reads a cause and a fix with no way to tell which
                      error is being described. */}
                  <th
                    scope="row"
                    className="px-3 py-2 text-left font-medium whitespace-nowrap text-pw-ember-700"
                  >
                    {e.situation}
                  </th>
                  <td className="px-3 py-2 text-pw-muted-on-paper">
                    {e.cause}
                  </td>
                  <td className="px-3 py-2">{e.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Callout variant="info" title="Stuck?">
        Email{" "}
        <Link href="mailto:support@moosewave.com" className="underline">
          support@moosewave.com
        </Link>{" "}
        with your migration job ID (visible in the wizard URL). We answer within
        one business day.
      </Callout>
    </article>
  );
}
