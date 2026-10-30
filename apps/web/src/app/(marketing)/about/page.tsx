// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import {
  JsonLd,
  breadcrumbSchema,
  organizationSchema,
} from "@/components/seo/json-ld";
import { publicSiteOrigin } from "@/lib/site-url";

const SITE_URL = publicSiteOrigin();
const PAGE_URL = `${SITE_URL}/about`;
const PAGE_DESCRIPTION =
  "Why Moosewave is being built, what the current source is intended to do, and which claims remain gated by production qualification.";

export const metadata: Metadata = {
  title: "About Moosewave | Production qualification",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "About Moosewave",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: "About Moosewave",
    description: PAGE_DESCRIPTION,
  },
};

const ORGANIZATION_JSON_LD = organizationSchema({
  name: "Moosewave",
  url: SITE_URL,
  logo: `${SITE_URL}/icon.png`,
  description:
    "A pre-production newsletter platform undergoing release qualification.",
  email: "hello@moosewave.com",
  sameAs: [],
});

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: SITE_URL },
  { name: "About", url: PAGE_URL },
]);

const BOUNDARIES = [
  {
    title: "Source is not general availability",
    body: "A route, adapter, test, or generated API entry is not evidence that a capability is enabled in a supported customer environment. The release catalog and deployment evidence control availability.",
  },
  {
    title: "Commercial rights require approved terms",
    body: "Public catalog entries are proposals while checkout is closed. Pricing, refund, continuity, support, and service-level rights arise only from an approved order and the terms presented with it.",
  },
  {
    title: "Provider behavior needs live certification",
    body: "Migration and integration code is qualified with local and contract tests first. A provider-backed capability is not offered until the exact provider account, permissions, limits, failure behavior, and cleanup path have live evidence.",
  },
  {
    title: "Licenses and operations are separate promises",
    body: "Repository license files define source rights. They do not by themselves promise a supported self-host package, hosted continuity, escrow, migration assistance, or shutdown support.",
  },
];

export default function AboutPage(): JSX.Element {
  return (
    <div className="bg-pw-paper">
      <JsonLd data={[ORGANIZATION_JSON_LD, BREADCRUMBS_JSON_LD]} />

      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="mx-auto max-w-4xl px-6 py-20 md:py-28">
          <div className="text-xs font-medium uppercase tracking-widest text-pw-ember-300">
            About Moosewave
          </div>
          <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight md:text-6xl">
            Build the migration first. Earn the launch claim second.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-pw-muted-on-ink md:text-xl">
            Moosewave is being built to make newsletter migration, sending
            operations, and release evidence inspectable. It is still in
            production qualification and is not represented here as generally
            available.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-4xl space-y-16 px-6 py-16 md:py-24">
        <section>
          <h2 className="text-3xl font-semibold tracking-tight text-pw-ink2">
            The product direction
          </h2>
          <div className="mt-6 space-y-5 leading-relaxed text-pw-ink2/80">
            <p>
              Moving a newsletter safely means preserving subscriber state,
              consent evidence, suppressions, mappings, and rebuild work—not
              merely copying rows. Moosewave therefore treats dry runs,
              verification reports, explicit unsupported items, and rollback
              evidence as product behavior.
            </p>
            <p>
              The repository also contains audience, campaign, automation,
              deliverability, drafting, and integration surfaces. Their support
              status is intentionally narrower than their source footprint;
              prospective clients should use the dated release evidence and
              scoped pilot catalog, never infer support from a screenshot or
              source file.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-3xl font-semibold tracking-tight text-pw-ink2">
            Boundaries we publish explicitly
          </h2>
          <ul className="mt-7 grid gap-5 md:grid-cols-2">
            {BOUNDARIES.map((boundary) => (
              <li
                key={boundary.title}
                className="rounded-xl border border-pw-ink2/10 bg-white p-6"
              >
                <h3 className="font-semibold text-pw-ink2">{boundary.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-pw-muted-on-paper">
                  {boundary.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-amber-300 bg-amber-50 p-6">
          <h2 className="text-xl font-semibold text-amber-950">
            Current release status
          </h2>
          <p className="mt-2 leading-relaxed text-amber-950/85">
            Checkout, binding legal terms, provider-backed service commitments,
            and production-readiness claims remain closed &mdash; the published
            legal pages are working drafts pending counsel review, not an
            executed agreement. Synthetic-data evaluation must be explicitly
            scoped and is not a substitute for a production release.
          </p>
          <div className="mt-5 flex flex-wrap gap-4 text-sm font-medium">
            <Link
              href="/roadmap"
              className="text-pw-ember-700 underline underline-offset-4"
            >
              Review qualification status
            </Link>
            <Link
              href="/security"
              className="text-pw-ember-700 underline underline-offset-4"
            >
              Review bounded security claims
            </Link>
            <a
              href="mailto:hello@moosewave.com?subject=Moosewave%20qualification%20review"
              className="text-pw-ember-700 underline underline-offset-4"
            >
              Contact the release owner
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
