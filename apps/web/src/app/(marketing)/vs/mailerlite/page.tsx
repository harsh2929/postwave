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

const COMPETITOR = "MailerLite";
const SLUG = "mailerlite";
const PAGE_URL = `${publicSiteOrigin()}/vs/${SLUG}`;

const DESCRIPTION =
  "Compare Moosewave and MailerLite on finite monthly plans, voice-trained AI sequences, inbox-placement evidence, and dry-run-first migration gaps.";

export const metadata: Metadata = {
  title: "Moosewave vs MailerLite for serious newsletters",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave vs MailerLite",
    description: DESCRIPTION,
    siteName: "Moosewave",
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave vs MailerLite",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

const ROWS: ComparisonRow[] = [
  {
    dimension: "Pricing model",
    moosewave: "$39 / $99 / $349 monthly with finite plan allowances",
    competitor: "Per-subscriber tiers (Growing Business / Advanced)",
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
    competitor: "Yes",
  },
  {
    dimension: "Included emails / month",
    moosewave: "25K / 100K / 500K accepted recipients per month",
    competitor: "Unlimited within tier sub-cap",
  },
  {
    dimension: "List size limit",
    moosewave: "2,500 / 10,000 / 50,000 active emailable profiles",
    competitor: "Tier-capped; custom pricing above 100K",
  },
  {
    dimension: "Send-time deliverability transparency",
    moosewave: "Controlled-inbox placement + AI Diagnostician",
    competitor: "Aggregate metrics; no inbox-placement matrix",
  },
  {
    dimension: "AI features",
    moosewave: "Voice-trained sequences + AI Diagnostician for deliverability",
    competitor: "AI writing assist; subject helper",
  },
  { dimension: "Voice cloning", moosewave: "Yes", competitor: "No" },
  {
    dimension: "Migration in",
    moosewave:
      "API import: subs, custom fields, and exact group tags. Saved segments and automation definitions come across as rebuild evidence, never auto-activated",
    competitor: "Limited inbound tooling",
  },
  {
    dimension: "Migration out",
    moosewave: "Full export, subs, archives, automations as canonical AST",
    competitor: "CSV of subs; automations stay locked in",
  },
  {
    dimension: "Automations",
    moosewave: "Typed flow authoring; execution held",
    competitor: "Visual workflow builder",
  },
  {
    dimension: "Paid subscriptions",
    moosewave:
      "Historical paid-relationship evidence can be reviewed; checkout, re-billing, entitlements, and subscription creation or management are unavailable",
    competitor: "Limited; Stripe integration via add-on",
  },
  {
    dimension: "A/B testing",
    moosewave: "Subject + content on every tier; multivariate planned V2",
    competitor: "Subject and content; multivariate on Advanced",
  },
  {
    dimension: "Segments",
    moosewave: "Postgres DSL",
    competitor: "Visual segment + group builder",
  },
  {
    dimension: "API maturity",
    moosewave: "REST + webhooks + OpenAPI at GA",
    competitor: "REST API (mature)",
  },
  {
    dimension: "Support",
    moosewave: "2 business days on Launch; 1 day on Growth; 8 hours on Scale",
    competitor: "Email; chat on paid tiers; priority on Advanced",
  },
  {
    dimension: "MCP / agent support",
    moosewave: "Release held · source candidate only",
    competitor: "✓ HTTP only",
  },
];

const SCENARIOS: WhenScenario[] = [
  {
    title: "You’re under 1,000 subscribers and not yet monetizing",
    body: "MailerLite’s free tier may suit a small list. Moosewave Sandbox is for simulation only; production sending begins with the $39/month Launch plan. Compare the actual workflow and allowances before switching.",
  },
  {
    title:
      "You depend on MailerLite’s built-in website and landing-page builder",
    body: "MailerLite ships a competent website and landing-page builder bundled with email. Moosewave focuses on email and forms; full website hosting is not in scope. If your marketing site lives inside MailerLite, that integration matters.",
  },
  {
    title:
      "You need MailerLite’s e-commerce automations for a Shopify / WooCommerce store",
    body: "MailerLite’s e-commerce integrations and abandoned-cart automations are built for stores. Moosewave’s ICP is the newsletter writer; commerce-segmented automations are not on the V1 roadmap.",
  },
];

const MIGRATION_STEPS = [
  "Generate a MailerLite API key (Account → Integrations → API) and paste it into Moosewave’s MailerLite adapter.",
  "Moosewave dry-runs subscriber status, portable opt-in evidence, custom fields, group memberships, sent campaign/report metadata, and source-archive evidence.",
  "Review suppression and consent coverage. Rebuild and test saved-segment rules, automations, forms, templates, sites, and commerce dependencies.",
  "Confirm the import; idempotent and resumable, with a 7-day rollback window.",
  "Authenticate sending domain via the in-product DNS wizard, we pre-check MailerLite’s existing records so you know what to swap and when.",
  "Run an Inbox Reality test send before cutting over the audience.",
];

const DETAILS: DimensionDetail[] = [
  {
    heading: "1. Pricing model",
    body: (
      <>
        <p>
          MailerLite is the gentlest of the per-subscriber pricers, which is why
          it’s such a popular Mailchimp escape hatch. But it’s still
          per-subscriber: bills escalate with list growth even if your sending
          cadence is steady.
        </p>
        <p>
          Moosewave&apos;s plans cap active emailable profiles at 2,500, 10,000,
          or 50,000 and accepted recipients at 25,000, 100,000, or 500,000.
          Those finite limits are visible before purchase and migration.
        </p>
      </>
    ),
  },
  {
    heading: "2. Inbox Reality vs aggregate analytics",
    body: (
      <p>
        MailerLite’s analytics are clean and modern but show only opens, clicks,
        unsubscribes. Moosewave can run controlled tests against the active seed
        roster and shows which configured providers actually returned placement
        observations. The AI Diagnostician translates auth data, Postmaster
        Tools, and content shape into a ranked, actionable fix list.
      </p>
    ),
  },
  {
    heading: "3. AI, voice cloning vs writing assist",
    body: (
      <p>
        MailerLite’s AI surface is generic LLM writing assist. subject lines,
        body suggestions. Moosewave learns your voice from your existing
        campaigns + optional RSS / podcast / socials and generates sequences
        with an embedding-based fidelity score that triggers regeneration below
        60.
      </p>
    ),
  },
  {
    heading: "4. Migration, what actually moves",
    body: (
      <p>
        Moosewave’s assisted MailerLite adapter pulls subscriber status and
        provider-available opt-in evidence, custom fields, exact group
        memberships, sent campaign metadata/plain text/report totals, and
        form/shop metadata as source evidence. Groups become tag-backed
        segments. Saved segment predicates, automations, live forms, templates,
        sites, and commerce behavior remain explicit rebuild work.
      </p>
    ),
  },
  {
    heading: "5. Automations. Typed flow authoring, with execution held",
    body: (
      <p>
        MailerLite’s visual workflow builder is operational. Moosewave ships a
        visual editor for typed flow definitions, but activation, enrollment,
        scheduling, execution, and delivery are held. The MailerLite API exposes
        useful trigger and step metadata but not a safely portable executable or
        message-body contract, so migration preserves rebuild evidence instead
        of activating partial translations.
      </p>
    ),
  },
  {
    heading: "6. Paid subscriptions",
    body: (
      <p>
        MailerLite’s paid-newsletter support is provider-integrated. Moosewave
        can preserve supported historical paid-relationship evidence for review,
        but checkout, billing mutation, renewals, entitlements, and subscription
        management are unavailable in this release.
      </p>
    ),
  },
  {
    heading: "7. Honest gaps",
    body: (
      <p>
        MailerLite’s bundled website + landing-page builder, free tier for small
        lists, and e-commerce integrations are real. If any of those are central
        to your workflow, MailerLite may outweigh Moosewave’s pricing and AI
        advantages.
      </p>
    ),
  },
];

export default function VsMailerLitePage(): JSX.Element {
  return (
    <ComparisonPage
      competitor={COMPETITOR}
      slug={SLUG}
      oneLiner="Moosewave combines finite monthly allowances with controlled-inbox placement evidence, voice-trained sequences, and a dry-run-first migration workflow."
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
