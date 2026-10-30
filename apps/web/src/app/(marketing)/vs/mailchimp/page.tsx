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

const COMPETITOR = "Mailchimp";
const SLUG = "mailchimp";
const PAGE_URL = `${publicSiteOrigin()}/vs/${SLUG}`;

const DESCRIPTION =
  "Compare Moosewave and Mailchimp on finite monthly plans, dry-run-first migration, transparent deliverability evidence, and voice-trained AI sequences.";

export const metadata: Metadata = {
  title: "Moosewave vs Mailchimp for newsletter operations",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave vs Mailchimp",
    description: DESCRIPTION,
    siteName: "Moosewave",
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave vs Mailchimp",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

const ROWS: ComparisonRow[] = [
  {
    dimension: "Pricing model",
    moosewave: "$39 / $99 / $349 monthly with finite plan allowances",
    competitor: "Per-subscriber, recurring monthly",
  },
  {
    dimension: "Billing model",
    moosewave:
      "Monthly subscription with hard plan allowances and no automatic overages",
    competitor: "Subscription tied to contact count",
  },
  {
    dimension: "Subscribers as billing unit",
    moosewave: "Finite active-profile limits: 2,500 / 10,000 / 50,000",
    competitor: "Yes, every contact (including unsubscribed) bills",
  },
  {
    dimension: "Included emails / month",
    moosewave: "25K / 100K / 500K accepted recipients per month",
    competitor:
      "10–15K typical on Standard at small tiers; capped multipliers above",
  },
  {
    dimension: "List size limit",
    moosewave: "2,500 / 10,000 / 50,000 active emailable profiles",
    competitor: "Hard plan ceilings; Premium required above 200K",
  },
  {
    dimension: "Send-time deliverability transparency",
    moosewave: "Controlled-inbox placement evidence + AI Diagnostician",
    competitor: "Aggregate open / click only; no inbox placement signal",
  },
  {
    dimension: "AI features",
    moosewave:
      "Voice-trained sequence generator + AI Diagnostician for deliverability",
    competitor: "Generic subject-line and content suggestions",
  },
  {
    dimension: "Voice cloning",
    moosewave: "Yes, ingests last 20 newsletters + RSS + transcripts",
    competitor: "No, generic LLM prompts",
  },
  {
    dimension: "Migration in",
    moosewave:
      "OAuth into Mailchimp; automated import of subscribers, consent, tags, archives, and the validated paused Classic welcome-series subset; Customer Journeys require rebuild",
    competitor: "CSV out, manual recreation",
  },
  {
    dimension: "Migration out",
    moosewave:
      "Full export at any time, subs, consent, archives, automations as canonical AST",
    competitor:
      "CSV of contacts only; campaign HTML + automation logic stay locked in",
  },
  {
    dimension: "Automations",
    moosewave: "Typed flow authoring; execution held",
    competitor: "Customer Journeys (visual)",
  },
  {
    dimension: "Paid subscriptions",
    moosewave:
      "Historical commerce evidence can be reviewed; checkout, re-billing, entitlements, and subscription creation or management are unavailable",
    competitor: "Not supported",
  },
  {
    dimension: "A/B testing",
    moosewave: "Subject + content on every tier; multivariate planned V2",
    competitor: "A/B on Standard; multivariate on Premium",
  },
  {
    dimension: "Segments",
    moosewave: "Postgres DSL, any field, any nested boolean",
    competitor: "Visual segment builder; advanced gated to Premium",
  },
  {
    dimension: "API maturity",
    moosewave: "REST + webhooks at GA; OpenAPI spec",
    competitor: "Mature API v3",
  },
  {
    dimension: "Support",
    moosewave: "2 business days on Launch; 1 day on Growth; 8 hours on Scale",
    competitor: "Email on Essentials; phone on Premium",
  },
  {
    dimension: "MCP / agent support",
    moosewave: "Release held · source candidate only",
    competitor: "Transactional only",
  },
];

const SCENARIOS: WhenScenario[] = [
  {
    title: "You depend on Customer Journeys at depth",
    body: "Mailchimp's visual journey builder is mature with branching, wait-until conditions, and split tests. Its supported Marketing API does not provide a general Customer Journey graph export, so moving a deep journey requires a manual rebuild and behavior test in Moosewave. If that rebuild is not acceptable, Mailchimp is the safer choice for that workflow.",
  },
  {
    title: "You run a transactional + marketing stack on one bill",
    body: "Mailchimp Transactional (formerly Mandrill) is bundled with marketing billing. Moosewave is marketing-and-newsletter only; transactional belongs on Postmark or SES directly. If consolidating bills matters more than the unit economics, Mailchimp wins.",
  },
  {
    title: "You need integrated commerce + audiences for an e-commerce store",
    body: "Mailchimp's Shopify / WooCommerce / Magento integrations and product-recommendation blocks are built for stores, not writers. Moosewave's ICP is the newsletter writer; commerce-segmented automations are not on the roadmap.",
  },
];

const MIGRATION_STEPS = [
  'Click "Import from Mailchimp" inside Moosewave and complete the OAuth handshake, no API key copying, no CSV gymnastics.',
  "Run the dry-run preview: Moosewave shows a verification report before any data is written, including consent-timestamp coverage and suppression-list parity.",
  "Confirm the import. Subscribers, tags, custom fields, safely translatable segments, supported paused Classic Automations, and archived campaigns move over; Customer Journeys remain explicit rebuild work.",
  "Keep any paid-reader provider authoritative and plan billing continuity separately; this import neither migrates billing objects nor activates paid-subscription runtime.",
  "Authenticate your sending domain (SPF/DKIM/DMARC) via the in-product wizard. We pre-check Mailchimp's existing records so you know what to replace and when.",
  "When controlled testing is enabled, send a test campaign. The Inbox Reality report identifies which active seed mailboxes returned Primary, Promotions, or Spam observations.",
];

const DETAILS: DimensionDetail[] = [
  {
    heading: "1. Pricing model, the big one",
    body: (
      <>
        <p>
          Mailchimp bills per <em>contact</em>, including unsubscribed and
          inactive contacts unless you actively prune them. The January 2026
          changes, free tier shrinking from 500 to 250, unsubscribed contacts
          now billable, no auto-cleanup of stale contacts, pushed a large pool
          of paying customers into a tier that no longer makes sense for a
          once-a-week sender.
        </p>
        <p>
          Moosewave offers Launch, Growth, and Scale at $39, $99, and $349 per
          month. Each plan has finite profile, accepted-recipient, seat,
          automation, AI-credit, and Inbox Reality allowances. Production
          actions stop at their applicable caps; Moosewave does not
          automatically bill overages.
        </p>
      </>
    ),
  },
  {
    heading: "2. Subscribers as a billing unit",
    body: (
      <p>
        Mailchimp&apos;s tier ladder is contact-count driven. As your list
        grows, you walk up tiers regardless of how often you actually send.
        Moosewave publishes active-profile and accepted-recipient caps for each
        plan. That makes the cost boundary visible before you migrate and stops
        the affected action instead of creating an automatic overage.
      </p>
    ),
  },
  {
    heading: "3. Send-time deliverability, the silent killer",
    body: (
      <>
        <p>
          Mailchimp shows you opens and clicks. It does not tell you whether
          your campaign landed in Primary, Promotions, or Spam at Gmail. Two
          campaigns with identical 22% open rates can be wildly different
          stories: one landed in Primary and was actually read, the other landed
          in Promotions and was glanced at by power users on desktop only.
        </p>
        <p>
          When controlled testing is enabled, Moosewave sends a test to the
          deployment&apos;s active seed roster. The report identifies the
          providers that actually returned an observation and shows their
          placement matrix. The AI Diagnostician (Gemini Pro) reads the
          placement, your auth records (SPF, DKIM, DMARC, BIMI, PTR), Postmaster
          Tools data, blacklist status, and content shape, then writes a
          plain-English explanation ranked by predicted impact. Pre-Send
          Predictor catches the common Promotions triggers before you click
          Send.
        </p>
      </>
    ),
  },
  {
    heading: "4. AI features, generic vs voice-native",
    body: (
      <p>
        Mailchimp&apos;s AI surface is broadly the same as every other
        platform&apos;s: subject-line suggestions, content rewrite, send-time
        optimization. It is generic LLM output that reads like every other
        generic LLM output. Moosewave&apos;s Voice AI ingests your existing
        voice (the newsletter archive imported in step one, plus optional RSS,
        podcast transcripts, Twitter, LinkedIn) and builds a ~3KB voice profile.
        Sequences generate in your voice with an embedding-based fidelity score.
        If a draft scores below 60, we automatically regenerate before you ever
        see it.
      </p>
    ),
  },
  {
    heading: "5. Migration in and out, the trust test",
    body: (
      <>
        <p>
          Migration in is the obvious one. Moosewave&apos;s OAuth flow into
          Mailchimp pulls subscribers with consent timestamps intact (the single
          thing every refugee asks about), the suppression list, custom fields,
          tags, safely translatable segments, the supported paused Classic
          Automation subset, and archived campaigns as read-only history.
          Customer Journey graphs remain explicit manual rebuild work because
          Mailchimp does not expose a supported general graph export.
        </p>
        <p>
          Migration <em>out</em> is the trust test. Most platforms make export
          painful by design. Moosewave exports everything via the same canonical
          schema in JSON + CSV + MJML, on-demand, at any time. If we ever stop
          being the right fit, you take your business with you intact. Source
          licensing is documented separately; it is not a promise of a
          production-supported self-host package or shutdown assistance.
        </p>
      </>
    ),
  },
  {
    heading: "6. Automations, typed flow authoring with execution held",
    body: (
      <p>
        Mailchimp&apos;s Customer Journeys is mature and operational. Moosewave
        ships typed flow authoring and validation, but activation, enrollment,
        scheduling, execution, and delivery are held. Mailchimp does not expose
        a supported general Journey graph export, so deep Journeys require
        manual inventory and rebuild. A narrowly supported Classic
        welcome-series subset may import as paused configuration only. Weigh
        both the rebuild and runtime gaps honestly.
      </p>
    ),
  },
  {
    heading: "7. Paid-subscription history, not billing runtime",
    body: (
      <p>
        Mailchimp does not natively support paid newsletter subscriptions.
        Moosewave can retain supported historical commerce evidence, but this
        release does not provide checkout, re-billing, entitlement, renewal, or
        subscription-management runtime. Keep the billing provider
        authoritative.
      </p>
    ),
  },
  {
    heading: "8. A/B testing, segments, API maturity, support",
    body: (
      <p>
        Mailchimp&apos;s A/B testing, visual segment builder, REST API, and
        tiered support are mature and adequate. Moosewave matches feature parity
        on segments (Postgres DSL is strictly more expressive than the visual
        builder), A/B on subject and content, and ships an OpenAPI spec at GA.
        Support targets are two business days on Launch, one business day on
        Growth, and eight business hours on Scale. Mailchimp wins on phone
        support at the Premium tier, if that is a procurement requirement,
        factor it in.
      </p>
    ),
  },
];

export default function VsMailchimpPage(): JSX.Element {
  return (
    <ComparisonPage
      competitor={COMPETITOR}
      slug={SLUG}
      oneLiner="Moosewave pairs finite monthly allowances with a dry-run-first OAuth migration that preserves available consent timestamps, suppression state, supported automation logic, and archived campaigns."
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
