// Moosewave docs - migration guide index.

import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";

export const metadata: Metadata = {
  title: "Migration guides · Moosewave docs",
  description:
    "Migrate to Moosewave from Mailchimp, ActiveCampaign, Customer.io, ConvertKit, Brevo, Beehiiv, Substack, MailerLite, Sendy CSV exports, or any CSV. Dry-run before commit, with source-specific cutover gates.",
  alternates: { canonical: "/docs/migrations" },
};

const SOURCES = [
  {
    slug: "mailchimp",
    name: "Mailchimp",
    blurb:
      "OAuth import. Selected audiences and archive; automation support is limited and requires review.",
    eta: "20 min",
  },
  {
    slug: "activecampaign",
    name: "ActiveCampaign",
    blurb:
      "Controlled cutover. Contacts, campaigns, automation rebuild evidence, CRM, and SMS inventory.",
    eta: "30-90 min",
  },
  {
    slug: "customerio",
    name: "Customer.io",
    blurb:
      "App API workspace import. Immutable cio_id profiles, frozen audiences, sent email archive, rebuild-only workflows, and mandatory final full snapshot.",
    eta: "Workspace-dependent",
  },
  {
    slug: "convertkit",
    name: "ConvertKit (Kit)",
    blurb:
      "OAuth import. Subscribers, audience data and broadcast archive; sequence definitions need rebuild review.",
    eta: "15 min",
  },
  {
    slug: "brevo",
    name: "Brevo (Sendinblue)",
    blurb:
      "API key import. Contacts, lists, campaigns. Transactional templates are counted, not imported.",
    eta: "15 min",
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    blurb:
      "Service Key or existing private-app token. Email contacts, preferences and frozen membership tags; HubSpot remains the CRM system of record.",
    eta: "15-45 min",
  },
  {
    slug: "beehiiv",
    name: "Beehiiv",
    blurb:
      "Publication import. Subscribers, frozen audiences, sent posts and membership metadata; live billing is separate.",
    eta: "20 min",
  },
  {
    slug: "substack",
    name: "Substack",
    blurb:
      "CSV or official ZIP. Subscribers, membership metadata and post archive; Stripe/Apple billing is a separate handoff.",
    eta: "30 min",
  },
  {
    slug: "mailerlite",
    name: "MailerLite",
    blurb:
      "API token import. Subscribers and group tags; saved segments and automations preserved for rebuild review.",
    eta: "15 min",
  },
  {
    slug: "sendy",
    name: "Sendy CSV",
    blurb:
      "CSV export import. Subscribers and status fields with Sendy provenance.",
    eta: "10 min",
  },
  {
    slug: "csv",
    name: "CSV import",
    blurb:
      "Universal fallback. Header mapping, custom fields and conservative status preservation; unknown consent stays unconfirmed.",
    eta: "10 min",
  },
] as const;

export default function MigrationsIndexPage(): JSX.Element {
  return (
    <article className="space-y-8">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Migrations" },
        ]}
      />

      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          Migration guides
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          Moosewave documents first-party import contracts for major newsletter
          and CRM platforms plus a universal CSV import. Each migration starts
          with inventory and dry-run review before commit; source-specific final
          delta, shadow, rebuild, pilot, and rollback gates still apply.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {SOURCES.map((s) => (
          <Link
            key={s.slug}
            href={`/docs/migrations/${s.slug}`}
            className="rounded-lg border border-pw-line bg-white p-4 hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 transition-colors"
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-pw-ink2">{s.name}</h2>
              <span className="text-[11px] font-mono text-pw-muted-on-paper">
                {s.eta}
              </span>
            </div>
            <p className="mt-2 text-sm text-pw-muted-on-paper">{s.blurb}</p>
          </Link>
        ))}
      </div>
    </article>
  );
}
