// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: per-source migration guide. Each renders /migrations/{from} with
// platform-specific HowTo + FAQ structured data. AIO target: "how to migrate
// from {platform} to Moosewave".
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { asRoute } from "@/lib/typed-routes";

interface SourceDetail {
  slug: string;
  name: string;
  authMethod:
    | "OAuth"
    | "API key"
    | "API token"
    | "API token + account API URL"
    | "Private app token"
    | "CSV upload";
  heroSummary?: string;
  preserves: string[];
  steps: { title: string; body: string }[];
  caveats: string[];
}

const DETAILS: Record<string, SourceDetail> = {
  activecampaign: {
    slug: "activecampaign",
    name: "ActiveCampaign",
    // Both halves are required — the step body and the "Missing account API
    // URL" error both say so, and the adapter binds the job to the account
    // that URL resolves to. Labelling it "API token" understated its own
    // instructions.
    authMethod: "API token + account API URL",
    heroSummary:
      "API token plus trusted account API URL. Fail-closed email contacts, lists/tags, hydrated sent campaigns, enriched automation rebuild evidence, read-only CRM/SMS inventory, and cutover gates. Dry-run before commit. 7-day rollback.",
    preserves: [
      "Email-addressable contacts with phone, custom fields, source IDs, tags, channel-specific list evidence, and fail-closed status",
      "List status and subscription dates as provenance only; unknown email/SMS consent or exclusion coverage stays unconfirmed",
      "Email-less and phone-only contacts as review evidence, never fabricated email subscribers",
      "Lists as tag-backed executable Moosewave segments; `/audiences` + `/segmentsV2` saved logic preserved for review",
      "Completed campaign archive hydrated from campaign detail and linked message HTML/text",
      "Automation summaries, blocks, goals, linked campaigns, and SMS relationships as rebuild-review definitions, not live runtime activation",
      "Messages/templates, forms, CRM, available custom-object/ecommerce evidence, and SMS broadcasts as read-only source archive evidence",
      "Fixed-window, ID-paginated changed-contact replay during the shadow window",
    ],
    steps: [
      {
        title: "Connect",
        body: "Paste the exact HTTPS account API URL and API token from ActiveCampaign Settings -> Developer -> API Access. Built-in account.api-us1.com and account.activehosted.com hosts work by default; another provider-issued hostname requires deployment-operator authorization. Moosewave binds the job to the account returned by ActiveCampaign.",
      },
      {
        title: "Discover",
        body: "Moosewave inventories email and phone-only contacts, tags, lists, current saved-segment definitions, completed campaigns plus message content, automation relationships, forms, CRM, available custom objects/ecommerce, and SMS broadcasts where your account exposes them.",
      },
      {
        title: "Dry-run review",
        body: "The verification report separates imported runtime data from preserved rebuild evidence. Unknown-consent contacts remain unconfirmed; saved segments and ActiveCampaign automations appear as rebuild-review inventory, not activated runtime targeting or automations.",
      },
      {
        title: "Shadow and final delta",
        body: "Keep ActiveCampaign live, enable fixed-window source-event replay for the full overlap, test or approve rebuilds, freeze edits, and run final delta import. Returned same-source contacts replace provider-owned tags and fields, but polling cannot prove hard deletions or retire stale pre-change emails. Reconcile channel consent and exclusions, compare source-ID-to-email and tag/list mappings with a reviewed final source export/audit, and disable removed or stale-email identities before pilot acceptance.",
      },
      {
        title: "Pilot acceptance and cleanup",
        body: "Run pilot acceptance, rollback rehearsal, rollback cleanup if needed, and dedicated API-token reset/disconnect evidence before claiming production readiness.",
      },
    ],
    caveats: [
      "Executable ActiveCampaign automations do not migrate automatically. Rebuild, test, or explicitly waive each cutover-relevant automation before activation.",
      "Saved-segment predicates, editable templates, hosted forms, landing pages, CRM/custom-object triggers, and ecommerce triggers require rebuild or owner review. SMS broadcasts remain non-executable archive evidence under HOLD / NO-GO; provider compliance review cannot release them.",
      "A 100% ready cutover requires live proof: source-event shadowing, final delta import, channel-consent/exclusion reconciliation, post-delta shadow check, rollback rehearsal, credential cleanup evidence, and pilot acceptance in an isolated destination tenant.",
    ],
  },
  hubspot: {
    slug: "hubspot",
    name: "HubSpot",
    authMethod: "Private app token",
    heroSummary:
      "Private app token CRM bridge with exact contact/preferences inventory, conservative current-email eligibility, frozen list tags, retained overlap, final snapshot, and rollback gates while HubSpot remains the CRM system of record.",
    preserves: [
      "Contacts with email, phone, first/last name, lifecycle stage, source IDs, and CRM provenance",
      "HubSpot contact properties into Moosewave custom fields where the contacts API returns values",
      "HubSpot list memberships as exact hubspot:list:{id} tags for email targeting and non-sendable SMS review evidence",
      "Exact active-definition/wide communication preferences plus conservative current-primary-email eligibility",
      "Changed-contact source-event replay during the shadow window",
    ],
    steps: [
      {
        title: "Create a HubSpot private app",
        body: "Create a private app with read access to CRM contacts, contact properties, and lists. Use a dedicated migration token and record the Hub ID when available.",
      },
      {
        title: "Connect in Moosewave",
        body: "Paste the private app token and optional Hub ID. Moosewave stores the bridge session for the same 90-day controlled-cutover window used by ActiveCampaign, with a 14-day near-expiry reconnect gate.",
      },
      {
        title: "Dry-run review",
        body: "Compare contact identities, properties, lists, every active email preference, and current-primary-email eligibility against HubSpot. Contact creation/list membership alone is never consent; enabled requires all active definitions SUBSCRIBED with no scoped/wide opt-out or bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restriction.",
      },
      {
        title: "Shadow and pilot acceptance",
        body: "Keep HubSpot live as CRM, enable source-event replay, run final delta import, run shadow checks, rehearse rollback, and preserve private-app-token cleanup evidence before claiming 100% readiness.",
      },
    ],
    caveats: [
      "HubSpot remains the CRM system of record. Deals, companies, tickets, tasks, notes, pipelines, and workflow execution are not migrated as Moosewave-owned CRM records.",
      "HubSpot workflows, marketing emails, forms, landing pages, and templates are not activated as Moosewave runtime surfaces by this bridge.",
      "The conservative preference/eligibility projection is not exact HubSpot sendability parity. Eligibility and double-opt-in evidence follow the current primary email, so email changes require a fresh full snapshot.",
      "Discovery fails closed rather than returning partial data above 1,000,000 contacts, 10,000 pages, 64 MiB retained snapshot data, a 10,000-result changed-contact search, or the reserved daily API quota.",
      "A 100% ready HubSpot bridge requires live proof: source-event replay, final delta import, clean shadow check, rollback rehearsal, credential cleanup evidence, and pilot acceptance in an isolated destination tenant.",
    ],
  },
  mailchimp: {
    slug: "mailchimp",
    name: "Mailchimp",
    authMethod: "OAuth",
    preserves: [
      "Subscribers in the explicitly selected audiences",
      "Audience → list mapping",
      "Tags, interest groups, and static segment membership",
      "Custom fields (auto-mapped, with a review step)",
      "Available consent timestamps and source provenance",
      "Exact member states, including cleaned, unsubscribed, pending, transactional, and archived",
      "Supported Classic welcome-series triggers and email content",
      "Sent campaign and report history exposed by the selected-audience API reads",
    ],
    steps: [
      {
        title: "Connect",
        body: "Authorize Moosewave through Mailchimp OAuth. The access token follows the approving user's Mailchimp role; Mailchimp does not offer a granular migration-only scope picker. Moosewave stores the source session securely and only reads Mailchimp during this migration flow.",
      },
      {
        title: "Discover",
        body: "Choose the audiences in scope, then inventory their contacts, groups, segments, supported Classic Automations, campaigns, and reports. Account-wide templates, landing pages, and ecommerce records are labelled for separate scope review.",
      },
      {
        title: "Dry-run review",
        body: "We render a verification report: data fidelity %, custom field mappings, automations we can faithfully migrate vs ones we can only export, and any segment warnings. Nothing is committed yet.",
      },
      {
        title: "Import",
        body: "If the report looks right, commit the same reviewed job and audience scope. Runtime depends on source size, report depth, and Mailchimp rate limits; freeze relevant source edits until the commit finishes.",
      },
      {
        title: "Rollback window",
        body: "During the 7-day window, rollback removes job-created records and restores recorded before-images. It refuses to overwrite records changed after import or owned by a later job, and it never changes Mailchimp.",
      },
    ],
    caveats: [
      "Mailchimp does not expose a supported general export of Customer Journey / Automation Flow graphs. Rebuild those journeys manually; only the validated Classic welcome-series subset can become paused Moosewave runtime records.",
      "Mailchimp-only rating, engagement, date, and ecommerce segment predicates remain rebuild items unless the imported destination data can prove equivalent semantics. Available campaign report detail is archived rather than invented as subscriber tags.",
    ],
  },
  sendy: {
    slug: "sendy",
    name: "Sendy",
    authMethod: "CSV upload",
    heroSummary:
      "Upload a Sendy subscriber export, review consent and suppression status in a dry-run, then commit the verified import with a rollback window.",
    preserves: [
      "Subscriber email addresses and available names",
      "Subscribed, unsubscribed, bounced, and complaint status from the export",
      "Source list and brand identifiers when present as CSV columns",
      "Additional source columns as reviewable subscriber attributes",
    ],
    steps: [
      {
        title: "Export from Sendy",
        body: "Export the relevant Sendy lists as CSV, including status fields and any custom columns you need to retain.",
      },
      {
        title: "Upload",
        body: "Choose Sendy in the Moosewave migration wizard and upload the CSV. Resumable uploads are verified against the server before continuing.",
      },
      {
        title: "Review the dry-run",
        body: "Confirm subscriber, suppression, and custom-field counts. Nothing is written until you commit.",
      },
      {
        title: "Import and verify",
        body: "Commit the import, monitor per-resource progress, then compare the completion report with the source export.",
      },
    ],
    caveats: [
      "Sendy does not expose a complete subscriber migration API, so this path uses the CSV export rather than your AWS SES credentials.",
      "Campaign content and historical engagement are only available when you export them separately; the subscriber CSV does not contain that history.",
    ],
  },
  substack: {
    slug: "substack",
    name: "Substack",
    authMethod: "CSV upload",
    preserves: [
      "De-duplicated subscriber identity and conservative email state",
      "Free, paid, founding, gift, and comp membership metadata (not billing objects)",
      "Signup date as provenance, never portable consent",
      "Email-sent post metadata joined to exported HTML",
      "Aggregate delivery/open counts when present, without recipient identities",
    ],
    steps: [
      {
        title: "Export",
        body: "In the Substack dashboard, open Settings, choose Exports, and create the official publication ZIP; or export one All columns subscriber CSV.",
      },
      {
        title: "Upload",
        body: "Upload one untouched ZIP or CSV. Moosewave validates the archive and locates the subscriber list, posts.csv, matching post HTML, and optional aggregate evidence.",
      },
      {
        title: "Dry-run review",
        body: "Review de-duplicated identities, suppressions, unconfirmed consent, membership tiers, email-sent archive count, and every explicit Substack parity record.",
      },
      {
        title: "Import",
        body: "Import subscribers and immutable sent history. The file import never moves, cancels, recreates, or attaches Stripe/Apple subscriptions or Moosewave entitlements.",
      },
      {
        title: "Provider-approved cutover",
        body: "Separately reconcile Stripe and Apple readers, renewals, trials, refunds/disputes/tax, checkout/webhooks, and entitlements with Substack and the payment provider before source shutdown.",
      },
    ],
    caveats: [
      "Source-active rows remain unconfirmed because signup date and membership are not portable consent proof.",
      "Notes, restacks, comments/reactions, chat, recommendations/referrals, automations, surveys, media/assets, pages/theme/domain, engagement history, and integrations require separate preservation, rebuild, or retirement decisions.",
    ],
  },
  beehiiv: {
    slug: "beehiiv",
    name: "Beehiiv",
    authMethod: "API key",
    heroSummary:
      "Workspace-validated API v2 migration for one Beehiiv publication. Cursor subscribers and eligible sent-post history import; segments and automations carry explicit snapshot/rebuild boundaries. Live certification is pending.",
    preserves: [
      "Cursor-paginated subscribers with stable source IDs, source status, custom fields, and returned subscriber tags",
      "Custom-field definitions plus newsletter-list definitions and cursor-paginated subscription history as read-only source evidence",
      "Newsletter-list memberships and eligible completed segment memberships as separate tag-backed segments; segment snapshots are frozen and segment metadata is retained",
      "Premium tier and membership details as subscriber/source metadata, not Stripe billing objects",
      "Automation metadata, trigger labels, email metadata, and statistics as rebuild-review definitions that are never activated",
      "Past published email/both posts as campaign archive; drafts, scheduled, and web-only posts as source evidence",
      "Accessible premium tiers, referral milestones, polls/responses, and post-template metadata as source-preserved records",
    ],
    steps: [
      {
        title: "Connect",
        body: "Paste a Beehiiv API key with read access to the publication, subscriptions, newsletter lists, segments, automations/emails, posts, and custom fields. Moosewave validates its workspace and publication list. If the workspace exposes multiple publications, provide the intended `pub_...` ID explicitly; there is no chooser yet.",
      },
      {
        title: "Discover",
        body: "Inventory subscriptions, custom fields, newsletter lists, completed segment memberships, automation/email metadata, posts, and accessible tier/referral/poll/template evidence.",
      },
      {
        title: "Dry-run review",
        body: "Review unknown-consent provenance, frozen segment membership tags, automation rebuild items, sent-post archive classification, optional-endpoint warnings, and premium metadata. No Stripe billing objects are created.",
      },
      {
        title: "Import",
        body: "Commit the reviewed subscriber and archive scope. Rebuild dynamic segment predicates, automations, publication websites, Boosts/recommendations, ad settings, and billing separately.",
      },
      {
        title: "Final delta and rollback window",
        body: "Because there is no live Beehiiv webhook bridge, freeze relevant edits and run a final full delta. Missing same-job source IDs are disabled only after cursor integrity and the discovery-bound unique-ID count are proven. Verify the result during the rollback window; a credentialed publication certification run remains required.",
      },
    ],
    caveats: [
      "Beehiiv subscription creation time and membership are not portable channel-consent proof; reconcile consent separately before sending.",
      "Completed segment memberships are frozen snapshots under per-segment and account-wide evidence limits. Saved predicates and future dynamic behavior require rebuild and testing.",
      "Automation metadata, emails, and statistics are rebuild evidence only; no Beehiiv automation is translated or activated as executable runtime.",
      "Only past published email/both posts become campaign archive entries. Drafts, scheduled posts, and web-only posts remain read-only source evidence.",
      "Premium membership metadata does not transfer Stripe customers, products, prices, subscriptions, renewals, or billing ownership.",
      "Publication websites/themes, capture widgets, Boosts, recommendations, and ad-network settings/history require manual rebuild or replacement.",
    ],
  },
  convertkit: {
    slug: "convertkit",
    name: "ConvertKit",
    authMethod: "OAuth",
    preserves: [
      "Subscribers",
      "Tags (including the multi-tag membership graph)",
      "Sequences and their emails, in the original step order",
      "Custom fields",
      "Broadcast history as campaign archive entries",
      "Supported provider-bound paid-relationship evidence for review, not billing objects or continuity",
    ],
    steps: [
      {
        title: "Connect",
        body: "ConvertKit OAuth, scoped to read on your account.",
      },
      {
        title: "Discover",
        body: "Snapshots subscribers, tags, sequences, forms, automations.",
      },
      {
        title: "Dry-run review",
        body: "Per-sequence and per-automation translation map. You'll see exactly which steps will migrate and which we can only flag.",
      },
      {
        title: "Import",
        body: "Migration runs in waves: subscribers + tags first, then sequences, then automations. Forms last (they need DOM-level attention).",
      },
      { title: "Rollback window", body: "7-day rollback." },
    ],
    caveats: [
      "ConvertKit Commerce products don't migrate. Moosewave doesn't sell digital products natively.",
      "Visual Automations don't migrate. The adapter reads Sequences and their emails; the visual builder's node graph is not exported, so rebuild those flows in Moosewave.",
      "Forms and landing pages don't migrate. They are counted in the discovery report so you can see what needs rebuilding, but the capture UI itself has to be recreated.",
    ],
  },
  mailerlite: {
    slug: "mailerlite",
    name: "MailerLite",
    authMethod: "API key",
    preserves: [
      "Subscriber status, portable opt-in evidence, custom-field definitions and values, and exact group memberships",
      "Groups as executable tag-backed segments",
      "Saved-segment and automation definitions as rebuild-review evidence",
      "Sent campaign metadata, plain text, email variants, preview references, and aggregate reports",
      "Draft and ready campaign metadata as source-archive rebuild evidence",
      "Form and ecommerce-shop metadata as source-archive evidence",
    ],
    steps: [
      { title: "Connect", body: "Paste your MailerLite API token." },
      {
        title: "Discover",
        body: "Snapshots all subscriber cursor pages plus custom-field definitions, groups, segment metadata, automation definitions, sent/draft/ready campaign inventories, form metadata, and ecommerce-shop metadata.",
      },
      {
        title: "Dry-run review",
        body: "Review suppressions and consent evidence, then rebuild/test every saved segment and automation before activation.",
      },
      { title: "Import", body: "Standard wave-based import." },
      { title: "Rollback window", body: "7-day rollback." },
    ],
    caveats: [
      "MailerLite's documented API does not expose saved-segment predicates, rendered campaign HTML, reusable templates, sites, or landing-page inventory.",
      "Forms and ecommerce shops are metadata evidence only; capture UI, consent settings, embeds, catalogs, purchases, attribution, and triggers must be rebuilt or reconnected.",
      "MailerLite exposes no documented token-to-account identity endpoint. Use a dedicated token, freeze the source for the final snapshot, and revoke it after verification.",
    ],
  },
};

const PLATFORM_FAQS: Record<string, FaqEntry[]> = {
  activecampaign: [
    {
      question:
        "Will my ActiveCampaign automations migrate to live Moosewave automations?",
      answer:
        "No, not automatically. Moosewave preserves ActiveCampaign automation definitions as rebuild-review evidence and shows them in the migration report. Activate a replacement only after an owner rebuilds, tests, or explicitly waives the automation.",
    },
    {
      question: "What ActiveCampaign credentials do I need?",
      answer:
        "Use the account API URL and API token from ActiveCampaign Settings -> Developer -> API Access. Use a dedicated migration user because ActiveCampaign API tokens follow that user's account access, and keep it active through shadow monitoring, final delta import, rollback validation, and credential cleanup proof.",
    },
    {
      question:
        "Do ActiveCampaign list status and subscription dates become sendable consent?",
      answer:
        "No. They are preserved as source provenance, but incomplete channel or exclusion evidence stays unconfirmed. Reconcile email and SMS consent separately, compare the ActiveCampaign exclusion list, reconcile source-ID-to-email and tag/list mappings against a reviewed final export because polling cannot prove hard deletions or retire stale pre-change emails, and review phone-only contacts before activating an audience.",
    },
    {
      question:
        "What has to pass before an ActiveCampaign cutover is production-ready?",
      answer:
        "Run discovery, dry-run, commit into an isolated destination, continuous fixed-window source-event overlap, final delta import, channel-consent/exclusion plus source-ID-to-email and tag/list reconciliation against a reviewed final source export/audit, post-delta shadow check, pilot acceptance, rollback rehearsal, rollback cleanup, and dedicated API-token reset/disconnect evidence. Without that live evidence, the path is a controlled pilot, not a flawless cutover.",
    },
  ],
  hubspot: [
    {
      question: "Is HubSpot a full ESP migration or a CRM bridge?",
      answer:
        "It is a CRM contact bridge. Moosewave imports HubSpot contacts, lifecycle fields, contact properties, exact list-membership tags, and changed-contact replay for controlled email targeting while HubSpot remains the CRM system of record. SMS-related fields remain non-sendable archive evidence under HOLD / NO-GO.",
    },
    {
      question: "Does HubSpot consent become sendable consent in Moosewave?",
      answer:
        "Not from contact creation or list membership. The bridge instead requires every active email definition to be SUBSCRIBED, no scoped/wide opt-out, and no current-primary-email hard-bounce, quarantine, invalid-address, marketing-contact, double-opt-in, or legacy-opt-out restriction. Consent timestamps are retained only with defensible evidence. This fail-closed projection is still not exact HubSpot sendability parity, and a primary-email change requires a fresh full snapshot.",
    },
    {
      question: "What has to pass before a HubSpot bridge is production-ready?",
      answer:
        "Run discovery, dry-run, commit into an isolated destination, source-event replay, final delta import, clean shadow check, rollback rehearsal, credential cleanup proof, and pilot acceptance. Without that live evidence, the path is a controlled pilot bridge, not a flawless cutover.",
    },
  ],
  mailchimp: [
    {
      question: "How long does the Mailchimp to Moosewave migration take?",
      answer:
        "It depends on selected-audience size, campaign-report depth, and Mailchimp rate limits. Run discovery and a no-write dry-run first, freeze relevant Mailchimp edits, then commit the same reviewed job. The job exposes per-resource progress and retains a 7-day conflict-aware rollback window after commit.",
    },
    {
      question: "Will my Mailchimp Customer Journeys migrate to Moosewave?",
      answer:
        "No automatic graph migration is claimed. Mailchimp's supported Marketing API does not provide a general Customer Journey / Automation Flow list or graph export, so the generic migration warning is not inventory: operators must inventory and rebuild or waive Journeys manually. A narrowly validated subset of Classic welcome-series automations can import as paused Moosewave runtime records when every audience and template reference resolves.",
    },
    {
      question:
        "Are consent timestamps preserved during the Mailchimp migration?",
      answer:
        "Moosewave preserves the timestamps, provenance, and member state that Mailchimp actually exposes. Contacts without sufficient sendable-consent evidence are quarantined instead of being silently confirmed. Cleaned, unsubscribed, pending, transactional, archived, and other exact source states remain reviewable and suppression-safe.",
    },
  ],
  substack: [
    {
      question:
        "Will my Substack paid subscribers migrate without losing billing?",
      answer:
        "The file migration preserves paid/founding/gift/comp membership metadata only. It does not touch Stripe or Apple subscriptions and cannot promise renewal continuity. Complete a publication-bound provider handoff covering products, customers, trials, tax, disputes, checkout/webhooks, entitlements, and Substack shutdown before cutover.",
    },
    {
      question: "How long does the Substack migration take?",
      answer:
        "The file dry-run and import can take about 20 minutes for a typical export. Consent review, content/media rebuilds, and a provider-approved Stripe/Apple billing handoff are separate cutover work and should not be compressed into that estimate.",
    },
    {
      question: "Do Substack Notes and recommendations migrate to Moosewave?",
      answer:
        "No. Substack Notes have no equivalent surface in Moosewave, and the recommendations graph is contractually bound to Substack. Moosewave has cross-promo and partnership templates as a partial replacement, but you'll need an independent acquisition engine for the lost referral traffic.",
    },
  ],
  beehiiv: [
    {
      question:
        "Will Beehiiv Boosts ad-network revenue continue after I migrate?",
      answer:
        "No continuity is claimed. Boosts, recommendation relationships, ad-network configuration/history, and payout state are Beehiiv-owned network surfaces that this migration does not recreate. If that revenue is material, preserve the provider evidence and plan the replacement before cutover.",
    },
    {
      question: "Does the Beehiiv migration preserve referral attribution?",
      answer:
        "It preserves referral fields that Beehiiv returns with a subscription and source-preserves accessible referral-milestone configuration. That evidence does not recreate Boosts, recommendations, payout state, or a live referral program. Post-template endpoints are treated as source evidence and may expose metadata without template bodies.",
    },
    {
      question: "Can I migrate my Beehiiv paid subscriptions to Moosewave?",
      answer:
        "Not as billing objects. The adapter preserves available premium tier and membership metadata, but it does not migrate Stripe customers, products, prices, subscriptions, renewals, or tenant-bound billing ownership. Plan and verify billing continuity separately.",
    },
    {
      question: "Does Beehiiv stay synchronized after the migration?",
      answer:
        "No live webhook bridge is claimed. Keep Beehiiv authoritative during review, freeze relevant edits, and run a final full delta. After the complete subscriber traversal, Moosewave disables same-job Beehiiv source IDs that disappeared from the source snapshot. Live publication certification remains pending.",
    },
  ],
  convertkit: [
    {
      question: "Will my ConvertKit Visual Automations migrate to Moosewave?",
      answer:
        "No. The adapter reads Sequences and their emails, so those come across with their step order intact, but ConvertKit's visual builder does not export its node graph and Visual Automations are not translated. Rebuild those flows in the Moosewave automation editor; the dry-run report tells you how many are waiting.",
    },
    {
      question: "Does the ConvertKit migration preserve tags?",
      answer:
        "Yes including the multi-tag membership graph. Subscribers migrate with their full tag set intact; segments translate to Postgres DSL which is strictly more expressive than ConvertKit's tag plus segment builder for complex boolean nesting.",
    },
    {
      question: "What about ConvertKit Commerce (digital products)?",
      answer:
        "Commerce checkout doesn't migrate, and Moosewave doesn't sell digital products natively. The adapter can preserve supported provider-bound paid-relationship evidence for review, but it does not transfer billing ownership, re-bill readers, or activate checkout, renewal, entitlement, or subscription-management runtime. Plan and verify billing continuity separately.",
    },
  ],
  mailerlite: [
    {
      question: "Will my MailerLite automations migrate to Moosewave?",
      answer:
        "Not as live workflows. Moosewave preserves MailerLite trigger and step payloads as rebuild-review evidence, but provider-specific graph semantics and rendered automation-email bodies are not safely portable. Rebuild and test each dependency before activation.",
    },
    {
      question: "How long does the MailerLite to Moosewave migration take?",
      answer:
        "About 15 to 20 minutes for a typical 25,000-subscriber list. Paste your API token, run discovery (60 seconds), review the verification report (1 to 2 minutes), commit (8 to 25 minutes), then verify with an Inbox Reality test send.",
    },
    {
      question: "Do MailerLite Sites pages migrate to Moosewave?",
      answer:
        "No. Moosewave has its own forms surface but doesn't host full websites. You'll need to recreate Sites pages with Moosewave forms, your own website builder, or a CMS. Embeddable forms drop into any HTML page with a single snippet.",
    },
  ],
};

export function generateStaticParams() {
  return Object.keys(DETAILS).map((from) => ({ from }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ from: string }>;
}): Promise<Metadata> {
  const { from } = await params;
  const detail = DETAILS[from];
  if (!detail) {
    return {
      title: "Migration not found | Moosewave",
      robots: { index: false, follow: false },
    };
  }
  const url = `https://moosewave.com/migrations/${from}`;
  const description = migrationDetailDescription(detail);
  return {
    title: `Migrate from ${detail.name} to Moosewave`,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      type: "article",
      url,
      title: `Migrate from ${detail.name} to Moosewave`,
      description,
      siteName: "Moosewave",
      locale: "en_US",
      images: [
        {
          url: `/migrations/${from}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `Migrate from ${detail.name} to Moosewave`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `Migrate from ${detail.name} to Moosewave`,
      description,
      creator: "@moosewave",
    },
  };
}

function migrationDetailDescription(detail: SourceDetail): string {
  if (detail.slug === "activecampaign") {
    return "Migrate from ActiveCampaign to Moosewave with API token + account API URL, contact/list import, campaign archive, automation rebuild evidence, dry-run review, final delta, and rollback gates.";
  }
  if (detail.slug === "hubspot") {
    return "Bridge HubSpot contacts into Moosewave with a private app token, lifecycle fields, contact properties, exact list-membership tags, source-event shadow checks, final delta import, rollback rehearsal, and pilot acceptance gates.";
  }
  if (detail.slug === "beehiiv") {
    return "Migrate one workspace-validated Beehiiv publication with cursor subscribers, frozen audience snapshots, automation rebuild evidence, eligible sent-post history, explicit billing boundaries, and a reviewed final full delta.";
  }
  return `Migrate from ${detail.name} to Moosewave with a ${detail.authMethod} connection, dry-run verification, source-specific caveat review, consent and suppression checks, and a 7-day rollback window after commit.`;
}

function migrationHowToDescription(detail: SourceDetail): string {
  if (detail.slug === "activecampaign") {
    return "Move ActiveCampaign contacts, lists/tags, campaign archive, automation rebuild evidence, and source-event cutover checks to Moosewave with a dry-run verification report before commit.";
  }
  if (detail.slug === "hubspot") {
    return "Bridge HubSpot contacts, lifecycle fields, contact properties, and exact list-membership tags to Moosewave with dry-run verification, source-event shadow checks, final delta import, rollback rehearsal, and pilot acceptance before cutover.";
  }
  if (detail.slug === "beehiiv") {
    return "Move Beehiiv subscribers, newsletter-list tags, completed segment snapshots, eligible sent-post history, premium metadata, and rebuild evidence with dry-run verification; no consent, Stripe billing, automation activation, or live webhook continuity is implied.";
  }
  return `Move subscribers, consent records, suppression lists, source-specific automation or rebuild inventory, and paid Stripe subscriptions where supported from ${detail.name} to Moosewave with a dry-run verification report before commit.`;
}

function migrationSupplyName(detail: SourceDetail): string {
  if (detail.slug === "activecampaign") {
    return "ActiveCampaign API token and account API URL";
  }
  if (detail.slug === "hubspot") {
    return "HubSpot private app access token";
  }
  return `${detail.name} ${detail.authMethod === "OAuth" ? "account (OAuth)" : detail.authMethod}`;
}

function buildHowToJsonLd(detail: SourceDetail): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: `Migrate from ${detail.name} to Moosewave`,
    description: migrationHowToDescription(detail),
    supply: [
      {
        "@type": "HowToSupply",
        name: migrationSupplyName(detail),
      },
      {
        "@type": "HowToSupply",
        name: "DNS access for sender authentication (SPF/DKIM/DMARC)",
      },
    ],
    step: detail.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.title,
      text: s.body,
    })),
  };
}

export default async function MigrationDetailPage({
  params,
}: {
  params: Promise<{ from: string }>;
}) {
  const { from } = await params;
  const detail = DETAILS[from];
  if (!detail) notFound();
  const url = `https://moosewave.com/migrations/${from}`;
  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: "https://moosewave.com" },
    { name: "Migrations", url: "https://moosewave.com/migrations" },
    { name: detail.name, url },
  ]);
  const faqs = PLATFORM_FAQS[from] ?? [];
  const blocks: JsonLdObject[] = [buildHowToJsonLd(detail), breadcrumbs];
  if (faqs.length > 0) {
    blocks.push(faqPageSchema(faqs));
  }
  return (
    <div className="max-w-4xl mx-auto px-6 py-16 space-y-12">
      <JsonLd data={blocks} />
      <header className="space-y-3">
        <p className="text-sm text-pw-muted-on-paper">
          <Link href="/migrations" className="underline underline-offset-2">
            ← All migrations
          </Link>
        </p>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          Migrate from {detail.name} to Moosewave
        </h1>
        <p className="text-pw-muted-on-paper">
          {detail.heroSummary ??
            `${detail.authMethod} connection. Dry-run verification, source-specific caveat review, consent and suppression checks, and a 7-day rollback window after commit.`}
        </p>
        <div className="pt-2">
          <Button asChild size="lg">
            <Link href={asRoute(`/app/migrations/new/${detail.slug}`)}>
              Start your migration →
            </Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>What we preserve</CardTitle>
          <CardDescription>
            Out of the box. Nothing in this list requires custom mapping.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {detail.preserves.map((p) => (
              <li key={p} className="flex gap-2 items-start">
                <span className="text-pw-ember-600">✓</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Step by step</CardTitle>
          <CardDescription>What you&apos;ll see, in order.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4 text-sm">
            {detail.steps.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="h-7 w-7 shrink-0 rounded-full bg-pw-ember-500 text-white inline-flex items-center justify-center text-xs font-semibold">
                  {i + 1}
                </span>
                <div>
                  <div className="font-medium">{step.title}</div>
                  <div className="text-pw-muted-on-paper mt-1">{step.body}</div>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Caveats, the honest list</CardTitle>
          <CardDescription>
            Things {detail.name} has that don&apos;t fit cleanly into Moosewave.
            We surface them up-front so the dry-run isn&apos;t the first time
            you hear about them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {detail.caveats.map((c) => (
              <li key={c} className="flex gap-2 items-start">
                <span className="text-amber-600 shrink-0">!</span>
                <span className="text-pw-muted-on-paper">{c}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {faqs.length > 0 ? (
        <section aria-labelledby="faq-heading">
          <h2
            id="faq-heading"
            className="text-2xl md:text-3xl font-semibold tracking-tight mb-6"
          >
            Frequently asked about migrating from {detail.name}
          </h2>
          <div className="space-y-3">
            {faqs.map((item) => (
              <details
                key={item.question}
                className="group rounded-lg border bg-pw-paper px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-start justify-between gap-4 list-none">
                  <h3 className="text-sm font-medium m-0">{item.question}</h3>
                  <span
                    aria-hidden
                    className="font-mono text-pw-muted-on-paper/70 text-sm shrink-0 group-open:rotate-45 transition-transform motion-reduce:transition-none"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm text-pw-muted-on-paper leading-relaxed">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      <section className="text-center space-y-4 border-t pt-10">
        <p className="text-pw-muted-on-paper">
          Ready to start? You&apos;ll need to be logged in.
        </p>
        <Button asChild size="lg">
          <Link href={asRoute(`/app/migrations/new/${detail.slug}`)}>
            Start your migration →
          </Link>
        </Button>
      </section>
    </div>
  );
}
