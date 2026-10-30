// SPDX-License-Identifier: AGPL-3.0-only
//
// Integrations directory. Server component, no client interactivity in V1.
// Categories are stable and sourced from src/lib/integrations.ts so the
// detail-page template and this index can never drift apart.
import type { Metadata } from "next";
import Link from "next/link";

import { IntegrationsDirectory } from "@/components/marketing/integrations-directory";
import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { INTEGRATION_CATEGORIES, INTEGRATIONS } from "@/lib/integrations";

const PAGE_URL = "https://moosewave.com/integrations";
const PAGE_DESCRIPTION =
  "Moosewave integration catalogue for Slack, Discord, Microsoft Teams, Stripe, Shopify, Zapier, n8n, webhooks, and a release-held MCP source candidate.";

export const metadata: Metadata = {
  title: "Integrations | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave integrations",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/integrations/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave integrations directory",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave integrations",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

export default function IntegrationsIndexPage(): JSX.Element {
  const cards = INTEGRATIONS.map((i) => ({
    slug: i.slug,
    name: i.name,
    category: i.category,
    summary: i.summary,
  }));

  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: "https://moosewave.com" },
    { name: "Integrations", url: PAGE_URL },
  ]);

  const itemList: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: INTEGRATIONS.map((i, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: i.name,
      url: `https://moosewave.com/integrations/${i.slug}`,
    })),
  };

  return (
    <div className="bg-pw-paper">
      <JsonLd data={[itemList, breadcrumbs]} id="integrations-jsonld" />

      {/* === Hero === */}
      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-5xl mx-auto px-6 pt-16 pb-14 md:pt-20 md:pb-16">
          <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
            Integrations
          </div>
          <h1 className="mt-3 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Plays well with the rest of your stack.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Communication, commerce, automation, and AI — connected via the
            standard APIs your team already trusts. {INTEGRATIONS.length}{" "}
            integrations today, more on the roadmap.
          </p>
        </div>
      </section>

      {/* === Searchable / filterable directory (MKTP-011) === */}
      <section className="bg-pw-paper">
        <div className="max-w-5xl mx-auto px-6 py-16 md:py-20">
          <IntegrationsDirectory
            items={cards}
            categories={[...INTEGRATION_CATEGORIES]}
          />
        </div>
      </section>

      {/* === Build-your-own === */}
      <section className="border-t border-pw-surface bg-pw-surface/40">
        <div className="max-w-5xl mx-auto px-6 py-14 grid gap-8 md:grid-cols-[1fr_1fr] items-center">
          <div>
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
              Don&apos;t see your tool?
            </h2>
            <p className="mt-3 text-pw-muted-on-paper leading-relaxed">
              Most workflows we don&apos;t list as a first-party integration are
              one webhook away. Or use the OpenAPI spec to wire it directly.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 md:justify-end">
            <Link
              href="/integrations/webhook"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 transition-colors text-white px-4 py-2 text-sm font-medium"
            >
              Custom webhooks →
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ember-500 hover:text-pw-ember-700 transition-colors px-4 py-2 text-sm font-medium text-pw-ink2"
            >
              API docs →
            </Link>
          </div>
        </div>
      </section>

      {/* === Internal-link footer === */}
      <section className="border-t border-pw-surface bg-pw-paper">
        <div className="max-w-5xl mx-auto px-6 py-12 grid gap-8 md:grid-cols-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              Read the writeups
            </div>
            <Link
              href="/blog"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              Engineering blog →
            </Link>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              See the platform
            </div>
            <Link
              href="/features"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              Features in detail →
            </Link>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              Security
            </div>
            <Link
              href="/security"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              How we secure your data →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
