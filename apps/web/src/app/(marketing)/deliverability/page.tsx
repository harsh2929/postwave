// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "email deliverability testing", "inbox placement test",
// "seedlist inbox testing", "email reputation monitoring", "DMARC monitoring",
// "domain warmup". Primary intent is the operator who keeps landing in spam and
// wants to see exactly where their mail goes and what to fix.
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

const PAGE_URL = "https://moosewave.com/deliverability";
const PAGE_DESCRIPTION =
  "See controlled inbox observations, diagnostics, authentication evidence, warmup recommendations, and computed send-time guidance with operational holds stated explicitly.";

export const metadata: Metadata = {
  title: "Deliverability: seedlist, AI Diagnostician, warmup | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave deliverability: see where your email landed",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/deliverability/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave deliverability overview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave deliverability: see where your email landed",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "How does Moosewave measure where my email actually lands?",
    answer:
      "When controlled inbox testing is enabled, Moosewave sends to the deployment's configured active seed roster. The poller checks each responding mailbox and categorizes the message as Primary, Promotions, Updates, or Spam. The report identifies exactly which controlled observations completed, so unavailable or missing providers are never presented as evidence.",
  },
  {
    question: "What does the AI Diagnostician do that a spam checker doesn't?",
    answer:
      "A spam checker scores text against a wordlist. The Diagnostician looks at all four layers — seedlist placement, sender reputation, authentication, and content — and a Gemini Pro model, prompted with a fixed rubric plus worked examples, returns a ranked list of plain-English fixes. Each fix carries a severity, the evidence behind it, and a predicted impact. A post-response validator re-checks hard constraints on every diagnosis and issues a single targeted retry if they fail, and the whole prompt pack is gated by a checked eval corpus before release. Results are cached for 24 hours by fingerprint.",
  },
  {
    question: "Can I check placement before I hit send?",
    answer:
      "Yes. The Pre-Send Predictor takes a subject line and raw HTML and returns a predicted placement — Primary, Promotions, or Spam — from a weighted blend of content, reputation, authentication, and engagement signals. The base prediction runs with no LLM call. When you enable it, Gemini Flash adds an optional second opinion. You see the risk and which model produced the answer, so you can fix a draft before a single subscriber sees it.",
  },
  {
    question:
      "How do I move to my own sending domain, and is it monitored after?",
    answer:
      "Sending identities for SPF, DKIM, and DMARC are separate from customer hostnames used by forms, redirects, archives, or tracking. The custom-host registry is currently read-only: registration, DNS re-check, removal, automated TLS, and production routing are release-held. DNS health monitoring and warmup apply to qualified sending identities and must not be read as customer-host activation.",
  },
  {
    question: "What protects my reputation between sends?",
    answer:
      "Soft-bounce recovery, spam-trap classification, bot-open filtering, and blocklist evidence protect qualified email paths. Frequency-cap policy records can also be inspected and configured for supported scopes, but this release does not claim universal enforcement across every channel, message type, or dispatch path.",
  },
  {
    question: "Does Moosewave send each subscriber at their best time?",
    answer:
      "Moosewave can compute a best hour-of-week (0–167, weighting clicks and replies more than opens) and aggregate that evidence per segment. Those values are recommendations only in this release: campaign scheduling, per-recipient dispatch, modal-hour release, and recipient-timezone delivery are release-held, so no subscriber fires from this surface.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Deliverability", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Deliverability",
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
  id: string;
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "seedlist",
    number: "1.0",
    eyebrow: "Inbox Reality",
    title: "Stop guessing. See where you landed.",
    subhead:
      "When enabled, controlled inbox testing uses the deployment's active seed roster. Each responding mailbox is polled and bucketed by folder, so you get an observation-backed placement matrix rather than an assumed fleet size.",
    bullets: [
      "The active seed roster is deployment configuration; each report names the controlled mailboxes and providers that actually produced observations.",
      "The poller categorizes each completed delivery as Primary / Promotions / Updates / Spam and exposes missing observations instead of filling them in.",
      "The seedlist is a configurable registry, so the provider mix tracks where your audience actually reads.",
      "Per-campaign Inbox Reality report: per-inbox placement across the seedlist, plus opens and clicks per provider.",
      "Cross-client rendering across Gmail web and mobile, Outlook desktop and web, Apple Mail, and Yahoo — one preview URL per environment.",
      "Render raw HTML through the same pipeline without saving a campaign, so you can iterate on a draft before any campaign object exists.",
    ],
    shots: [
      {
        alt: "Inbox Reality dashboard — observed seedlist placement with primary, promotions, and spam breakdown",
        variant: "deliverability",
      },
      {
        alt: "Per-provider opens and clicks for a sent campaign across the seedlist",
        variant: "deliverability",
      },
      {
        alt: "Cross-client render preview across Gmail, Outlook, Apple Mail, and Yahoo",
        variant: "inbox",
      },
    ],
  },
  {
    id: "diagnostician",
    number: "2.0",
    eyebrow: "AI Diagnostician",
    title: "Plain-English fixes, ranked by impact.",
    subhead:
      "Placement tells you what happened. The Diagnostician tells you why, and what to change — a Gemini Pro model prompted with a fixed rubric, validated against hard constraints, and gated by a checked eval suite. There's a predictor too, so you can check a draft before you ship it.",
    bullets: [
      "AI Diagnostician. Gemini Pro, prompted with a rubric plus worked examples, reads seedlist placement, reputation, auth, and content and returns a ranked list of plain-English fixes.",
      "Each fix carries a severity, the evidence behind it, and a predicted impact. A post-response validator re-checks the diagnosis and issues a single targeted retry if constraints fail.",
      "The production prompt pack and a checked eval corpus are required at deploy — the eval suite is the release gate. Diagnoses are cached for 24 hours by fingerprint.",
      "Pre-Send Predictor: paste subject + HTML, get predicted placement (Primary / Promotions / Spam) from a weighted blend of content, reputation, auth, and engagement signals.",
      "The base prediction runs with no LLM call; an optional Gemini Flash second opinion can be enabled when you want it, with the model and risk disclosed in the response.",
      "Content analysis underneath: spam-trigger scoring over weighted trigger words plus structural features (caps ratio, image-to-text ratio, link density, subject length), per-domain link reputation, and HTML quality (missing alt, mismatched tags, hidden text, inline-CSS heaviness).",
    ],
    shots: [
      {
        alt: "AI Diagnostician explaining a Promotions placement with a ranked list of fixes and predicted impact",
        variant: "deliverability",
      },
      {
        alt: "Pre-send predictor showing predicted placement and risk for a draft campaign",
        variant: "inbox",
      },
      {
        alt: "Content analysis breakdown — spam triggers, image-to-text ratio, and HTML quality",
        variant: "deliverability",
      },
    ],
  },
  {
    id: "reputation",
    number: "3.0",
    eyebrow: "Reputation + auth",
    title: "Review reputation and authentication evidence.",
    subhead:
      "Inspect available reputation, DNSBL, and authentication results. Continuous DMARC mailbox ingestion and customer-host DNS mutation are not represented as live services in this release.",
    bullets: [
      "Reputation monitoring across Google Postmaster Tools, Microsoft SNDS, and Validity SenderScore, plus live DNSBL probes; provider sources activate when their credentials are present and merge concurrently.",
      "Blocklist monitoring across major DNSBLs including Spamhaus (zen + dbl), SpamCop, Barracuda, SORBS, PSBL, CBL, and more — a curated catalog kept short so obscure lists don't cause false positives.",
      "Authentication validation: SPF, DKIM, DMARC, BIMI, and PTR, each with a pass/fail and a remediation hint when failing.",
      "Stored DMARC aggregate evidence can show per-source alignment when qualified report data exists. Continuous RUA IMAP ingestion is release-held and is not promised by this dashboard.",
      "Policy-readiness suggestions from your own data — e.g. flagging when alignment is high enough to move from p=none toward quarantine or reject.",
      "Remediation guidance identifies deterministic issues such as a missing DMARC record or a mismatched sender identity; customer-host registration, DNS changes, TLS issuance, and routing remain release-held.",
    ],
    shots: [
      {
        alt: "Reputation snapshot with SenderScore, Postmaster signals, and blocklist status",
        variant: "deliverability",
      },
      {
        alt: "Authentication panel showing SPF, DKIM, DMARC, BIMI, and PTR with pass/fail and remediation",
        variant: "deliverability",
      },
      {
        alt: "DMARC aggregate report insights — per-source alignment and top failing senders",
        variant: "inbox",
      },
    ],
  },
  {
    id: "domains",
    number: "4.0",
    eyebrow: "Domains + warmup",
    title: "Review sender identity health and warmup guidance.",
    subhead:
      "Sending-identity evidence and warmup recommendations are distinct from the legacy customer-host registry. Customer-host registration, verification mutation, automated TLS, and production routing are release-held.",
    bullets: [
      "The legacy customer-host registry can retain expected CNAME and TXT verification evidence for review; it does not provision a form, redirect, archive, or tracking hostname.",
      "Customer-host registration, on-demand DNS re-check, verification-state mutation, removal, automated TLS, and production routing are unavailable in this release.",
      "Available SPF, DKIM, and DMARC observations are surfaced per sending identity as last-known evidence, not as a promise of continuous monitoring or customer-host activation.",
      "An issues view that shows only the identities that need attention, plus remediation guidance for each broken record.",
      "Domain warmup ramps your send volume on a gradual schedule from a small day-one quota toward your target, with a configurable duration and a live today's-quota status.",
      "Dedicated-IP provisioning and assignment are release-held. Any retained IP-warmup rows are planning evidence and do not establish an active dedicated sending path.",
    ],
    shots: [
      {
        alt: "Custom domain setup showing the CNAME and verification TXT records to publish",
        variant: "deliverability",
      },
      {
        alt: "DNS health dashboard with SPF, DKIM, and DMARC status per sending identity",
        variant: "developers",
      },
      {
        alt: "Domain warmup schedule showing the daily send-volume ramp toward target",
        variant: "deliverability",
      },
    ],
  },
  {
    id: "protective-layer",
    number: "5.0",
    eyebrow: "Protective layer",
    title: "A standing guard between your sends.",
    subhead:
      "Reputation is earned per send and lost between them. A background layer recovers soft bounces, traps spam traps, caps frequency, filters bot opens, and watches the blocklists — so a bad list doesn't quietly cost you the inbox.",
    bullets: [
      "Soft-bounce recovery re-enables subscribers whose most recent soft bounce has aged past the recovery window with no new bounces since; the window is configurable per sweep.",
      "Spam-trap guard classifies trap hits at bounce-ingest, flips those subscribers to blocklisted so the dispatcher excludes them from every send, and can write a canonical suppression record for the audit trail.",
      "Frequency-cap policy records can be scoped by channel and message type. Email enforcement is the active send use; an SMS policy row does not override the current hosted SMS dispatch holds.",
      "Bot-open filtering classifies machine opens by user-agent signature across five kinds: Apple Mail Privacy Protection, image proxies, security scanners, link prefetchers, and your own custom rules — so automated opens don't inflate engagement.",
      "Blocklist monitoring watches your dedicated IPs and verified domains across the DNSBL catalog and auto-suppresses on a high-confidence, multi-zone listing, logging the reason for every suppression.",
    ],
    shots: [
      {
        alt: "Protective layer dashboard showing soft-bounce recovery and spam-trap suppression activity",
        variant: "deliverability",
      },
      {
        alt: "Frequency caps configured per channel and message type with a per-window limit",
        variant: "automations",
      },
      {
        alt: "Bot-open filtering breakdown by signature kind — MPP, proxy, scanner, prefetcher",
        variant: "analytics",
      },
    ],
  },
  {
    id: "send-time",
    number: "6.0",
    eyebrow: "Send-time optimization",
    title: "Compute when readers have historically engaged.",
    subhead:
      "Moosewave derives subscriber and segment timing recommendations from historical engagement. Campaign scheduling and every per-recipient or timezone-based dispatch strategy remain release-held.",
    bullets: [
      "Per-subscriber best hour-of-week (0–167, Sunday 00:00 UTC = 0) computed from engagement history, weighted so clicks and replies count more heavily than opens.",
      "Per-segment best time aggregated from those subscriber-level hours, with a minimum-data threshold so a thin segment doesn't return a noisy answer.",
      "Per-recipient and modal-hour strategies can be represented as planning choices, but neither schedules or dispatches a campaign in this release.",
      "Fallback values can make a recommendation complete for sparse histories; they do not release a send.",
      "A background worker recomputes best times on a schedule and refreshes stale rows, so the optimal hour tracks behavior as it changes.",
    ],
    shots: [
      {
        alt: "Send-time optimization heatmap showing engagement by day-of-week and hour",
        variant: "analytics",
      },
      {
        alt: "Per-segment best send time with day-of-week and hour recommendation",
        variant: "deliverability",
      },
      {
        alt: "Release-hold notice for per-recipient campaign scheduling",
        variant: "automations",
      },
    ],
  },
];

export default function DeliverabilityPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            See which inbox you landed in.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Controlled-inbox placement, an AI Diagnostician, reputation and
            authentication evidence, warmup guidance, and computed send-time
            recommendations. The report identifies the active seed observations
            it actually used, and operational holds remain explicit.
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
              { id: "seedlist", label: "Inbox Reality" },
              { id: "diagnostician", label: "Diagnostician" },
              { id: "reputation", label: "Reputation" },
              { id: "domains", label: "Domains" },
              { id: "protective-layer", label: "Protective" },
              { id: "send-time", label: "Send-time" },
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
            Frequently asked about deliverability
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
            Run your next send through the seedlist.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Run a controlled test against the active seed roster, inspect the
            observed placement matrix, and let the Diagnostician rank your
            fixes. Then pick a plan that fits your list.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/migrations"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              Start with a migration →
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
