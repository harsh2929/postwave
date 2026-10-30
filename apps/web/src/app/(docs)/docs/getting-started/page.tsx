// Moosewave docs - getting started / overview.
//
// Doubles as the docs landing page. The legacy marketing route /docs already
// owns the literal /docs URL, so this file is the natural entry point for
// the new doc site (linked from the docs subdomain root and from sidebar).

import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { Callout } from "@/components/docs/Callout";
import { DOCS_MIGRATION_SOURCES } from "@/lib/docs/catalog";
import { listOperations, operationsByTag } from "@/lib/docs/loadOpenAPI";
import { POPULAR } from "@/lib/docs/popular";
import { asRoute } from "@/lib/typed-routes";

const API_OPERATION_COUNT = listOperations().length;
const API_TAG_COUNT = operationsByTag().length;

export const metadata: Metadata = {
  title: "Getting started · Moosewave docs",
  description:
    "Pre-production quickstart, API reference, MCP skills, migration guides, and integration contracts for Moosewave.",
  alternates: { canonical: "/docs/getting-started" },
};

const TOP_CARDS = [
  {
    href: "/docs/quickstart",
    eyebrow: "Get started",
    title: "Quickstart",
    body: "Five steps from sign-up to first campaign. Code examples for every step.",
  },
  {
    href: "/docs/api",
    eyebrow: "Reference",
    title: "API reference",
    body: `${API_OPERATION_COUNT} REST endpoints across ${API_TAG_COUNT} tags. Request and response shapes, curl snippets, error codes.`,
  },
  {
    href: "/docs/migrations",
    eyebrow: "Guides",
    title: "Migration guides",
    body: "Switch from ActiveCampaign, HubSpot, Mailchimp, ConvertKit, Customer.io, Brevo, Beehiiv, Substack, MailerLite, Sendy CSV, or generic CSV.",
  },
] as const;

export default function GettingStartedPage(): JSX.Element {
  return (
    <article className="space-y-10">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Getting started" },
        ]}
      />

      <header className="space-y-4">
        <h1 className="text-3xl md:text-5xl font-semibold tracking-tight">
          Moosewave docs
        </h1>
        <p className="text-lg text-pw-muted-on-paper max-w-3xl">
          Moosewave is undergoing production qualification. These docs describe
          the API, the release-held MCP source candidate, controlled migrations
          from all {DOCS_MIGRATION_SOURCES.length} supported migration sources,
          and operator integration contracts. Documentation is not a declaration
          that a provider or capability is generally available.
        </p>
      </header>

      <section
        aria-label="Doc highlights"
        className="grid grid-cols-1 md:grid-cols-3 gap-4"
      >
        {TOP_CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            prefetch={false}
            className="rounded-lg border border-pw-line bg-white p-5 hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 transition-colors"
          >
            <div className="text-[10px] font-mono uppercase tracking-widest text-pw-ember-700">
              {c.eyebrow}
            </div>
            <h2 className="mt-2 text-lg font-semibold text-pw-ink2">
              {c.title}
            </h2>
            <p className="mt-1 text-sm text-pw-muted-on-paper leading-relaxed">
              {c.body}
            </p>
          </Link>
        ))}
      </section>

      <section className="space-y-3" id="popular">
        <h2 className="text-xl font-semibold">Most-read articles</h2>
        <p className="text-sm text-pw-muted-on-paper">
          Hand-curated for the v1 docs launch. Once page-view analytics land we
          will rank by real traffic.
        </p>
        <ul className="space-y-1">
          {POPULAR.map((p) => (
            <li key={p.href}>
              <Link
                href={asRoute(p.href)}
                prefetch={false}
                className="inline-flex min-h-11 items-center gap-2 rounded-sm text-sm text-pw-ink2 transition-colors hover:text-pw-ember-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
              >
                <span
                  aria-hidden
                  className="h-1 w-1 rounded-full bg-pw-ember-500"
                />
                {p.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4" id="authentication">
        <h2 className="text-2xl font-semibold tracking-tight">
          Authentication
        </h2>
        <p className="text-pw-muted-on-paper leading-relaxed">
          The Moosewave API uses bearer-token authentication. Every request must
          carry an{" "}
          <code className="rounded bg-pw-surface px-1 py-0.5 font-mono text-sm">
            Authorization: Bearer pw_…
          </code>{" "}
          header. Mutating endpoints (POST, PUT, PATCH, DELETE) accept an
          optional{" "}
          <code className="rounded bg-pw-surface px-1 py-0.5 font-mono text-sm">
            Idempotency-Key
          </code>{" "}
          header for safe retries.
        </p>
        <Callout variant="info" title="Generate a key">
          Sign in, then go to <strong>Settings → API keys</strong> and click
          “Generate new key.” Store the key in your environment as{" "}
          <code className="font-mono">POSTWAVE_API_KEY</code>.
        </Callout>
      </section>

      <section className="space-y-4" id="concepts">
        <h2 className="text-2xl font-semibold tracking-tight">Core concepts</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            {
              t: "Tenant",
              d: "Your Moosewave account. Multi-tenant Postgres with row-level security; everything you write is scoped to your tenant.",
            },
            {
              t: "Voice profile",
              d: "Tonality, pacing, and characteristic phrasings learned from your past archive sources. Drives sequence generation.",
            },
            {
              t: "Sequence",
              d: "An ordered series of emails generated in voice from one of 50 launch templates.",
            },
            {
              t: "Campaign",
              d: "A single send to a segment. Either authored by hand in the GrapesJS editor or generated from a sequence step.",
            },
            {
              t: "Inbox Reality",
              d: "The deliverability scoring layer. Pre-send predictor plus Gemini-powered AI Diagnostician for placement explanations.",
            },
            {
              t: "Migration job",
              d: "OAuth, API-token, API-key, or CSV-backed import from another ESP. Dry-run first, then commit; reversible within 7 days. ActiveCampaign adds source-event, final-delta, and rebuild-review gates before cutover; HubSpot bridge jobs add source-event, final-delta, rollback-rehearsal, and private-app-token cleanup gates.",
            },
          ].map((it) => (
            <div
              key={it.t}
              className="rounded-md border border-pw-line bg-white p-4"
            >
              <dt className="text-sm font-semibold text-pw-ink2">{it.t}</dt>
              <dd className="mt-1 text-sm text-pw-muted-on-paper leading-relaxed">
                {it.d}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </article>
  );
}
