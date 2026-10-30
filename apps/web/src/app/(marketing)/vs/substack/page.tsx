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

const COMPETITOR = "Substack";
const SLUG = "substack";
const PAGE_URL = `${publicSiteOrigin()}/vs/${SLUG}`;

const DESCRIPTION =
  "Moosewave is an alternative to Substack for newsletter operators who want a portable subscriber/archive import, explicit consent and billing handoff gates, and their own sending infrastructure.";

export const metadata: Metadata = {
  title: "Moosewave vs Substack, keep 100% of your paid-subscriber revenue",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave vs Substack",
    description: DESCRIPTION,
    siteName: "Moosewave",
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave vs Substack",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

const ROWS: ComparisonRow[] = [
  {
    dimension: "Pricing model",
    moosewave: "$39 / $99 / $349 monthly with finite plan allowances",
    competitor: "Free hosting; 10% of paid-subscription revenue forever",
  },
  {
    dimension: "Billing model",
    moosewave:
      "Monthly subscription with hard plan allowances and no automatic overages",
    competitor: "Revenue share on every paid subscription invoice, perpetually",
  },
  {
    dimension: "Subscribers as billing unit",
    moosewave: "No",
    competitor: "No (free), but 10% per paid sub",
  },
  {
    dimension: "Included emails / month",
    moosewave: "25K / 100K / 500K accepted recipients per month",
    competitor:
      "Effectively unlimited, sending is bundled into the revenue share",
  },
  {
    dimension: "List size limit",
    moosewave: "2,500 / 10,000 / 50,000 active emailable profiles",
    competitor: "Unlimited",
  },
  {
    dimension: "Send-time deliverability transparency",
    moosewave: "Controlled-inbox placement + AI Diagnostician",
    competitor:
      "Aggregate open / click only; shared sender reputation across all Substack publications",
  },
  {
    dimension: "AI features",
    moosewave: "Voice-trained sequence generator + AI Diagnostician",
    competitor: "Minimal, assistive editing only",
  },
  { dimension: "Voice cloning", moosewave: "Yes", competitor: "No" },
  {
    dimension: "Migration in",
    moosewave:
      "Official ZIP/CSV import preserves subscriber, tier, status, and email-sent archive evidence; billing remains a provider handoff",
    competitor: "n/a. Substack is the destination, not the source for most",
  },
  {
    dimension: "Migration out",
    moosewave:
      "Subscriber/archive export surfaces; billing portability is provider-specific",
    competitor:
      "Subscriber CSV and publication ZIP; billing moves require provider coordination",
  },
  {
    dimension: "Automations",
    moosewave: "Typed flow authoring; execution held",
    competitor: "Basic welcome only",
  },
  {
    dimension: "Paid subscriptions",
    moosewave:
      "The Substack import preserves paid/founding/gift/comp metadata only. Stripe/Apple renewals and entitlements require a publication-bound provider-approved handoff; Moosewave paid-subscription runtime is unavailable",
    competitor: "Native. Substack keeps 10% of every invoice forever",
  },
  {
    dimension: "A/B testing",
    moosewave: "Subject + content on every tier; multivariate planned V2",
    competitor: "Limited",
  },
  {
    dimension: "Segments",
    moosewave: "Postgres DSL, any field, any boolean nesting",
    competitor: "Free / paid / founding only",
  },
  {
    dimension: "API maturity",
    moosewave: "REST + webhooks + OpenAPI spec at GA",
    competitor: "No public API",
  },
  {
    dimension: "Support",
    moosewave: "2 business days on Launch; 1 day on Growth; 8 hours on Scale",
    competitor: "Email; Substack Pro for top writers",
  },
  {
    dimension: "MCP / agent support",
    moosewave: "Release held · source candidate only",
    competitor: "✗",
  },
];

// Substack: 10% of $5/mo paid sub × N subs × 12 months
// 10K subs × $5 × 12 × 10% = $60,000/yr
const SCENARIOS: WhenScenario[] = [
  {
    title: "You depend on Substack’s discovery network",
    body: "Substack’s recommendations, Notes, and the embedded reader app drive real signup volume for some writers. If 30%+ of your growth is intra-Substack referrals, that traffic does not transfer. Stay until you have an independent acquisition engine.",
  },
  {
    title: "You write infrequently and revenue is below $500/mo",
    body: "For a small or infrequent publication, a revenue-share platform may still be simpler. Compare its revenue share with Moosewave’s monthly plan and the operational work of owning your commerce stack.",
  },
  {
    title: "You want zero infrastructure decisions, ever",
    body: "Substack handles sending, payments, hosting, app distribution, and reader experience. Moving requires decisions about sending, destination checkout and entitlement runtime, Stripe/Apple handoff, and your custom domain. If decision fatigue is your bottleneck, Substack’s opinionation is a feature.",
  },
];

const MIGRATION_STEPS = [
  "Create Substack’s official publication ZIP (preferred) or one All columns subscriber CSV and upload it unchanged.",
  "Review de-duplicated subscriber state, unconfirmed consent, paid/founding/gift/comp tier metadata, email-sent post history, and every parity record in the dry-run.",
  "Plan Stripe-billed and Apple-billed readers separately with Substack and the payment provider; reconcile products/customers, renewals, trials, refunds/disputes/tax, checkout/webhooks, and entitlements.",
  "Import subscribers and matching post HTML as immutable sent history; the file import does not touch live billing.",
  "Authenticate your sending domain in Moosewave (SPF / DKIM / DMARC). We provide the exact DNS records to add at your registrar.",
  "Send a goodbye-from-Substack post and a welcome-on-Moosewave post. When controlled testing is enabled, Inbox Reality reports the observations returned by the active seed roster.",
];

const DETAILS: DimensionDetail[] = [
  {
    heading: "1. The 10% question",
    body: (
      <>
        <p>
          Substack’s deal is simple: free hosting in exchange for 10% of every
          paid subscription invoice, forever. At small scale that’s a fair
          trade, you don’t pay anything until you’re earning. At meaningful
          scale the math gets uncomfortable: a writer with 10,000 paid subs at
          $5/month is paying Substack $5,000/month ($60,000/year) in platform
          fees. Moosewave instead uses fixed monthly plans with finite
          allowances, plus the payment-processing and sender-provider costs
          applicable to your setup.
        </p>
        <p>
          The Substack export import does not migrate live Stripe or Apple
          subscriptions. It preserves membership-tier evidence while a separate
          publication-bound handoff must prove billing, entitlement, checkout,
          webhook, tax, dispute, and shutdown behavior before cutover.
        </p>
      </>
    ),
  },
  {
    heading: "2. Sender reputation, shared vs your own",
    body: (
      <p>
        Every Substack publication sends from the same shared infrastructure.
        That means your deliverability is partly a function of every other
        Substack writer’s behavior. With Moosewave you authenticate your own
        sending identity and inspect available authentication evidence. Managed
        dedicated-IP provisioning and assignment are release-held, so the page
        does not offer a priced dedicated sending path. Controlled Inbox Reality
        reports remain separate, observation-backed evidence.
      </p>
    ),
  },
  {
    heading: "3. Discovery network. Substack’s real moat",
    body: (
      <p>
        Substack’s Notes, recommendations, and reader-app surface genuinely move
        readers to your publication. If you measure the share of your new
        signups that come from intra-Substack referrals and it’s above ~30%,
        that’s a real cost of leaving. Moosewave does not replace network
        growth; it replaces the platform layer.
      </p>
    ),
  },
  {
    heading: "4. AI features, voice cloning vs nothing",
    body: (
      <p>
        Substack’s editor is intentionally minimal and largely AI-free.
        Moosewave’s Voice AI ingests your post archive (the one we just
        imported) plus optional RSS, podcast transcripts, and socials, then
        generates welcome sequences, course launches, and re-engagement
        campaigns in your voice with a fidelity score that triggers automatic
        regeneration below 60.
      </p>
    ),
  },
  {
    heading: "5. Migration, billing is a separate cutover",
    body: (
      <p>
        Moosewave preserves subscriber identity, conservative status, tier
        metadata, and email-sent post history from the official export. It does
        not infer a Stripe subscription from an email or arbitrary account ID,
        and Substack can also use Apple in-app purchases. Keep the source active
        until the providers approve and you test the billing and entitlement
        handoff.
      </p>
    ),
  },
  {
    heading: "6. Automations, segments, A/B, API",
    body: (
      <p>
        Substack supports a basic welcome email and free / paid / founding
        segmentation, that’s essentially it. Moosewave ships typed flow
        authoring and validation, but flow activation, enrollment, scheduling,
        execution, and delivery are held. Postgres-DSL segmentation, campaign
        A/B configuration, and documented REST surfaces are separate
        capabilities and do not turn a stored flow into a running automation.
      </p>
    ),
  },
  {
    heading: "7. Ownership",
    body: (
      <p>
        Substack hosts your archive, your subscriber list, and your Stripe
        relationship. You can leave, but every reader-facing URL breaks.
        Moosewave does not currently promise customer-host routing: the legacy
        custom-domain registry is read-only while automated TLS and production
        routing are release-held. If we’re ever the wrong fit, you take a
        portable full export. We do not currently advertise that export as a
        production-supported self-host distribution. Pillar 1 is migration{" "}
        <em>in</em>; Pillar 1.5 is a non-hostile migration <em>out</em>.
      </p>
    ),
  },
  {
    heading: "8. Honest gaps",
    body: (
      <p>
        Substack is a publishing platform with a network. Moosewave is a sending
        and automation platform. We do not have Notes, the reader app, or
        recommendations. If discovery is a meaningful part of your growth,
        you’ll need to bring it from somewhere else.
      </p>
    ),
  },
];

export default function VsSubstackPage(): JSX.Element {
  return (
    <ComparisonPage
      competitor={COMPETITOR}
      slug={SLUG}
      oneLiner="Substack’s revenue-share model bundles publishing, network, and payments. Moosewave offers a portable ZIP/CSV subscriber and sent-archive import with explicit consent, social/content, and Stripe/Apple billing handoff gates—without pretending a file upload can guarantee uninterrupted renewals."
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
