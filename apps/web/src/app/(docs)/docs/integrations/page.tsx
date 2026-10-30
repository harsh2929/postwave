// Moosewave docs - integrations index.

import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";

export const metadata: Metadata = {
  title: "Integrations · Moosewave docs",
  description:
    "Customer.io provider-row handoff, Slack approvals, read-only Stripe evidence, Postmark / Mailgun / SES sending, sending-identity DNS checks, and inbound webhooks.",
  alternates: { canonical: "/docs/integrations" },
};

const ITEMS = [
  {
    slug: "customerio",
    name: "Customer.io",
    blurb:
      "Partial native provider-row foundation delegating data movement to the full-snapshot migration adapter.",
    section: "Marketing",
  },
  {
    slug: "slack",
    name: "Slack",
    blurb: "Channel approvals + slash commands.",
    section: "Workflow",
  },
  {
    slug: "stripe",
    name: "Stripe",
    blurb:
      "Read supported commerce evidence through backfill and signed webhook ingestion; no subscription mutation or customer portal.",
    section: "Commerce",
  },
  {
    slug: "postmark",
    name: "Postmark",
    blurb: "ESP backbone for transactional and marketing.",
    section: "Sending",
  },
  {
    slug: "mailgun",
    name: "Mailgun",
    blurb: "Domain-verified Mailgun setup.",
    section: "Sending",
  },
  {
    slug: "ses",
    name: "Amazon SES",
    blurb: "Bring-your-own AWS sending.",
    section: "Sending",
  },
  {
    slug: "custom-domains",
    name: "Custom domains",
    blurb:
      "Bring your own sending domain. DNS records are checked on demand when you call the verify endpoint.",
    section: "Infra",
  },
  {
    slug: "inbound-webhooks",
    name: "Inbound webhooks",
    blurb:
      "Receive external events after Moosewave verifies the sender's HMAC signature.",
    section: "Infra",
  },
];

export default function IntegrationsIndexPage(): JSX.Element {
  const sections = Array.from(new Set(ITEMS.map((i) => i.section)));
  return (
    <article className="space-y-8">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Integrations" },
        ]}
      />

      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          Integrations
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          Native connectors and provider-row foundations for systems that
          operate alongside an email stack. Each page distinguishes executable
          runtime from delegated or pre-production surfaces.
        </p>
      </header>

      {sections.map((section) => (
        <section key={section} className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">{section}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ITEMS.filter((i) => i.section === section).map((it) => (
              <Link
                key={it.slug}
                href={`/docs/integrations/${it.slug}`}
                className="rounded-lg border border-pw-line bg-white p-4 hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 transition-colors"
              >
                <h3 className="text-base font-semibold text-pw-ink2">
                  {it.name}
                </h3>
                <p className="mt-1 text-sm text-pw-muted-on-paper">
                  {it.blurb}
                </p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}
