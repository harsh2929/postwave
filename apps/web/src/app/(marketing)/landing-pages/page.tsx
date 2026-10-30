// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "newsletter landing page", "signup landing page",
// "hosted newsletter signup page". Primary intent is an operator deciding
// whether Moosewave can prepare standalone landing pages while using hosted
// forms for live capture until the full editor is enabled.
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

const PAGE_URL = "https://moosewave.com/landing-pages";
const PAGE_DESCRIPTION =
  "Create and manage landing-page records now while hosted forms handle live capture. The block editor, custom domains, SEO controls, and page metrics are being staged behind the dashboard editor.";

export const metadata: Metadata = {
  title: "Landing pages | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave landing pages",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/landing-pages/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave landing pages",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave landing pages",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "What is available for landing pages now?",
    answer:
      "The dashboard can create, list, and archive landing-page records so teams can reserve slugs and plan campaigns. The block, SEO, domain, and metrics editor is still staged, so use hosted or embedded forms for production capture until that editor is enabled.",
  },
  {
    question: "Can I start from templates?",
    answer:
      "Template data exists in the landing-page model, but self-serve template selection and block editing are not exposed in the dashboard yet. Today the admin surface is for creating and organizing page records.",
  },
  {
    question: "Can I use my own domain?",
    answer:
      "Not through self-serve landing pages yet. The page model has domain and SEO fields, but domain assignment, verification, and metadata editing remain behind the upcoming editor. Use hosted forms or your existing site for live public capture today.",
  },
  {
    question: "What metrics do I get on a landing page?",
    answer:
      "Per-form 30-day visits, submissions, and conversion rate are live today. Landing-page metrics are modeled, but the dashboard page does not present them until the editor and publish flow are enabled.",
  },
  {
    question: "When should I use a landing page instead of a form?",
    answer:
      "Use a hosted or embedded form when you need a live signup path now. Use the landing-page admin to reserve slugs and prepare future standalone pages that will feed the same audience, suppression, and consent pipeline once the editor is enabled.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Landing pages", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Landing pages",
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
    id: "builder",
    number: "1.0",
    eyebrow: "Planning",
    title: "Reserve the page before the campaign rush.",
    subhead:
      "Create landing-page records, lock in clean slugs, and keep the future publish workflow organized while hosted forms remain the production capture path.",
    bullets: [
      "Create named landing-page records with URL-safe slugs from the dashboard.",
      "Track draft, published, and archived states without linking to a missing editor.",
      "Archive old records without deleting the planning history.",
      "Use hosted and embedded forms for live subscriber capture until page editing and publishing are enabled.",
    ],
    shots: [
      {
        alt: "Landing page admin list with draft and archived records",
        variant: "forms",
      },
      {
        alt: "Landing page creation form with a URL-safe slug field",
        variant: "forms",
      },
      {
        alt: "Landing page records with supported record actions",
        variant: "forms",
      },
    ],
  },
  {
    id: "domain",
    number: "2.0",
    eyebrow: "Domain & SEO",
    title: "Domain and metadata fields are modeled, not self-serve.",
    subhead:
      "The data model already has places for domain, SEO, tracking, and blocks. The dashboard intentionally keeps those controls out of the public promise until the editor route exists.",
    bullets: [
      "Landing page records carry domain, SEO, tracking, block, and metrics fields in the API model.",
      "The current dashboard does not expose self-serve domain verification or SEO editing.",
      "Hosted forms remain the live, crawlable capture option while landing-page publishing is staged.",
    ],
    shots: [
      {
        alt: "Landing page API model with SEO and domain fields",
        variant: "forms",
      },
      {
        alt: "Hosted form used as the live capture surface",
        variant: "forms",
      },
      {
        alt: "Landing page editor controls staged for a future dashboard route",
        variant: "forms",
      },
    ],
  },
  {
    id: "metrics",
    number: "3.0",
    eyebrow: "Metrics",
    title: "Use form metrics while page metrics stage.",
    subhead:
      "The analytics contract is clear: do not show page conversion numbers until view, submit, and conversion events are connected in the page editor.",
    bullets: [
      "Forms already show visits, submissions, and 30-day conversion rates.",
      "Landing-page records retain a metrics field for the upcoming publish flow.",
      "The public dashboard avoids fake page analytics until the live event path exists.",
    ],
    shots: [
      {
        alt: "Hosted form metrics showing visits, submissions, and conversion rate",
        variant: "landing",
      },
      {
        alt: "Landing-page metrics model reserved for future publishing",
        variant: "landing",
      },
      {
        alt: "List-growth goal fed by live form submissions",
        variant: "landing",
      },
    ],
  },
];

export default function LandingPagesPage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Landing pages you can prepare now.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Create landing-page records and reserve slugs in the dashboard. For
            a live capture page today, publish a{" "}
            <Link href="/forms" className="underline underline-offset-4">
              hosted form
            </Link>{" "}
            while the full block editor, custom domains, SEO controls, and page
            metrics are staged behind the editor route.
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
            Frequently asked about landing pages
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
            Plan the page. Ship the capture path.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Landing-page records are available for planning. Hosted and embedded
            forms are the production path for collecting signups today.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              View pricing →
            </Link>
            <Link
              href="/forms"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              See hosted forms
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
