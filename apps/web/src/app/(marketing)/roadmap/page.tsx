// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { Button } from "@/components/ui/button";
import { asRoute } from "@/lib/typed-routes";

import { RoadmapFeedbackForm } from "./roadmap-feedback-form";

const PAGE_URL = "https://moosewave.com/roadmap";
const DESCRIPTION =
  "Moosewave's production-qualification roadmap. Listed work is not generally available until its release evidence is published.";

export const metadata: Metadata = {
  title: "Production qualification roadmap | Moosewave",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: false, follow: true },
};

type Item = { title: string; body: string; href?: string };

const QUALIFICATION: Item[] = [
  {
    title: "Core messaging release candidate",
    body: "Subscribers, campaigns, templates, forms, suppressions, consent, and automation code are undergoing release-candidate qualification. A dashboard route or passing unit test is not a GA declaration; the exact candidate must pass integration, installed-client, security, migration, and recovery gates.",
  },
  {
    title: "Migration certification",
    href: "/migrations",
    body: "Migration remains dry-run-first. Each enabled source must prove authentication, pagination, rate-limit recovery, canonical mapping, reconciliation, and rollback against a production-shaped test account. Automations translate only where safe; otherwise the report preserves rebuild evidence.",
  },
  {
    title: "Desktop distribution",
    body: "Signed and notarized installers, deep links, credential storage, auto-update, rollback, minimum operating-system support, and installed-shell journeys must pass on the exact release artifacts before desktop distribution is approved.",
  },
  {
    title: "Canonical hosted environment",
    body: "DNS, certificates, data stores, secrets, migrations, monitoring, backups, restore drills, promotion, and rollback must be provisioned from reviewed infrastructure and exercised on immutable image digests before a hosted environment is described as production-ready.",
  },
];

const PILOT_GATES: Item[] = [
  {
    title: "Provider integrations and channels",
    body: "Commerce, CRM, advertising, SMS, social, warehouse, and notification providers are enabled only after their adapter passes provider-specific outage, webhook, revocation, reconciliation, and rate-limit contracts. Uncertified adapters remain unavailable rather than returning simulated success.",
  },
  {
    title: "AI and deliverability services",
    body: "Voice, prediction, diagnostics, seed-list, and reputation features require configured providers, explicit data-processing terms, cost controls, fallbacks, and measured quality evidence. Their presence in source does not mean they are enabled for a customer environment.",
  },
  {
    title: "Billing and action execution",
    body: "Paid subscriptions, gifts, discounts, and approved remediation actions require durable idempotent adapters and reconciliation. A surface stays disabled until its real side effects can be verified; no no-op adapter may report success.",
  },
];

const FUTURE: Item[] = [
  {
    title: "Evidence-backed GA catalog",
    body: "A single generated catalog will connect each advertised capability to its owner, contract tests, deployed version, operating runbook, support status, and current evidence. Only entries in that catalog may use GA or shipped language.",
  },
  {
    title: "Self-hosted distribution",
    body: "Self-hosting, source availability, escrow, update tooling, and commercial support are not currently promised. They require a reconciled licensing model, support boundary, packaged release, upgrade path, and executed customer terms.",
  },
  {
    title: "Independent assurance",
    body: "SOC 2, ISO 27001, privacy certifications, and recovery objectives will appear publicly only after the applicable scope, auditor or assessor, report, dates, exceptions, and renewal evidence exist. Per-tier availability targets are already stated in Terms section 9; what does not yet exist is measured uptime history against them in a qualified environment.",
  },
];

function Column({
  label,
  subLabel,
  items,
}: {
  label: string;
  subLabel: string;
  items: Item[];
}): JSX.Element {
  return (
    <div className="rounded-lg border bg-pw-paper p-6">
      <div className="text-xs uppercase tracking-widest text-pw-ember-600 dark:text-pw-ember-400">
        {label}
      </div>
      <h2 className="text-2xl font-semibold tracking-tight mt-1">{subLabel}</h2>
      <ul className="mt-6 space-y-5">
        {items.map((item) => (
          <li key={item.title}>
            <h3 className="font-medium text-sm m-0">
              {item.href ? (
                <Link
                  className="underline underline-offset-4 hover:text-pw-ink2"
                  href={asRoute(item.href)}
                >
                  {item.title}
                </Link>
              ) : (
                item.title
              )}
            </h3>
            <p className="mt-1 text-sm text-pw-muted-on-paper leading-relaxed">
              {item.body}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function itemListFor(name: string, items: Item[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "CreativeWork",
        name: item.title,
        description: item.body,
      },
    })),
  };
}

export default function RoadmapPage(): JSX.Element {
  // MKTC-019: when a marketing-tenant feedback form is published, its slug is
  // exposed here so the structured form renders; otherwise we keep the mailto.
  const roadmapFormSlug = process.env.NEXT_PUBLIC_ROADMAP_FORM_SLUG;
  return (
    <div>
      <JsonLd
        data={[
          breadcrumbSchema([
            { name: "Home", url: "https://moosewave.com" },
            { name: "Roadmap", url: PAGE_URL },
          ]),
          itemListFor("Release qualification", QUALIFICATION),
          itemListFor("Pilot gates", PILOT_GATES),
          itemListFor("Future evidence", FUTURE),
        ]}
      />

      <section className="border-b border-pw-line">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <p className="text-xs uppercase tracking-widest text-pw-muted-on-paper">
            Production qualification roadmap
          </p>
          <h1 className="mt-3 text-4xl md:text-5xl font-semibold tracking-tight">
            Evidence before availability
          </h1>
          <p className="mt-5 text-lg text-pw-muted-on-paper max-w-3xl leading-relaxed">
            Moosewave is completing production qualification. Items below are
            engineering scope and release gates, not promises of availability,
            dates, certification, or inclusion in a purchase. Customer-specific
            commitments belong in an executed order or license.
          </p>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid lg:grid-cols-3 gap-6">
          <Column
            label="Current"
            subLabel="Release qualification"
            items={QUALIFICATION}
          />
          <Column
            label="Conditional"
            subLabel="Pilot gates"
            items={PILOT_GATES}
          />
          <Column label="Future" subLabel="No commitment" items={FUTURE} />
        </div>
        <p className="mt-10 text-sm text-pw-muted-on-paper max-w-2xl">
          No item on this page is GA merely because code or a route exists. The
          release catalog and the applicable customer agreement are the sources
          of truth for supported capabilities.
        </p>
      </section>

      <section className="border-t bg-pw-surface">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
            Share a qualification requirement
          </h2>
          <p className="mt-3 text-pw-muted-on-paper">
            Tell us which workflow, deployment evidence, or contractual control
            you need evaluated. Feedback informs priority but is not a delivery
            commitment.
          </p>
          {roadmapFormSlug ? (
            <RoadmapFeedbackForm
              slug={roadmapFormSlug}
              options={[...QUALIFICATION, ...PILOT_GATES].map(
                (item) => item.title,
              )}
            />
          ) : (
            <div className="mt-6">
              <Button asChild size="lg">
                <Link href="mailto:roadmap@moosewave.com">
                  Email the roadmap inbox
                </Link>
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
