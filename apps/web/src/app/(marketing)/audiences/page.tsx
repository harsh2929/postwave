// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "sync email list to Meta Custom Audiences", "Google Ads
// Customer Match sync", "newsletter referral program", "audience segment
// builder", "send-time heatmap". Primary intent is the operator wiring their
// owned list into paid acquisition and growth loops.
import type { Metadata } from "next";
import Link from "next/link";

import { SectionNav } from "@/components/marketing/section-nav";

import {
  ProductShot,
  type ProductShotVariant,
} from "@/components/marketing/product-shot";
import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
} from "@/components/seo/json-ld";

const PAGE_URL = "https://moosewave.com/audiences";
const PAGE_DESCRIPTION =
  "Sync consented segments to Meta, build dynamic audience definitions, unify non-contact identifiers, and inspect historical referral stats while referral operations remain release-held.";

export const metadata: Metadata = {
  title: "Audiences: ad sync, segments, referrals | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave audiences: ad sync, segments, referrals",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/audiences/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave audiences — ad sync, segments, identity, referrals",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave audiences: ad sync, segments, referrals",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "Which ad platforms can I sync my Moosewave audiences to?",
    answer:
      "Meta Custom Audiences can receive consent-gated, hashed audience members through Moosewave's native audience destination runtime. Google Ads Customer Match has a Data Manager request-shape foundation with request-status evidence, TikTok Customer File has multipart upload plus custom-audience create/update wiring, and LinkedIn/Snap have chunked segment-user delivery foundations. Provider approvals, verification, and live account certification still gate promotion for the non-Meta paths. Each sync points at one source — a Moosewave segment or a list (exactly one). Identifiers are SHA-256-hashed and normalized (lowercased and trimmed) before they leave Moosewave, the form every Custom Audience / Customer Match API requires for PII matching.",
  },
  {
    question: "How often does an audience sync run?",
    answer:
      "Per sync you choose a cadence: manual (runs only when you hit Run), hourly, or daily. Hourly and daily syncs are picked up by a scheduler tick — an hourly sync fires once its last run is over an hour old, a daily once its last run is over 24 hours old. Each run is recorded with its status (running, succeeded, or failed), rows exported, batches sent, members excluded by the consent firewall, and an error message if it failed. One run exports up to 50,000 members in batches of 500.",
  },
  {
    question: "How do segments stay up to date?",
    answer:
      "Segments are dynamic by default. Membership is stored as a SegmentNode AST — and/or/not groups over field predicates with comparators like equals, contains, greater-than, in-last-N-days, and in-segment — that compiles to native Postgres. A live event worker recompiles affected segments within roughly a second of a subscriber event, so membership flips in ~1s rather than waiting for a batch. When you need a frozen audience for a single send, snapshot the segment to capture its members at that moment before the predicate drifts.",
  },
  {
    question: "What does the send-time heatmap actually show?",
    answer:
      "A 7×24 grid: rows are day-of-week (0–6), columns are hour-of-day (0–23), each cell colored by the fraction of opens that landed there over the last 90 days. It surfaces the best send window plus a secondary window, and flags bimodal audiences — the morning-and-lunch readers — when a second peak reaches at least 60% of the first. You can pull the heatmap per subscriber or per segment.",
  },
  {
    question: "Can each subscriber get their own referral link?",
    answer:
      "Not in this deployment. Authenticated historical program, conversion-summary, and leaderboard reads remain available, but subscriber referral links, code minting, the public redirect/widget, click attribution, reward processing, payouts, and program changes are release-held. Existing rows are inspection evidence only and do not prove a currently operating referral loop.",
  },
  {
    question: "How does Moosewave handle subscribers with multiple identifiers?",
    answer:
      "You attach non-contact aliases to a subscriber — external_id, anonymous_id, device_token, push_token, or a custom kind. Email and phone are deliberately not alias types: those are contact methods with their own verified workflows, so alias management cannot be used to attach a sending destination that never passed consent. Each alias carries a confidence score and a source, deduplicated on a lowercased value so the same identifier never splits a profile. A batch upsert reconciles up to 500 aliases across subscribers in one call, with per-item isolation so one bad row doesn't sink the batch, and it's idempotent — safe to replay.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Audiences", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Audiences",
  description: PAGE_DESCRIPTION,
  brand: { "@type": "Brand", name: "Moosewave" },
  url: PAGE_URL,
  category: "Newsletter and email marketing platform",
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: "0",
    highPrice: "349",
    offerCount: "4",
    url: "https://moosewave.com/pricing",
  },
};

interface Screenshot {
  alt: string;
  variant: ProductShotVariant;
}

interface Section {
  id: "ad-sync" | "sync-engine" | "identity" | "segments" | "referrals";
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "ad-sync",
    number: "1.0",
    eyebrow: "Ad sync",
    title: "Turn your list into paid reach.",
    subhead:
      "Sync any Moosewave segment or list to Meta Custom Audiences today, with Google Ads Data Manager, TikTok Customer File, and LinkedIn Matched Audiences foundations advancing under live certification gates. We hash before anything leaves the building.",
    bullets: [
      "Meta Custom Audiences (Facebook + Instagram) via the Marketing API Custom Audience users endpoint.",
      "Google Ads Customer Match has a Data Manager API upload-shape foundation, with diagnostics, legacy OfflineUserDataJob lifecycle, and live certification still gating promotion.",
      "LinkedIn Matched Audiences sends consented SHA-256 email identifiers through sequential 5,000-member DMP segment batches, with Audiences-program approval and live account validation still gating promotion.",
      "Snapchat Audience sends nested EMAIL_SHA256 rows through sequential 100,000-member segment-user batches, with live account validation, provider status polling, and cleanup evidence still gating promotion.",
      "TikTok Customer File uses multipart DMP upload plus custom-audience create/update calls, with live certification, quota validation, status polling, and cleanup evidence still gating promotion.",
      "Emails are SHA-256-hashed after lowercasing and trimming — the normalization every Custom Audience / Customer Match API requires for PII matching. Raw addresses never leave Moosewave.",
      "Each sync points at exactly one source: a saved segment, or a list. The members resolve from there.",
      "Access tokens are stored as credential references, never raw secrets in tenant config — a trusted resolver hydrates them only at delivery time.",
      "The activation consent firewall withholds members who haven't consented to the destination's purpose, and reports how many it excluded on every run.",
    ],
    shots: [
      {
        alt: "Audience destination picker — Meta, Google Ads, TikTok, LinkedIn, Snapchat",
        variant: "audiences",
      },
      {
        alt: "Sync configuration mapping a Moosewave segment to a Meta Custom Audience",
        variant: "audiences",
      },
      {
        alt: "Consent firewall summary showing members synced and members excluded",
        variant: "audiences",
      },
    ],
  },
  {
    id: "sync-engine",
    number: "2.0",
    eyebrow: "Sync engine",
    title: "Set the cadence. Read the ledger.",
    subhead:
      "Run a sync by hand or let the scheduler keep it warm. Every run lands in a per-destination job ledger with counts, status, and the exact reason it failed if it did.",
    bullets: [
      "Cadence per sync: manual (runs only when you hit Run), hourly, or daily. The scheduler tick claims hourly syncs once their last run is over an hour old, daily once it's over 24 hours.",
      "Each run records status — running, succeeded, or failed — plus started and finished timestamps.",
      "Counts tracked per run: rows exported, batches sent, and members excluded by the consent firewall.",
      "Failures carry an error message (truncated to a readable length) so a bad credential or a platform 4xx is legible at a glance, not a mystery.",
      "One run exports up to 50,000 members, delivered in batches of 500 rows per POST, under a hard 60-second wall-clock bound.",
      "LinkedIn segment-user requests are capped at 5,000 identifiers per provider call; larger syncs are split into sequential requests and preserve batch-count evidence.",
      "Destination secrets are write-only: reads return a masked tail and a set/unset flag, never the token.",
    ],
    shots: [
      {
        alt: "Sync job ledger listing runs with status, rows exported, and batches sent",
        variant: "audiences",
      },
      {
        alt: "Sync schedule control set to daily with last-run timestamp",
        variant: "audiences",
      },
      {
        alt: "Failed run detail showing the error message and excluded-member count",
        variant: "audiences",
      },
    ],
  },
  {
    id: "identity",
    number: "3.0",
    eyebrow: "Identity",
    title: "One person. Every identifier.",
    subhead:
      "Real subscribers show up as an email here, a device token there, an anonymous web ID before they ever signed up. Attach every alias to one profile so a sync, a segment, or a send means the same person each time.",
    bullets: [
      "Five non-contact alias kinds per subscriber: external_id, anonymous_id, device_token, push_token, and a custom kind for whatever your stack calls identity. Email and phone use separate verified contact workflows; device handoff is not Moosewave hosted SMS dispatch.",
      "Each alias carries a confidence score (0–1) and a source, so machine-matched identifiers and human-confirmed ones are distinguishable.",
      "Aliases dedupe on a lowercased value — the same identifier can't fork one person into two profiles.",
      "Batch upsert reconciles up to 500 aliases across subscribers in a single call, ideal for syncing identity in from an external system.",
      "Per-item isolation: one malformed row reports its own failure without aborting the rest of the batch.",
      "Idempotent by design — replay the same batch and you get the same state, never duplicates.",
    ],
    shots: [
      {
        alt: "Subscriber identity panel listing email, phone, device token, and anonymous ID aliases",
        variant: "audiences",
      },
      {
        alt: "Batch alias upsert result showing per-item success and failure",
        variant: "audiences",
      },
    ],
  },
  {
    id: "segments",
    number: "4.0",
    eyebrow: "Segments",
    title: "Build the audience. See the count.",
    subhead:
      "Compose a segment from real predicates, watch the count update before you save, and ship a curated set without writing SQL. The definition is an AST, not a frozen list — it recomputes as your people change.",
    bullets: [
      "Segments are a canonical SegmentNode AST: and / or / not groups over field predicates, with comparators including equals, contains, starts-with, greater-than, in-last-N-days, more-than-N-days-ago, exists, and in-segment.",
      "Live preview count returns before you save — a real count of who matches, capped by a 10-second timeout so a pathological predicate can't stall the editor.",
      "Dynamic by default: a live event worker recompiles affected segments within ~1s of a subscriber event, so membership flips almost immediately rather than at the next batch.",
      "Snapshot a dynamic segment to a static set when you need to freeze an audience for one campaign before the predicate drifts overnight.",
      "Preset segments ship ready to use: Engaged (last 30 days), Cold (no activity for 90 days), New (joined in last 7 / 30 days), Frequent clickers (3+ clicks in 90 days), Never opened, and Double opt-in verified.",
      "Tag taxonomy, usage counts, and typeahead suggestions can be reviewed. Account-wide tag rename and merge mutations are release-held and cannot rewrite subscriber memberships from this surface.",
      "Audience heat-map: a 7×24 day-of-week × hour-of-day open-rate grid over the last 90 days that surfaces a primary and secondary send window and flags bimodal readers.",
    ],
    shots: [
      {
        alt: "Segment builder with and/or/not groups and a live preview count",
        variant: "audiences",
      },
      {
        alt: "Preset segment gallery — engaged, cold, new, frequent clickers, never opened",
        variant: "audiences",
      },
      {
        alt: "7×24 hour-of-week open-rate heat-map with a recommended send time",
        variant: "audiences",
      },
    ],
  },
  {
    id: "referrals",
    number: "5.0",
    eyebrow: "Referral history",
    title: "Inspect historical referral evidence.",
    subhead:
      "Read authenticated program metadata, aggregate conversion history, and a bounded leaderboard. The public referral loop and every commercial mutation remain release-held.",
    bullets: [
      "The current stored program can be read for context, but creating or changing program terms and milestones is unavailable.",
      "Historical aggregate stats and recent credited-conversion rows can be inspected; they are not proof that signup or form completion currently credits referrals.",
      "A bounded historical leaderboard ranks already-recorded evidence without exposing a subscriber link or minting a code.",
      "Subscriber referral views, desired-code changes, public redirect routes, and the share widget are not mounted.",
      "Reward fulfillment, payout reads and exports, payout decisions, and automatic milestone processing are unavailable.",
      "Referral-cookie and attribution implementation remains dormant behind the release boundary; no public click or signup is credited by this surface.",
    ],
    shots: [
      {
        alt: "Historical referral conversion summary with the runtime hold visible",
        variant: "audiences",
      },
      {
        alt: "Historical referral leaderboard with bounded aggregate counts",
        variant: "audiences",
      },
      {
        alt: "Referral operations notice listing unavailable public and payout actions",
        variant: "audiences",
      },
    ],
  },
];

export default function AudiencesPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Your list is the audience.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Sync it to Meta Custom Audiences with readiness-gated paths for the
            other major ad networks, build segments on a real AST, unify
            non-contact identifiers, and inspect historical referral evidence.
            Referral attribution and rewards remain release-held.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 px-5 py-3 text-sm font-medium text-pw-paper shadow-[0_2px_0_0_#7A081B] transition-colors hover:bg-pw-ember-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              View pricing
            </Link>
            <Link
              href="/features"
              className="inline-flex items-center justify-center rounded-md border border-pw-line/30 px-5 py-3 text-sm font-medium text-pw-paper transition-colors hover:border-pw-line/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
            >
              See features
            </Link>
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6">
        {/* On-page section nav (MKTP-018) */}
        <div className="sticky top-14 z-30 -mx-6 border-b border-pw-ink2/10 bg-pw-paper/90 px-6 py-3 backdrop-blur">
          <SectionNav
            ariaLabel="Jump to a section"
            items={[
              { id: "ad-sync", label: "Ad sync" },
              { id: "sync-engine", label: "Sync engine" },
              { id: "identity", label: "Identity" },
              { id: "segments", label: "Segments" },
              { id: "referrals", label: "Referral history" },
            ]}
          />
        </div>
        {SECTIONS.map((s) => (
          <section
            key={s.id}
            id={s.id}
            className="py-24 md:py-32 border-b border-pw-ink2/10 scroll-mt-20"
          >
            <div className="flex items-baseline gap-3 mb-6">
              <span className="font-mono text-sm text-pw-ember-600 tabular-nums">
                {s.number}
              </span>
              <span className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
                {s.eyebrow}
              </span>
            </div>
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-pw-ink2 leading-tight max-w-3xl">
              {s.title}
            </h2>
            <p className="mt-5 text-base md:text-lg text-pw-muted-on-paper max-w-3xl leading-relaxed">
              {s.subhead}
            </p>

            <ul className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 text-sm text-pw-ink2/80">
              {s.bullets.map((b) => (
                <li key={b} className="flex gap-2 items-start">
                  <span aria-hidden className="text-pw-ember-600 leading-6">
                    ✓
                  </span>
                  <span className="leading-relaxed">{b}</span>
                </li>
              ))}
            </ul>

            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
              {s.shots.map((shot, i) => (
                <ProductShot
                  key={shot.alt}
                  alt={shot.alt}
                  variant={shot.variant}
                  view={(["trend", "list", "grid"] as const)[i % 3]}
                />
              ))}
            </div>
          </section>
        ))}

        {/* FAQ */}
        <section
          aria-labelledby="faq-heading"
          className="py-20 border-t border-pw-ink2/10"
        >
          <h2
            id="faq-heading"
            className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
          >
            Frequently asked about audiences
          </h2>
          <div className="mt-8 space-y-3">
            {FAQ.map((item) => (
              <details
                key={item.question}
                className="group rounded-lg border border-pw-ink2/10 bg-pw-paper px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-start justify-between gap-4 list-none">
                  <h3 className="text-sm font-medium text-pw-ink2">
                    {item.question}
                  </h3>
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

        {/* Closer CTA */}
        <section className="text-center border-t border-pw-ink2/10 py-20">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Put your list to work.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Review segment, ad-account sync, and referral workflows in the
            release catalog. Provider-backed activation remains unavailable
            until live certification and explicit release approval.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              View pricing →
            </Link>
            <Link
              href="/features"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              See all features
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
