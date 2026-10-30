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

const COMPETITOR = "Sendy";
const SLUG = "sendy";
const PAGE_URL = `${publicSiteOrigin()}/vs/${SLUG}`;

const DESCRIPTION =
  "Compare managed Moosewave plans with self-hosted Sendy on operations, sending costs, voice-trained AI, and inbox-placement evidence.";

export const metadata: Metadata = {
  title: "Moosewave vs Sendy, managed operations or self-hosting",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave vs Sendy",
    description: DESCRIPTION,
    siteName: "Moosewave",
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave vs Sendy",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

const ROWS: ComparisonRow[] = [
  {
    dimension: "Pricing model",
    moosewave: "$39 / $99 / $349 monthly with finite plan allowances",
    competitor:
      "$69 one-time license + $99 major-version upgrades; you pay SES",
  },
  {
    dimension: "Billing model",
    moosewave:
      "Monthly subscription with hard plan allowances and no automatic overages",
    competitor: "One-time license; you operate the server and SES bill",
  },
  {
    dimension: "Subscribers as billing unit",
    moosewave: "No",
    competitor: "No",
  },
  {
    dimension: "Included emails / month",
    moosewave: "25K / 100K / 500K accepted recipients per month",
    competitor: "None, you pay SES at $0.40/1K",
  },
  {
    dimension: "List size limit",
    moosewave: "2,500 / 10,000 / 50,000 active emailable profiles",
    competitor: "Unlimited (subject to your server resources)",
  },
  {
    dimension: "Send-time deliverability transparency",
    moosewave: "Controlled-inbox placement + AI Diagnostician",
    competitor: "Bounce / complaint webhooks from SES; no inbox-placement view",
  },
  {
    dimension: "AI features",
    moosewave: "Voice-trained sequences + AI Diagnostician for deliverability",
    competitor: "None",
  },
  { dimension: "Voice cloning", moosewave: "Yes", competitor: "No" },
  {
    dimension: "Migration in",
    moosewave: "CSV + most platform adapters",
    competitor: "CSV import",
  },
  {
    dimension: "Migration out",
    moosewave: "Full export, subs, archives, automations as canonical AST",
    competitor: "CSV; you own the Postgres / MySQL on your server",
  },
  {
    dimension: "Automations",
    moosewave: "Typed flow authoring; execution held",
    competitor: "Autoresponders only",
  },
  {
    dimension: "Paid subscriptions",
    moosewave:
      "Historical paid-relationship evidence can be reviewed; checkout, re-billing, entitlements, and subscription creation or management are unavailable",
    competitor: "Not supported",
  },
  {
    dimension: "A/B testing",
    moosewave: "Subject + content on every tier; multivariate planned V2",
    competitor: "Not supported in core",
  },
  {
    dimension: "Segments",
    moosewave: "Postgres DSL",
    competitor: "Basic list segmentation",
  },
  {
    dimension: "API maturity",
    moosewave: "REST + webhooks + OpenAPI at GA",
    competitor: "REST API (basic)",
  },
  {
    dimension: "Support",
    moosewave: "2 business days on Launch; 1 day on Growth; 8 hours on Scale",
    competitor: "Email; community forum",
  },
  {
    dimension: "MCP / agent support",
    moosewave: "Release held · source candidate only",
    competitor: "✗",
  },
];

// Sendy: $69 one-time + ~$0.40/1K SES + a small VPS (~$10/mo)
const SCENARIOS: WhenScenario[] = [
  {
    title: "You enjoy operating servers and the cost gap matters",
    body: "Sendy at SES rates is genuinely the cheapest sending option in the market. If you have the operational appetite to run PHP + MySQL, manage SES warm-up, monitor bounces, patch a Linux box, and handle your own backups, the dollar savings are real.",
  },
  {
    title:
      "You only need broadcasts, no automations, no voice AI, no paid subs",
    body: "Sendy’s feature surface is intentionally small: broadcasts, autoresponders, and basic segmentation. Moosewave adds typed flow authoring, but its automation execution runtime is release-held; compare current operational needs rather than planned breadth.",
  },
  {
    title: "You’re self-hosting on principle",
    body: "Moosewave application source is AGPL-3.0-only, but a production-qualified self-host distribution and support contract are not currently offered. If operating every layer yourself is non-negotiable today, Sendy + your own DNS + SES + your own scripts is the more honest choice.",
  },
];

const MIGRATION_STEPS = [
  "Export your Sendy list as CSV (Sendy → Lists → Export).",
  "Upload to Moosewave’s CSV importer; map columns to canonical fields.",
  "If you have autoresponders configured, recreate them as Moosewave automations (the AST is more expressive, most Sendy autoresponders translate to a single sequence).",
  "Authenticate your sending domain in Moosewave and connect a supported sender before production use.",
  "Optionally migrate the suppression list (bounces, complaints) via CSV to maintain SES reputation continuity.",
  "Run an Inbox Reality test send to verify placement before cutting over.",
];

const DETAILS: DimensionDetail[] = [
  {
    heading: "1. Operating cost vs operating effort",
    body: (
      <>
        <p>
          Sendy is the dollar-cheapest sending option in this comparison set,
          full stop. $69 one-time, plus SES at $0.40/1K, plus a small VPS to run
          the PHP. For a 50K-subscriber writer sending weekly, that’s under
          $500/year all-in.
        </p>
        <p>
          The real question is what your time costs. Sendy requires you to run a
          server, manage PHP and MySQL, configure SES warm-up, monitor bounces
          and complaints, patch security updates, handle your own backups, deal
          with deliverability issues without an AI to translate them, and
          recover from your own outages. Moosewave begins at $39/month with
          25,000 accepted recipients and scales through finite Growth and Scale
          allowances. It costs more than Sendy and removes much of the server
          administration; no automatic paid overage is added.
        </p>
      </>
    ),
  },
  {
    heading: "2. Deliverability transparency",
    body: (
      <p>
        Sendy gives you SES bounce and complaint webhooks. That tells you about
        hard failures but nothing about whether your campaigns landed in
        Primary, Promotions, or Spam at Gmail. Moosewave can run controlled
        tests against the active seed roster and shows the returned placement
        matrix, with the AI Diagnostician translating results into ranked,
        actionable fixes.
      </p>
    ),
  },
  {
    heading: "3. AI features, none vs voice-trained",
    body: (
      <p>
        Sendy has no AI features by design, it’s a pure send engine. Moosewave’s
        Voice AI builds a stylistic fingerprint from your existing campaigns and
        generates sequences with an embedding-based fidelity score. If you write
        everything yourself and want no AI involvement, this is a
        non-difference.
      </p>
    ),
  },
  {
    heading: "4. Automations and segments",
    body: (
      <p>
        Sendy supports broadcasts and basic autoresponders. Moosewave ships
        typed flow authoring and validation for trigger, branch, delay, and exit
        definitions, but activation, enrollment, scheduling, execution, and
        delivery are release-held. Postgres DSL segmentation is a separate
        capability and does not make a stored flow operational.
      </p>
    ),
  },
  {
    heading: "5. Paid subscriptions, A/B, API",
    body: (
      <p>
        Sendy doesn’t support paid newsletter subscriptions or much beyond a
        basic API. Moosewave can review historical paid-relationship evidence,
        but checkout, billing mutation, renewals, entitlements, and subscription
        management are unavailable. Campaign A/B remains configuration-only;
        documented REST and OpenAPI surfaces are separate capabilities.
      </p>
    ),
  },
  {
    heading: "6. Migration in and out",
    body: (
      <p>
        Coming from Sendy is straightforward. CSV out, CSV in, optional
        suppression-list import. Going to Sendy from Moosewave is also clean:
        full CSV export plus the canonical schema. You can take your data with
        you; Moosewave does not currently market a production-supported
        self-host distribution as part of that export.
      </p>
    ),
  },
];

export default function VsSendyPage(): JSX.Element {
  return (
    <ComparisonPage
      competitor={COMPETITOR}
      slug={SLUG}
      oneLiner="Sendy is a self-hosted option for teams willing to run PHP and manage their own sending operations. Moosewave packages those workflows into finite monthly plans."
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
