// SPDX-License-Identifier: AGPL-3.0-only
//
// Migration-scenario page. These are explicitly illustrative workflows, not
// customer testimonials or claims about measured customer outcomes.
import type { Metadata } from "next";
import Link from "next/link";

import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import { publicSiteOrigin } from "@/lib/site-url";

const SITE_URL = publicSiteOrigin();
const PAGE_URL = `${SITE_URL}/customers`;
const PAGE_DESCRIPTION =
  "Illustrative Moosewave migration workflows for indie creators, SaaS teams, and small businesses—without fabricated testimonials or outcome claims.";

export const metadata: Metadata = {
  title: "Migration scenarios | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "How a careful Moosewave migration works",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/customers/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Illustrative Moosewave migration workflows",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "How a careful Moosewave migration works",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

interface MigrationScenario {
  slug: string;
  audience: string;
  startingPoint: string;
  workflow: string;
  verification: string;
}

const MIGRATION_SCENARIOS: MigrationScenario[] = [
  {
    slug: "indie-creator",
    audience: "Scenario: independent newsletter",
    startingPoint:
      "A creator wants to move selected Mailchimp audiences, available consent history, safely translatable segments, and supported Classic Automations without writing to the destination before reviewing the mapping.",
    workflow:
      "Connect the source, run a dry-run, review translated resources and explicit rebuild items, then commit only after the verification report is accepted.",
    verification:
      "Compare source and destination counts, review suppression and consent evidence, and run sender-authentication checks before the first production send.",
  },
  {
    slug: "bootstrapped-saas",
    audience: "Scenario: SaaS lifecycle team",
    startingPoint:
      "A small team needs to consolidate newsletter contacts while keeping its CRM as the system of record and treating unsupported automation logic as review work.",
    workflow:
      "Import audience data in a dry-run, inspect lifecycle rebuild evidence, replay supported source events, and perform a final delta import immediately before cutover.",
    verification:
      "Use the shadow monitor and rollback rehearsal, confirm CRM ownership boundaries, and require explicit acceptance for every rebuild item before promotion.",
  },
  {
    slug: "creator-adjacent-smb",
    audience: "Scenario: small-business list",
    startingPoint:
      "A non-technical operator has a CSV export and needs a safe path to map fields, preserve opt-out state, and validate sending configuration.",
    workflow:
      "Upload the export, map columns, quarantine invalid rows, inspect the dry-run counts, and commit only the reviewed records.",
    verification:
      "Resolve rejected rows, confirm suppression coverage, verify SPF and DKIM, and use a test campaign plus inbox-placement evidence before contacting the full list.",
  },
];

export default function CustomersPage(): JSX.Element {
  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: SITE_URL },
    { name: "Customers", url: PAGE_URL },
  ]);

  return (
    <div className="bg-pw-paper">
      <JsonLd data={breadcrumbs} id="customers-jsonld" />

      {/* === Hero === */}
      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-5xl mx-auto px-6 pt-16 pb-14 md:pt-20 md:pb-20">
          <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
            Customers
          </div>
          <h1 className="mt-3 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            How a careful migration works.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            These are illustrative workflows, not customer testimonials or
            measured outcomes. They show the review and verification steps
            available for three common starting points.
          </p>
        </div>
      </section>

      {/* === Illustrative migration workflows === */}
      <section className="bg-pw-paper">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-24 space-y-20">
          {MIGRATION_SCENARIOS.map((scenario) => (
            <section
              key={scenario.slug}
              id={scenario.slug}
              className="scroll-mt-20"
              aria-labelledby={`${scenario.slug}-heading`}
            >
              <h2
                id={`${scenario.slug}-heading`}
                className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight text-pw-ink2 leading-tight"
              >
                {scenario.audience}
              </h2>

              <div className="mt-7 grid gap-7">
                <div>
                  <h3 className="text-sm uppercase tracking-[0.16em] text-pw-ember-700 font-medium">
                    Starting point
                  </h3>
                  <p className="mt-2 text-pw-ink2/80 leading-relaxed">
                    {scenario.startingPoint}
                  </p>
                </div>

                <div>
                  <h3 className="text-sm uppercase tracking-[0.16em] text-pw-ember-700 font-medium">
                    Example workflow
                  </h3>
                  <p className="mt-2 text-pw-ink2/80 leading-relaxed">
                    {scenario.workflow}
                  </p>
                </div>

                <div className="rounded-lg border border-pw-ember-500/30 bg-pw-ember-50/40 p-5">
                  <div className="text-xs uppercase tracking-[0.16em] text-pw-ember-700 font-medium">
                    Verification gates
                  </div>
                  <p className="mt-2 text-pw-ink2/80 leading-relaxed">
                    {scenario.verification}
                  </p>
                </div>
              </div>
            </section>
          ))}
        </div>
      </section>

      {/* === Submit your story === */}
      <section className="border-t border-pw-surface bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-3xl mx-auto px-6 py-20 md:py-24">
          <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
            Submit your own
          </div>
          <h2 className="mt-3 text-3xl md:text-5xl font-semibold tracking-tight leading-tight">
            We&apos;d like to write about your migration.
          </h2>
          <p className="mt-5 text-pw-muted-on-ink leading-relaxed">
            If you&apos;ve moved a newsletter to Moosewave and have specific
            numbers we can quote — open rate, deliverability, tooling spend,
            time-to-migrate — we&apos;d love to feature you here. We share
            drafts before publishing and respect &quot;please don&apos;t&quot;
            answers without follow-up.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="mailto:stories@moosewave.com?subject=Customer%20story"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 transition-colors text-white px-4 py-2 text-sm font-medium shadow-[0_2px_0_0_#7A081B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              Email stories@moosewave.com
            </a>
            <Link
              href="/migrations"
              className="inline-flex items-center text-sm font-medium text-white/80 hover:text-white transition-colors px-4 py-2"
            >
              Or migrate first →
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
              Engineering and product blog →
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
              Compare
            </div>
            <Link
              href="/pricing"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              Review the provisional catalog →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
