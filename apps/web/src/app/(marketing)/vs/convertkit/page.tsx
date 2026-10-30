// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import {
  ComparisonPage,
  buildProductJsonLd,
  type ComparisonRow,
  type DimensionDetail,
  type WhenScenario,
} from "@/components/marketing/comparison-page";
import { publicSiteOrigin } from "@/lib/site-url";

const COMPETITOR = "ConvertKit";
const SLUG = "convertkit";
const PAGE_URL = `${publicSiteOrigin()}/vs/${SLUG}`;

const DESCRIPTION =
  "Compare Moosewave and ConvertKit (Kit) on finite monthly plans, voice-trained AI sequences, and transparent inbox-placement evidence.";

export const metadata: Metadata = {
  title: "Moosewave vs ConvertKit (Kit) for creators",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave vs ConvertKit",
    description: DESCRIPTION,
    siteName: "Moosewave",
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave vs ConvertKit",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

const ROWS: ComparisonRow[] = [
  {
    dimension: "Pricing model",
    moosewave: "$39 / $99 / $349 monthly with finite plan allowances",
    competitor: "Per-subscriber tiers (Creator / Creator Pro)",
  },
  {
    dimension: "Billing model",
    moosewave:
      "Monthly subscription with hard plan allowances and no automatic overages",
    competitor: "Monthly subscription that escalates with subscriber count",
  },
  {
    dimension: "Subscribers as billing unit",
    moosewave: "No",
    competitor:
      "Yes, every subscriber bills, including unsubscribed unless removed",
  },
  {
    dimension: "Included emails / month",
    moosewave: "25K / 100K / 500K accepted recipients per month",
    competitor: "Unlimited within tier sub-cap",
  },
  {
    dimension: "List size limit",
    moosewave: "2,500 / 10,000 / 50,000 active emailable profiles",
    competitor: "Tier-capped; custom pricing above 400K",
  },
  {
    dimension: "Send-time deliverability transparency",
    moosewave: "Controlled-inbox placement + AI Diagnostician",
    competitor: "Aggregate metrics; no inbox-placement matrix",
  },
  {
    dimension: "AI features",
    moosewave: "Voice-trained sequences + AI Diagnostician for deliverability",
    competitor: "Subject + content writing assist",
  },
  { dimension: "Voice cloning", moosewave: "Yes", competitor: "No" },
  {
    dimension: "Migration in",
    moosewave:
      "OAuth into ConvertKit; subscribers, tags, sequences with their emails, custom fields, and provider-bound paid-relationship evidence. Visual Automations are counted for rebuild, not imported",
    competitor: "Limited inbound tooling",
  },
  {
    dimension: "Migration out",
    moosewave: "Full export, subs, archives, automations as canonical AST",
    competitor: "CSV of subscribers; sequences and automations stay locked in",
  },
  {
    dimension: "Automations",
    moosewave: "Typed flow authoring; execution held",
    competitor: "Visual automation builder (mature)",
  },
  {
    dimension: "Paid subscriptions",
    moosewave:
      "Supported provider-bound relationship evidence can be preserved for review; checkout, re-billing, entitlements, and subscription creation or management are unavailable",
    competitor: "Commerce add-on, platform fee applies",
  },
  {
    dimension: "A/B testing",
    moosewave: "Subject + content on every tier; multivariate planned V2",
    competitor: "Subject only on Creator; broader on Pro",
  },
  {
    dimension: "Segments",
    moosewave: "Postgres DSL",
    competitor: "Tag + segment builder",
  },
  {
    dimension: "API maturity",
    moosewave: "REST + webhooks + OpenAPI at GA",
    competitor: "REST API (mature)",
  },
  {
    dimension: "Support",
    moosewave: "2 business days on Launch; 1 day on Growth; 8 hours on Scale",
    competitor: "Email; live chat on Pro",
  },
  {
    dimension: "MCP / agent support",
    moosewave: "Release held · source candidate only",
    competitor: "Community-built only",
  },
];

const SCENARIOS: WhenScenario[] = [
  {
    title: "You live inside ConvertKit’s visual automation builder",
    body: "ConvertKit’s automation canvas is mature and operational. Moosewave currently ships typed flow authoring and validation only; activation, enrollment, scheduling, execution, and delivery are held. ConvertKit Visual Automations are counted for rebuild rather than migrated intact.",
  },
  {
    title: "You sell digital products through ConvertKit Commerce",
    body: "ConvertKit Commerce + tip jar are tightly integrated. Moosewave can preserve supported paid-relationship evidence for review, but it does not provide checkout, re-billing, entitlement, or subscription-management runtime in this release. If most of your revenue runs through Commerce, that operational gap matters.",
  },
  {
    title: "You depend on the Creator Network for cross-promo",
    body: "ConvertKit’s Creator Network and Sponsor Network drive real signups for some publications. Moosewave doesn’t run a creator network. If you can attribute meaningful growth to that channel, factor it into the switching decision.",
  },
];

const MIGRATION_STEPS = [
  'Click "Import from ConvertKit" inside Moosewave and complete the OAuth flow.',
  "Moosewave runs a dry-run import: subscribers (with consent timestamps), tags, segments, and sequences with their emails. Visual Automations, forms and landing pages are counted so you can see what needs rebuilding, but they are not imported.",
  "Review the verification report including consent-timestamp coverage, suppression-list parity, and the sequence step map.",
  "Confirm the import, idempotent and resumable, with a 7-day rollback window.",
  "Review supported provider-bound paid-relationship evidence, then plan and verify checkout, billing, entitlement, and subscription continuity outside this migration; no relationship is re-billed or activated by the import.",
  "Authenticate sending domain via the in-product DNS wizard, then run an Inbox Reality test send before cutting over.",
];

const DETAILS: DimensionDetail[] = [
  {
    heading: "1. Per-subscriber pricing, where it bites",
    body: (
      <>
        <p>
          ConvertKit’s Creator and Creator Pro tiers ladder by subscriber count.
          The bill grows whether you send daily, weekly, or once a month. At
          100K subs, Creator Pro lists at roughly $679/month, about $8,100 per
          year.
        </p>
        <p>
          Moosewave uses finite monthly Launch, Growth, and Scale plans at $39,
          $99, and $349. Each plan publishes its active-profile and accepted-
          recipient allowance and stops the affected action at the cap. Compare
          current pricing against your real profile and send volume.
        </p>
      </>
    ),
  },
  {
    heading: "2. Inbox Reality vs aggregate analytics",
    body: (
      <p>
        ConvertKit reports opens, clicks, unsubscribes, the usual. Moosewave can
        run controlled tests against the active seed roster and shows the
        Primary / Promotions / Spam observations returned by each provider. The
        AI Diagnostician (Gemini Pro) translates the result into a ranked,
        actionable list of fixes (DNS records, content edits, suppression-list
        actions). Pre-Send Predictor catches common Promotions triggers before
        you click Send.
      </p>
    ),
  },
  {
    heading: "3. Voice AI vs generic writing assist",
    body: (
      <p>
        ConvertKit’s AI is competent generic LLM output. Moosewave ingests your
        existing sequences, broadcasts, and external content sources (RSS,
        podcast transcripts, socials) and builds a stylistic fingerprint, then
        generates new sequences in your voice with an embedding-based fidelity
        score. Sub-60 scores regenerate automatically before you ever see the
        draft.
      </p>
    ),
  },
  {
    heading: "4. Automations. Typed flow authoring, with execution held",
    body: (
      <p>
        ConvertKit’s visual automation builder is one of its strongest features.
        Moosewave ships a visual editor for typed flow definitions, but it does
        not activate, enroll, schedule, execute, or deliver them in this
        deployment. ConvertKit Visual Automations are counted for rebuild and
        are not imported as running Moosewave flows. If the canvas is your daily
        operational UX, weigh that gap honestly.
      </p>
    ),
  },
  {
    heading: "5. Migration. OAuth + canonical translation",
    body: (
      <p>
        Moosewave’s ConvertKit adapter is OAuth-driven. It pulls subscribers
        with consent timestamps, tags, segments translated to Postgres DSL,
        sequences with their emails, and supported provider-bound Commerce
        relationship evidence for review. It does not migrate billing ownership,
        re-bill a reader, or activate checkout or entitlement runtime. Visual
        Automations, forms and landing pages are counted in the report but not
        imported — rebuild those in Moosewave. Verification report + dry-run +
        7-day rollback.
      </p>
    ),
  },
  {
    heading: "6. Paid-relationship evidence, not billing runtime",
    body: (
      <p>
        ConvertKit Commerce is an operational billing product. Moosewave retains
        supported paid-relationship evidence as historical migration context;
        checkout, billing mutation, renewals, entitlements, and subscription
        management are unavailable in this release.
      </p>
    ),
  },
  {
    heading: "7. Segments, A/B, API, support",
    body: (
      <p>
        Segmentation: Moosewave’s Postgres DSL is strictly more expressive than
        ConvertKit’s tag + segment builder for complex boolean nesting. A/B:
        subject and content on every Moosewave tier, multivariate planned V2.
        API: REST + webhooks + OpenAPI at GA, subject to the plan&apos;s finite
        API allowance. Support targets vary by Launch, Growth, and Scale.
      </p>
    ),
  },
];

export default function VsConvertKitPage(): JSX.Element {
  return (
    <ComparisonPage
      competitor={COMPETITOR}
      slug={SLUG}
      oneLiner="ConvertKit (Kit) is the creator-favorite SaaS, with a mature visual automation builder and a strong Commerce add-on. Moosewave can migrate supported subscriber, tag, and sequence data and preserve provider-bound paid-relationship evidence for review; Visual Automations remain rebuild work, flow execution is release-held, and billing continuity must be handled separately."
      rows={ROWS}
      details={DETAILS}
      scenarios={SCENARIOS}
      migrationSteps={MIGRATION_STEPS}
      jsonLd={buildProductJsonLd({
        competitor: COMPETITOR,
        slug: SLUG,
        description: DESCRIPTION,
      })}
    />
  );
}
