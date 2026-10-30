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

const COMPETITOR = "Beehiiv";
const SLUG = "beehiiv";
const PAGE_URL = `${publicSiteOrigin()}/vs/${SLUG}`;

const DESCRIPTION =
  "Compare Moosewave and Beehiiv on finite monthly plans, voice-trained AI sequences, inbox-placement evidence, and dry-run-first migration boundaries.";

export const metadata: Metadata = {
  title: "Moosewave vs Beehiiv for newsletter operations",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave vs Beehiiv",
    description: DESCRIPTION,
    siteName: "Moosewave",
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave vs Beehiiv",
    description: DESCRIPTION,
    creator: "@moosewave",
  },
};

const ROWS: ComparisonRow[] = [
  {
    dimension: "Pricing model",
    moosewave: "$39 / $99 / $349 monthly with finite plan allowances",
    competitor:
      "Subscription tiered by subscriber count (Launch / Scale / Max)",
  },
  {
    dimension: "Billing model",
    moosewave:
      "Monthly subscription with hard plan allowances and no automatic overages",
    competitor: "Monthly subscription that escalates with list growth",
  },
  {
    dimension: "Subscribers as billing unit",
    moosewave: "No",
    competitor: "Yes, every active subscriber bills",
  },
  {
    dimension: "Included emails / month",
    moosewave: "25K / 100K / 500K accepted recipients per month",
    competitor: "Unlimited within tier sub-cap",
  },
  {
    dimension: "List size limit",
    moosewave: "2,500 / 10,000 / 50,000 active emailable profiles",
    competitor: "Tier-capped; Max required above 100K",
  },
  {
    dimension: "Send-time deliverability transparency",
    moosewave: "Controlled-inbox placement + AI Diagnostician",
    competitor: "Aggregate metrics; no per-send placement matrix",
  },
  {
    dimension: "AI features",
    moosewave: "Voice-trained sequences + AI Diagnostician for deliverability",
    competitor: "AI writing assist (subject + body)",
  },
  {
    dimension: "Voice cloning",
    moosewave: "Yes, ingests last 20 newsletters + RSS + transcripts",
    competitor: "No, generic LLM prompts",
  },
  {
    dimension: "Migration in",
    moosewave:
      "API import: subscribers + eligible sent posts; segment snapshots, automation rebuild evidence, and premium metadata",
    competitor: "Limited inbound tooling",
  },
  {
    dimension: "Migration out",
    moosewave:
      "Exports Moosewave-owned subscriber/archive data; preserved Beehiiv definitions remain rebuild evidence",
    competitor: "CSV of subs; archives as HTML; ad-network tied to platform",
  },
  {
    dimension: "Automations",
    moosewave:
      "Typed flow authoring; execution held; Beehiiv automations require manual rebuild",
    competitor: "Visual journey builder",
  },
  {
    dimension: "Paid subscriptions",
    moosewave:
      "Stripe is a separate Moosewave capability; Beehiiv billing objects are not migrated",
    competitor: "Native. Beehiiv keeps a platform fee + Stripe fees",
  },
  {
    dimension: "A/B testing",
    moosewave: "Subject + content on every tier; multivariate planned V2",
    competitor: "Subject and send-time",
  },
  {
    dimension: "Segments",
    moosewave:
      "Postgres DSL; Beehiiv import freezes completed membership tags and requires predicate rebuild",
    competitor: "Visual segment builder; tier-gated",
  },
  {
    dimension: "API maturity",
    moosewave:
      "Moosewave product REST/webhooks; Beehiiv migration currently uses a final full delta, not a live bridge",
    competitor: "REST API on Scale+ tiers",
  },
  {
    dimension: "Support",
    moosewave: "2 business days on Launch; 1 day on Growth; 8 hours on Scale",
    competitor: "Email; priority on Max",
  },
  {
    dimension: "MCP / agent support",
    moosewave: "Release held · source candidate only",
    competitor: "Community-built only",
  },
];

const SCENARIOS: WhenScenario[] = [
  {
    title: "You earn meaningful revenue from the Beehiiv ad network",
    body: "Beehiiv’s Boosts and Ad Network are tightly integrated and have generated real revenue for some publications. If your monthly ad-network revenue exceeds the Moosewave savings, that’s a real switching cost. We do not run an ad network.",
  },
  {
    title: "You depend on Beehiiv recommendations for growth",
    body: "Beehiiv’s recommendation network drives signups for some publications. If recommendations are a top-three growth channel, that traffic does not transfer.",
  },
  {
    title: "You need a website builder with a forever-free tier",
    body: "Beehiiv’s built-in website + Boosts marketplace + free starter tier work well for early-stage writers who haven’t monetized. Moosewave is built for the writer who has already crossed that threshold and is bumping into Beehiiv’s subscription tier ceilings.",
  },
];

const MIGRATION_STEPS = [
  "Generate a Beehiiv API key. Moosewave validates its workspace; provide the `pub_...` ID explicitly when the key can access multiple publications because there is no chooser yet.",
  "Run a dry run for cursor-paginated subscribers, custom fields, newsletter-list memberships, completed segment snapshots, eligible sent posts, and available source evidence.",
  "Review unknown-consent provenance, automation rebuild evidence, archive classification, premium metadata, and optional-endpoint warnings. No Stripe billing objects move.",
  "Confirm the import; Moosewave executes idempotently with a 7-day rollback window.",
  "Freeze relevant Beehiiv edits and run a final full delta. There is no live webhook bridge; the completed traversal disables same-job subscriber source IDs now missing from Beehiiv.",
  "Authenticate your sending domain via the in-product DNS wizard.",
  "When controlled testing is enabled, run an Inbox Reality test send and review the observations returned by the active seed roster before you cut over the audience.",
  "Treat the Beehiiv integration as live-certification pending until workspace scope, rate limits, final-delta behavior, and rollback are exercised against the real publication.",
];

const DETAILS: DimensionDetail[] = [
  {
    heading: "1. Subscription tiers and allowance boundaries",
    body: (
      <>
        <p>
          Beehiiv tiers (Launch / Scale / Max) ladder by subscriber count. The
          bill grows with your list whether you send daily, weekly, or monthly.
          Moosewave publishes finite monthly allowances at $39, $99, and $349.
          Profile, sending, seat, automation, AI, and reporting limits are
          explicit and stop at the applicable cap.
        </p>
        <p>
          Compare the current plans against your actual profile count, send
          volume, and required workflows. Moosewave does not promise that one
          plan is universally cheaper than another provider.
        </p>
      </>
    ),
  },
  {
    heading: "2. Inbox placement transparency",
    body: (
      <p>
        Beehiiv reports opens, clicks, and unsubscribes. It does not show you
        per-send placement (Primary vs Promotions vs Spam). When controlled
        testing is enabled, Moosewave tests against the configured active seed
        roster and identifies the providers that actually returned an
        observation. The AI Diagnostician translates those results into ranked,
        actionable fixes (DNS records, content changes, list hygiene actions).
      </p>
    ),
  },
  {
    heading: "3. AI, voice cloning vs writing assist",
    body: (
      <p>
        Beehiiv’s AI is competent writing assist, subject lines, body
        suggestions, image generation. It does not learn your voice. Moosewave’s
        Voice AI builds a stylistic fingerprint from your existing newsletter
        archive, including eligible past sent email/both posts imported from
        Beehiiv, plus optional RSS, podcast transcripts, and socials, and
        generates sequences with a fidelity score that triggers regeneration
        below 60.
      </p>
    ),
  },
  {
    heading: "4. Migration, what actually moves",
    body: (
      <p>
        Moosewave validates the API key against its Beehiiv workspace and binds
        one publication. It cursor-paginates subscribers with custom fields,
        newsletter-list memberships, stable source IDs, and premium metadata;
        Beehiiv timestamps do not become portable consent proof. Completed
        segment memberships become frozen tag-backed snapshots, while predicates
        and dynamic behavior require rebuild. Automation metadata, email
        inventory, and statistics become rebuild-review evidence and are never
        activated. Only past sent email/both posts become campaign archive;
        drafts, scheduled posts, and web-only posts remain source evidence.
      </p>
    ),
  },
  {
    heading: "5. Premium membership is not billing continuity",
    body: (
      <p>
        Beehiiv supports paid subscriptions natively and takes a platform fee.
        The migration preserves premium tier and membership metadata, but it
        does not move Stripe customers, products, prices, subscriptions,
        renewals, or tenant-bound billing ownership. Moosewave’s separate Stripe
        capabilities do not make Beehiiv billing continuity automatic; plan and
        verify that handoff independently.
      </p>
    ),
  },
  {
    heading: "6. The ad network gap",
    body: (
      <p>
        Beehiiv’s Boosts and Ad Network can generate real revenue for
        publications with the right audience. Moosewave does not run an ad
        network. If meaningful monthly ad-network revenue is part of your
        P&amp;L, factor it into the switching decision honestly.
      </p>
    ),
  },
  {
    heading: "7. Automations, segments, A/B, API",
    body: (
      <p>
        Beehiiv ships an operational visual journey builder; Moosewave ships
        typed flow authoring and validation while activation, enrollment,
        scheduling, execution, and delivery remain held. Beehiiv automation
        metadata, emails, and statistics are useful rebuild evidence, but API v2
        does not expose the executable graph or message bodies, so no journey
        migrates as active runtime. Completed segment membership can be frozen
        as a tag-backed snapshot; the source predicates and future dynamic
        behavior must be rebuilt. The Beehiiv migration also has no live webhook
        bridge yet, so cutover uses a reviewed final full delta and remains
        live-certification pending.
      </p>
    ),
  },
];

export default function VsBeehiivPage(): JSX.Element {
  return (
    <ComparisonPage
      competitor={COMPETITOR}
      slug={SLUG}
      oneLiner="Moosewave is for teams that want voice-trained AI sequences, explicit migration evidence, and controlled-inbox placement reporting within finite monthly allowances."
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
