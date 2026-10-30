// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import type { ReactNode } from "react";

import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { Button } from "@/components/ui/button";
import { publicSiteOrigin } from "@/lib/site-url";
import { compactProse } from "@/styles/compact-prose";

const SITE_URL = publicSiteOrigin();

export type ComparisonRow = {
  dimension: string;
  moosewave: string;
  competitor: string;
};

export type DimensionDetail = {
  heading: string;
  body: ReactNode;
};

export type WhenScenario = {
  title: string;
  body: string;
};

export type ComparisonPageProps = {
  competitor: string;
  slug: string;
  oneLiner: string;
  rows: ComparisonRow[];
  details: DimensionDetail[];
  scenarios: WhenScenario[];
  migrationSteps: string[];
  jsonLd: object;
  /** Optional FAQ entries; render as visible <details> + FAQPage JSON-LD. */
  faqs?: FaqEntry[];
};

export function ComparisonPage(props: ComparisonPageProps): JSX.Element {
  const {
    competitor,
    slug,
    oneLiner,
    rows,
    details,
    scenarios,
    migrationSteps,
    jsonLd,
    faqs,
  } = props;

  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: SITE_URL },
    { name: "Compare", url: `${SITE_URL}/vs` },
    {
      name: `Moosewave vs ${competitor}`,
      url: `${SITE_URL}/vs/${slug}`,
    },
  ]);

  const blocks: JsonLdObject[] = [jsonLd as JsonLdObject, breadcrumbs];
  if (faqs && faqs.length > 0) {
    blocks.push(faqPageSchema(faqs));
  }

  return (
    <div>
      <JsonLd data={blocks} />

      {/* Hero */}
      <section className="border-b border-pw-line">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <p className="text-xs uppercase tracking-widest text-pw-muted-on-paper">
            Comparison
          </p>
          <h1 className="mt-3 text-4xl md:text-5xl font-semibold tracking-tight">
            Moosewave vs {competitor}
          </h1>
          <p className="mt-5 text-lg text-pw-muted-on-paper max-w-3xl leading-relaxed">
            {oneLiner}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={`/migrations/${slug}`}>
                Migrate from {competitor} with proof
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing">See Moosewave pricing</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* TL;DR table */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          The 60-second comparison
        </h2>
        <p className="mt-2 text-pw-muted-on-paper max-w-2xl">
          Dimensions creators commonly evaluate when switching newsletter
          platforms. Verify current third-party terms with that provider before
          making a purchase decision.
        </p>
        <div
          role="region"
          aria-label={`Moosewave compared with ${competitor}`}
          tabIndex={0}
          className="mt-8 overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
        >
          <table className="w-full text-sm">
            <thead className="bg-pw-surface">
              <tr>
                <th scope="col" className="text-left p-3 font-medium">
                  Dimension
                </th>
                <th scope="col" className="text-left p-3 font-medium">
                  Moosewave
                </th>
                <th scope="col" className="text-left p-3 font-medium">
                  {competitor}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.dimension} className="border-t align-top">
                  {/* The dimension is the row header, not data. As a <td> a
                      screen reader announced each value with only its column
                      ("Moosewave: …") and no way to tell which dimension was
                      being described — in a table whose entire purpose is
                      dimension-by-dimension comparison. */}
                  <th scope="row" className="p-3 font-medium text-left">
                    {r.dimension}
                  </th>
                  <td className="p-3 text-pw-muted-on-paper">{r.moosewave}</td>
                  <td className="p-3 text-pw-muted-on-paper">{r.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Detailed sections */}
      <section
        className={`${compactProse.root} ${compactProse.small} max-w-3xl mx-auto px-6 py-20`}
      >
        <h2>How they actually compare, dimension by dimension</h2>
        {details.map((d) => (
          <section key={d.heading}>
            <h3>{d.heading}</h3>
            {d.body}
          </section>
        ))}
      </section>

      {/* Migration preview */}
      <section className="border-y bg-pw-surface">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
            What migrating from {competitor} looks like
          </h2>
          <ol className="mt-6 space-y-3 text-sm text-pw-muted-on-paper list-decimal list-inside">
            {migrationSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="mt-6">
            <Link
              href={`/migrations/${slug}`}
              className="text-sm font-medium underline underline-offset-4"
            >
              Read the full {competitor} migration guide →
            </Link>
          </div>
        </div>
      </section>

      {/* When to use the competitor, credibility */}
      <section className="max-w-3xl mx-auto px-6 py-20">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          When {competitor} is the right call (not Moosewave)
        </h2>
        <p className="mt-2 text-pw-muted-on-paper">
          Three honest scenarios where you should not switch. We would rather
          you stay than churn at month two.
        </p>
        <div className="mt-8 grid md:grid-cols-3 gap-6">
          {scenarios.map((s) => (
            <div key={s.title} className="rounded-lg border p-5 bg-pw-paper">
              <div className="font-medium">{s.title}</div>
              <p className="mt-2 text-sm text-pw-muted-on-paper leading-relaxed">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      {faqs && faqs.length > 0 ? (
        <section
          aria-labelledby="faq-heading"
          className="border-t border-pw-line"
        >
          <div className="max-w-3xl mx-auto px-6 py-20">
            <h2
              id="faq-heading"
              className="text-2xl md:text-3xl font-semibold tracking-tight"
            >
              Frequently asked about Moosewave vs {competitor}
            </h2>
            <div className="mt-8 space-y-3">
              {faqs.map((item) => (
                <details
                  key={item.question}
                  className="group rounded-lg border border-pw-line bg-pw-paper px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
                >
                  <summary className="flex cursor-pointer items-start justify-between gap-4 list-none">
                    <h3 className="text-sm font-medium m-0">{item.question}</h3>
                    <span
                      aria-hidden
                      className="font-mono text-pw-muted-on-paper/70 text-sm shrink-0 group-open:rotate-45 transition-transform"
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
          </div>
        </section>
      ) : null}

      {/* Final CTA */}
      <section className="border-t border-pw-line">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">
            Migrate from {competitor} with a dry-run first.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper">
            Subscribers, consent timestamps, suppression list, supported
            automations, and paid subscriptions move behind a verification
            report. Confirm the current price and exact included rights at
            checkout before purchase.
          </p>
          <div className="mt-6 flex justify-center gap-3 flex-wrap">
            <Button asChild size="lg">
              <Link href="/signup">Get Moosewave. $349</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={`/migrations/${slug}`}>
                Read the {competitor} migration guide
              </Link>
            </Button>
          </div>
          <p className="mt-4 text-xs text-pw-muted-on-paper">
            Refund eligibility and cancellation rights are governed by the terms
            shown at checkout and the applicable Refund Policy.
          </p>
        </div>
      </section>
    </div>
  );
}

export function buildProductJsonLd(args: {
  competitor: string;
  slug: string;
  description: string;
}): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `Moosewave, alternative to ${args.competitor}`,
    description: args.description,
    brand: { "@type": "Brand", name: "Moosewave" },
    url: `${SITE_URL}/vs/${args.slug}`,
    category: "Newsletter and email marketing platform",
  };
}
