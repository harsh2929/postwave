// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "hosted signup forms", "embeddable newsletter form",
// "double opt-in form builder", "newsletter signup form". Primary intent is an
// operator deciding whether Moosewave can capture consented signups anywhere
// without a second tool (Typeform + Mailchimp). Landing pages live at
// /landing-pages.
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
import { MCP_RELEASE_HOLD_CODE } from "@/lib/mcp-release-status";

const PAGE_URL = "https://moosewave.com/forms";
const PAGE_DESCRIPTION =
  "Hosted and embeddable signup forms with multi-step flows, double opt-in, custom fields, and per-form conversion metrics. Five embed flavors, consent proof captured automatically.";

export const metadata: Metadata = {
  title: "Signup forms | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave signup forms",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/forms/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave signup forms",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave signup forms",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "Are the forms hosted, or do I embed them on my own site?",
    answer:
      "Both. Every form gets a hosted URL you can link to directly, and a server-generated embed snippet for your own site. There are five snippet flavors: a universal async script (Webflow Embed, Framer Code, raw HTML), a sandboxed iframe for hosts whose CSP forbids inline JS, a plain-hooks React component, a WordPress shortcode, and a raw inline <form> for static-site generators like Hugo and Jekyll. The host and public URL are baked into the snippet server-side, so there is no client-side configuration to get wrong.",
  },
  {
    question: "Does Moosewave support double opt-in?",
    answer:
      "Yes, as a per-form toggle. Each form carries an opt-in mode of single or double. On single opt-in the subscriber is enabled immediately. On double opt-in the subscriber is stored disabled with a confirmation token and isn't activated until they click the link. The REST API can confirm a pending submission programmatically by token. Submissions also record IP and user-agent into a consent-events record, so your double-opt-in proof is captured automatically.",
  },
  {
    question: "What conversion data do I get per form?",
    answer:
      "Each form reports a rolling 30-day window: visits, submissions, and a conversion rate. Visits come from daily form-visit counters; submissions count everything submitted in the last 30 days; the conversion rate is submissions divided by visits over the same window, expressed as a 0–100 percentage. Every individual submission stores its timestamp, IP, user-agent, custom field values, and any UTM parameters captured at submit time.",
  },
  {
    question: "Can I A/B test a form?",
    answer:
      "Not on live traffic in this deployment. The dashboard can store variant definitions for planning, but hosted and embedded forms serve the base form and do not attribute impressions or submissions to variants. No traffic reweighting, winner evaluation, or automatic promotion runs. Embed mode can be iframe, inline, or popup, and for a popup a trigger of page-load, 50% scroll, exit-intent, or time-delay.",
  },
  {
    question: "Does Moosewave build landing pages, or just forms?",
    answer:
      "Hosted and embedded forms are the live capture surface today. Landing-page records can be created and organized in the dashboard, but the block editor, custom domains, SEO controls, and page metrics are still staged. Use a hosted form when you need production signups now, and use landing pages to reserve and plan future standalone pages.",
  },
  {
    question: "Can I manage forms from the API or an agent?",
    answer: `The typed REST API is the documented integration boundary. The repository MCP catalogue contains form adapter candidates, but ${MCP_RELEASE_HOLD_CODE} means they are not a published, hosted, or callable availability promise.`,
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Forms", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Signup forms",
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
    id: "forms",
    number: "1.0",
    eyebrow: "Forms",
    title: "Capture signups anywhere. Keep the consent proof.",
    subhead:
      "Hosted and embeddable forms with multi-step flows, double opt-in, custom fields, and a rolling 30-day conversion read on every form — so you know what's actually converting, not just what's live.",
    bullets: [
      "Multi-step forms: each form is a list of steps, and each step carries its own ordered fields with type, label, required flag, and select options.",
      "Drag to reorder fields in the builder — native HTML5 drag-and-drop, the same interaction as the sequence builder.",
      "Double opt-in as a per-form toggle (single or double). Double-opt-in subscribers are stored disabled with a confirmation token and only activated on click.",
      "Custom fields up to 100 per submission, stored as typed key/value pairs (8 KiB per value), keyed to your form's field definitions.",
      "Every submission records timestamp, IP, and user-agent — plus IP and user-agent written into a consent-events record for your double-opt-in proof.",
      "UTM capture at submit time: utm_source, utm_medium, utm_campaign, utm_term, utm_content, and ref are read off the URL and stored on the submission.",
      "Per-form 30-day metrics: visits, submissions, and conversion rate (submissions ÷ visits over the window, as a 0–100 percentage).",
      "Variant definitions can be stored for planning, but live form A/B testing is unavailable: hosted rendering serves the base form, submissions are not attributed to variants, and no winner is selected or promoted.",
      "Five embed flavors generated server-side: async script, sandboxed iframe, React component, WordPress shortcode, and raw inline <form>. Script and React flavors support exit-intent so the form opens as a modal on mouse-leave.",
      "REST API control for create, update, delete, submission listing, and opt-in confirmation; similarly named MCP definitions are source candidates only.",
    ],
    shots: [
      {
        alt: "Form builder with drag-to-reorder fields and a multi-step flow",
        variant: "forms",
      },
      {
        alt: "Per-form 30-day conversion panel showing visits, submissions, and conversion rate",
        variant: "forms",
      },
      {
        alt: "Form embed options for hosted, inline, iframe, and popup presentation",
        variant: "forms",
      },
    ],
  },
];

export default function FormsPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Capture signups anywhere.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Hosted and embeddable forms with multi-step flows, double opt-in,
            and custom fields — with the consent proof captured for you.
            Planning a standalone page?{" "}
            <Link
              href="/landing-pages"
              className="underline underline-offset-4"
            >
              Reserve a landing page
            </Link>
            .
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
            Frequently asked about forms
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
            Build a form. Watch it convert.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Hosted forms and five embed flavors are on every paid plan. Start
            free, embed in minutes, read the 30-day numbers.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              View pricing →
            </Link>
            <Link
              href="/landing-pages"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              See landing pages
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
