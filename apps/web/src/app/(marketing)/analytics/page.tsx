// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "newsletter analytics", "email campaign reporting",
// "per-link click report", "email goals and pacing", "subscriber lifecycle export".
// Primary intent is the operator evaluating whether Moosewave's reporting answers
// the questions they actually ask after a send.
import type { Metadata } from "next";
import Link from "next/link";

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

const PAGE_URL = "https://moosewave.com/analytics";
const PAGE_DESCRIPTION =
  "Rolling 24h / 7d / 30d stats, per-link click reports, bounce breakdowns, side-by-side campaign comparison, goals with live pacing, and subscriber lifecycle CSV exports.";

export const metadata: Metadata = {
  title: "Analytics: stats, reports, goals, exports | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave analytics: stats, deep reporting, goals, exports",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/analytics/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave analytics overview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave analytics: stats, deep reporting, goals, exports",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "What does the analytics dashboard show out of the box?",
    answer:
      "A tenant-wide rolling stat block over a 24-hour, 7-day, or 30-day window: total sends, delivered, opens, clicks, unsubscribes, plus the computed open rate and click rate. It's the first thing you see — the answer to 'how are things going right now?' — before you drill into any single campaign.",
  },
  {
    question: "Can I see which links in a campaign got clicked?",
    answer:
      "Yes. The per-link click report lists every clicked URL in a campaign with its total clicks and its distinct unique clickers, sorted most-clicked first. CTR is computed per link as unique clickers divided by the campaign's total recipients, so you can tell a link that 40 people each clicked five times from a link that 200 different people clicked once.",
  },
  {
    question: "How are bounces categorised?",
    answer:
      "Each bounce is mapped to one of three buckets: hard (5xx SMTP codes), soft (4xx codes), and spam_trap (any bounce classification containing 'trap'). The bounce report returns those three counts plus the total for a campaign, so you can separate a list-hygiene problem from a transient deferral.",
  },
  {
    question: "Can I compare campaigns against each other?",
    answer:
      "Yes — up to 25 campaigns side by side in one call. For each campaign you get total recipients and the open, click, bounce, complaint, and unsubscribe rates, computed against the recipient count. Rows follow the order you requested, so a before/after or A/B read lines up the way you set it up.",
  },
  {
    question: "Can I set targets and have the dashboard track them?",
    answer:
      "Yes. Set a goal on subscriber count, open rate, revenue, or list growth, on a monthly or quarterly cadence. The dashboard computes current progress live from existing aggregates — never a denormalised snapshot — and shows pace as ahead, on_track, or behind by comparing your progress fraction against how much of the period has elapsed, with a ±5-point tolerance band so a goal isn't flagged 'behind' for being one day light.",
  },
  {
    question: "Can I export raw per-subscriber data?",
    answer:
      "Yes. The per-subscriber lifecycle CSV gives one row per recipient with their sent / delivered / opened / clicked / bounced / complained / unsubscribed status for a campaign. Exports over roughly 10 MiB come back with a truncated flag and a row count so you can re-request with offset and limit to paginate the rest. Cohort matrices and scheduled email digests round out the export surface.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Analytics", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Analytics",
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
  id: "stats" | "reporting" | "goals" | "exports";
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "stats",
    number: "1.0",
    eyebrow: "Campaign analytics",
    title: "The numbers, the moment you ask.",
    subhead:
      "A tenant-wide rolling stat block answers 'how are things going?' in one call, then every campaign drops into a device and geography breakdown so you know who opened and where.",
    bullets: [
      "Rolling tenant-wide stats over a 24h / 7d / 30d window: total sends, delivered, opens, clicks, unsubscribes, plus computed open rate and click rate.",
      "Period-over-period comparison: the dashboard window carries a previous block (one window of the same length, immediately before) so 'up or down?' is answered without exporting.",
      "Per-campaign device breakdown: opens and clicks bucketed by mail-client family — Gmail, Outlook, Apple Mail (mobile opens fold in here), Yahoo, and Other — parsed from the engagement User-Agent, most-active first.",
      "Per-campaign geography: opens and clicks by country, derived from the IP recorded at engagement time; rows without a resolved country bucket into 'unknown' rather than being dropped.",
      "Open rate is unique opens over delivered, falling back to sends when a legacy path emitted no 'delivered' rows — the same math the goals pacing engine reuses, so the two surfaces never disagree.",
      "Stats read on the read-reports scope, so a dashboard-only API key can pull them without admin rights.",
    ],
    shots: [
      {
        alt: "Rolling stats dashboard with 24h / 7d / 30d toggle showing sends, delivered, opens, clicks, and unsubscribes",
        variant: "analytics",
      },
      {
        alt: "Per-campaign device breakdown of opens and clicks across Gmail, Outlook, Apple Mail, and Yahoo",
        variant: "analytics",
      },
      {
        alt: "Per-campaign geography map with per-country open and click totals",
        variant: "analytics",
      },
    ],
  },
  {
    id: "reporting",
    number: "2.0",
    eyebrow: "Deep reporting",
    title: "Past the summary. Into the campaign.",
    subhead:
      "When the top-line stats raise a question, the deep reports answer it: which link drove the clicks, what kind of bounces you took, and how this send stacks against the last five.",
    bullets: [
      "Per-link click report: every clicked URL in a campaign with its total clicks and its distinct unique clickers, sorted most-clicked first.",
      "Per-link CTR is unique clickers ÷ total recipients, so repeat clicks from one reader don't inflate the rate — you see true reach per link.",
      "Bounce breakdown into hard (5xx), soft (4xx), and spam_trap ('trap' in the bounce type), returned as three counts plus the total — list-hygiene problems separate cleanly from transient deferrals.",
      "Campaign comparison: up to 25 campaigns side by side in one call.",
      "Each compared campaign returns total recipients with open, click, bounce, complaint, and unsubscribe rates, all computed against the recipient count.",
      "Comparison rows follow the requested id order, so a before/after or A/B read lines up exactly the way you arranged it.",
      "Revenue can be attributed per campaign over a 7-day lookback — a paid signup or upgrade ties to the most recent campaign the subscriber clicked within the window.",
    ],
    shots: [
      {
        alt: "Per-link click report listing each URL with total clicks, unique clickers, and CTR",
        variant: "analytics",
      },
      {
        alt: "Bounce breakdown showing hard, soft, and spam-trap counts for a campaign",
        variant: "analytics",
      },
      {
        alt: "Side-by-side campaign comparison table with open, click, bounce, complaint, and unsub rates",
        variant: "analytics",
      },
    ],
  },
  {
    id: "goals",
    number: "3.0",
    eyebrow: "Goals & pacing",
    title: "Set the target. Watch the pace.",
    subhead:
      "Pick a metric, set a number, choose a cadence. The dashboard computes progress live from the aggregates you already have and tells you whether you're ahead, on track, or behind — no separate reporting job.",
    bullets: [
      "Target any of four metrics: subscriber count, open rate, revenue, or list growth (net new subscribers this period).",
      "Monthly or quarterly cadence; the active period is the window anchored at the goal's start date that contains today, advancing by calendar months.",
      "Progress is never denormalised — every read recomputes the current value from existing aggregates: enabled-subscriber count, the open-rate ledger, the conversions revenue ledger, or new-signup count for the window.",
      "Pace is ahead, on_track, or behind: your progress fraction is compared against how much of the period has elapsed, with a ±5-point tolerance band so a goal one day light isn't flagged 'behind'.",
      "Revenue goals are mixed-currency safe: the period's dominant currency is resolved first and only that currency's rows are summed, so a USD+EUR tenant never sees a meaningless cross-currency total.",
      "Goals read on the read-reports scope; creating, editing, and deleting them requires admin — the dashboard chip is visible to viewers, the target is owned by admins.",
    ],
    shots: [
      {
        alt: "Goals panel showing subscriber, open-rate, and revenue targets with live progress bars",
        variant: "analytics",
      },
      {
        alt: "Goal pacing chip reading 'ahead' against the elapsed-period expectation",
        variant: "analytics",
      },
      {
        alt: "Goal editor selecting metric, target, and monthly or quarterly cadence",
        variant: "analytics",
      },
    ],
  },
  {
    id: "exports",
    number: "4.0",
    eyebrow: "Exports & cohorts",
    title: "Your data, out of the building.",
    subhead:
      "When you need the rows, not the chart: a per-subscriber lifecycle CSV, cohort matrices grouped by signup month, and recurring digests that land in the right inboxes on schedule.",
    bullets: [
      "Per-subscriber lifecycle CSV: one row per recipient with their sent / delivered / opened / clicked / bounced / complained / unsubscribed status for a campaign.",
      "Large exports return a truncated flag with the byte size and row count, so you re-request with offset and limit to page the rest — nothing is silently cut.",
      "CSV cells starting with =, +, -, or @ are prefixed with a quote to neutralise spreadsheet formula injection on open.",
      "Analytics cohorts: subscribers grouped by signup month for the trailing 12 cohorts, with open rate, click rate, or retention over the first N weeks since signup (default 12, up to 26).",
      "Scheduled report digests: recurring emails on a weekly (by day-of-week) or monthly (by day-of-month) schedule, sent to a recipient list you define.",
      "Three digest templates — engagement summary, deliverability, and growth — with a send-now button to preview the exact email body before you turn the schedule on.",
    ],
    shots: [
      {
        alt: "Per-subscriber lifecycle CSV export with sent, delivered, opened, clicked, bounced, complained, and unsubscribed columns",
        variant: "analytics",
      },
      {
        alt: "Cohort matrix of signup-month cohorts with open-rate retention over weeks since signup",
        variant: "analytics",
      },
      {
        alt: "Scheduled report editor choosing a digest template, weekly schedule, and recipient list",
        variant: "analytics",
      },
    ],
  },
];

export default function AnalyticsPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Reporting that answers the next question.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Rolling stats, per-link click reports, side-by-side comparison,
            goals with live pacing, and the raw rows when you need them. Built
            on the aggregates the engine already keeps.
          </p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6">
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
            Frequently asked about analytics
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
            Set a goal. Watch it pace.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Pick a target, choose monthly or quarterly, and let the dashboard
            tell you whether you’re ahead or behind — computed live from the
            data you already have.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/analytics#goals"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              See goals &amp; pacing →
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              View pricing
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
