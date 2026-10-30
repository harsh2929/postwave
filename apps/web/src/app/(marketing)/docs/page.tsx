// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "Moosewave docs", "Moosewave API documentation",
// "Moosewave migration guide". This is the docs landing — entry point to
// product surfaces, migrations, status, roadmap.
import type { Metadata } from "next";
import Link from "next/link";

import { SearchBar } from "@/components/docs/SearchBar";
import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { getSearchIndex } from "@/lib/docs/search.server";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
} from "@/lib/mcp-release-status";

const PAGE_URL = "https://moosewave.com/docs";
const PAGE_DESCRIPTION =
  "Developer and operator references for Moosewave APIs, migrations, status, roadmap, and a release-held MCP source candidate.";

export const metadata: Metadata = {
  title: "Moosewave docs",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "article",
    url: PAGE_URL,
    title: "Moosewave docs",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/docs/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave documentation hub",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave docs",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const SECTIONS = [
  {
    href: "/docs/getting-started",
    title: "Get started",
    body: "Learn the core concepts, authentication model, and first steps for using Moosewave.",
  },
  {
    href: "/api-docs",
    title: "API reference",
    body: "Browse the operations published in the OpenAPI 3.1 contract, with request and response details.",
  },
  {
    href: "/mcp",
    title: "MCP source candidate",
    body: "Inspect mutable source definitions under release hold; no install, hosted connector, or working-key setup is available.",
  },
  {
    href: "/migrations",
    title: "Migrations",
    body: "Plan provider migrations and launch the in-app migration wizard.",
  },
  {
    href: "/status",
    title: "Status",
    body: "Review service health and subscribe to platform updates.",
  },
  {
    href: "/roadmap",
    title: "Roadmap",
    body: "Track what is implemented, staged, and coming next.",
  },
] as const;

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Docs", url: PAGE_URL },
]);

const ITEM_LIST_JSON_LD: JsonLdObject = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Moosewave documentation sections",
  itemListElement: SECTIONS.map((s, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: s.title,
    url: `https://moosewave.com${s.href}`,
    description: s.body,
  })),
};

export default function DocsPage(): JSX.Element {
  const searchIndex = getSearchIndex();
  return (
    <div className="max-w-5xl mx-auto px-6 py-16 space-y-10">
      <JsonLd data={[BREADCRUMBS_JSON_LD, ITEM_LIST_JSON_LD]} />
      <header className="max-w-3xl space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          Moosewave docs
        </h1>
        <p className="text-pw-muted-on-paper">
          Quick references for the local product surface, migration flows, and
          operational checks. {MCP_RELEASE_STATUS_COPY}
        </p>
        <p className="font-mono text-xs text-pw-ember-700">
          {MCP_RELEASE_HOLD_CODE}
        </p>
        <div className="max-w-sm">
          <SearchBar index={searchIndex} />
        </div>
      </header>

      <nav aria-label="Docs" className="grid md:grid-cols-2 gap-4">
        {SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="rounded-lg border border-pw-surface p-5 transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
          >
            <h2 className="font-semibold text-pw-ink2">{section.title}</h2>
            <p className="mt-2 text-sm text-pw-muted-on-paper">
              {section.body}
            </p>
          </Link>
        ))}
      </nav>
    </div>
  );
}
