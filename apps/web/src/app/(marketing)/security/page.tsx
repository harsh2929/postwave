// SPDX-License-Identifier: AGPL-3.0-only
//
// Security + compliance overview. Server component, plain content, no
// client interactivity. We are deliberately careful here: every claim on
// this page should match what the engine actually does. If a section starts
// to drift from reality, fix the engine or weaken the claim — never the
// other way.
import type { Metadata } from "next";
import Link from "next/link";

import { SectionNav } from "@/components/marketing/section-nav";
import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { asRoute } from "@/lib/typed-routes";

const PAGE_URL = "https://moosewave.com/security";
// Visible review date so vendor-diligence reviewers can gauge freshness
// (MKTN-008). Update when the control statements are re-reviewed.
const LAST_REVIEWED = "2026-06-02";
const PAGE_DESCRIPTION =
  "Moosewave's current pre-production security status, implemented application controls, qualification limits, and unsupported compliance claims.";

export const metadata: Metadata = {
  title: "Security and compliance | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave security and compliance",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/security/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave security and compliance",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave security and compliance",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

interface SecuritySection {
  id: string;
  heading: string;
  bullets: string[];
  doc?: { href: string; label: string };
}

const SECTIONS: SecuritySection[] = [
  {
    id: "release-status",
    heading: "Current release status",
    bullets: [
      "Moosewave is in production-readiness qualification. This page does not represent that a generally available customer environment, regional deployment, uptime history, recovery objective, or independent control audit currently exists.",
      "Repository controls and passing tests show what the software implements; they do not prove that a particular deployment is configured, operated, or independently audited correctly.",
      "Before processing customer data, an order should identify the deployed environment, data location, subprocessors, support boundary, incident contact, retention, backup terms, and any service level that actually applies.",
    ],
  },
  {
    id: "application-controls",
    heading: "Implemented application controls",
    bullets: [
      "The application code includes password hashing, server-side revocable sessions, TOTP multi-factor authentication, recovery codes, role and API-scope checks, tenant isolation, CSRF controls for cookie sessions, and bounded abuse controls.",
      "Sensitive application fields support authenticated envelope encryption and external key-management configuration. Deployment owners must provide evidence for the keys, rotation policy, access policy, and storage encryption used in their environment.",
      "The desktop application keeps its API credential in the operating-system credential vault behind a native origin-bound broker. Offline records use authenticated encryption and are scoped to the active credential identity.",
    ],
  },
  {
    id: "transport-and-data",
    heading: "Transport and data handling",
    bullets: [
      "Production configuration is designed to require HTTPS at public and native boundaries. TLS certificates, edge policy, service-to-service encryption, and network isolation remain deployment-specific evidence, not claims established by source code alone.",
      "The product contains bounded request, upload, export, and response paths. Limits vary by route and contract; customers should confirm their expected data volumes during qualification.",
      "No statement on this page promises a particular regional location or transfer mechanism. Those commitments must be recorded in the applicable order and data-processing agreement.",
    ],
  },
  {
    id: "audit-and-privacy",
    heading: "Audit and privacy tooling",
    bullets: [
      "The application includes tenant-scoped audit records, administrative filtering/export, approval controls, consent records, suppression enforcement, data-export workflows, and deletion-request workflows.",
      "These features assist an operator but are not legal advice, a certification, or proof that a customer's collection and processing are lawful. Customers remain responsible for configuring notices, consent, retention, access, and deletion for their use case.",
      "A generated record is compliance evidence only when its deployment, identity, clock, retention, access, and ingestion boundaries have been validated for that environment.",
    ],
  },
  {
    id: "resilience",
    heading: "Backups and resilience",
    bullets: [
      "Moosewave does not publish a contractual uptime SLA, service-credit schedule, recovery point objective, recovery time objective, backup frequency, retention period, or regional failover promise yet. Those terms remain pending measured production evidence and legal approval.",
      "A backup or disaster-recovery claim becomes valid only for an identified environment after scheduled backups, restore isolation, integrity checks, alerting, and a measured restore drill have produced retained evidence.",
      "Any customer-specific availability or recovery commitment must be written into the applicable order after the target environment has passed that qualification.",
    ],
  },
  {
    id: "subprocessors",
    heading: "Subprocessors",
    bullets: [
      "The public subprocessor page is a working draft. The binding list for a customer is the list incorporated into that customer's executed data-processing agreement or order.",
      "Provider use can differ by enabled feature and target environment. Confirm provider, purpose, processing location, transfer mechanism, and optional AI processing before supplying production data.",
    ],
    doc: {
      href: "/legal/sub-processors",
      label: "/legal/sub-processors",
    },
  },
  {
    id: "compliance",
    heading: "Compliance and legal status",
    bullets: [
      "Moosewave is not currently represented as SOC 2, ISO 27001, PCI DSS, HIPAA, GDPR, or CCPA certified. No independent audit firm or completed certification is claimed on this page.",
      "The public privacy, DPA, DPIA, subprocessor, refund, acceptable-use, and terms pages are working drafts pending qualified legal review. They must not be presented as counsel-approved or binding unless incorporated into an executed agreement.",
      "Moosewave does not currently offer a HIPAA business associate agreement. Do not submit protected health information.",
    ],
    doc: { href: "/legal/dpa", label: "Data Processing Addendum" },
  },
  {
    id: "vulnerabilities",
    heading: "Reporting vulnerabilities",
    bullets: [
      "Email security@moosewave.com. Include reproduction steps, affected URLs or API routes, and whether you need coordinated-disclosure credit.",
      "Coordinated disclosure is preferred. No response-time SLA, paid bounty, reward, or public-credit promise applies unless confirmed in writing for the report.",
    ],
  },
];

export default function SecurityPage(): JSX.Element {
  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: "https://moosewave.com" },
    { name: "Security", url: PAGE_URL },
  ]);

  const webPageSchema: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Moosewave security and compliance",
    description: PAGE_DESCRIPTION,
    url: PAGE_URL,
    inLanguage: "en-US",
    isPartOf: {
      "@type": "WebSite",
      name: "Moosewave",
      url: "https://moosewave.com",
    },
    mainEntity: {
      "@type": "Thing",
      name: "Moosewave security posture",
      description:
        "Pre-production security status, implemented application controls, deployment evidence requirements, and unsupported compliance claims.",
    },
  };

  return (
    <div className="bg-pw-paper">
      <JsonLd data={[webPageSchema, breadcrumbs]} id="security-jsonld" />

      {/* === Hero === */}
      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-4xl mx-auto px-6 pt-16 pb-14 md:pt-20 md:pb-20">
          <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
            Security and compliance
          </div>
          <h1 className="mt-3 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Honest about what we do.
            <br />
            Honest about what we don&apos;t.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            This page separates implemented application controls from deployment
            and certification claims. Moosewave is still completing production
            qualification; no unverified regional, resilience, or compliance
            promise is made here.
          </p>
          <p className="mt-4 text-sm text-pw-muted-on-ink/80">
            Last reviewed: {LAST_REVIEWED}
          </p>
        </div>
      </section>

      {/* === Quick TOC with scroll-spy (MKTN-013 / MKTN-017) === */}
      <section
        aria-label="Sections"
        className="border-b border-pw-surface bg-pw-paper/90 backdrop-blur sticky top-14 z-10"
      >
        <div className="max-w-4xl mx-auto px-6 py-3 overflow-x-auto">
          <SectionNav
            ariaLabel="Security sections"
            items={SECTIONS.map((s) => ({ id: s.id, label: s.heading }))}
          />
        </div>
      </section>

      {/* === Sections === */}
      <section className="bg-pw-paper">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-20 space-y-16">
          {SECTIONS.map((s) => (
            <section
              key={s.id}
              id={s.id}
              className="scroll-mt-32"
              aria-labelledby={`${s.id}-heading`}
            >
              <h2
                id={`${s.id}-heading`}
                className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2 leading-tight"
              >
                {s.heading}
              </h2>
              <ul className="mt-5 space-y-4 text-pw-ink2/80 leading-relaxed">
                {s.bullets.map((b, i) => (
                  <li key={i} className="flex gap-3">
                    <span
                      aria-hidden
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-pw-ember-500"
                    />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              {s.doc ? (
                <div className="mt-5">
                  <Link
                    href={asRoute(s.doc.href)}
                    className="inline-flex items-center text-sm font-medium text-pw-ember-700 hover:text-pw-ember-800 transition-colors"
                  >
                    {s.doc.label} →
                  </Link>
                </div>
              ) : null}
            </section>
          ))}
          <p className="text-sm text-pw-muted-on-paper">
            Machine-readable disclosure policy:{" "}
            <a
              href="/.well-known/security.txt"
              className="font-medium text-pw-ember-700 underline underline-offset-4 hover:text-pw-ember-800"
            >
              /.well-known/security.txt
            </a>
            . Report vulnerabilities to{" "}
            <a
              href="mailto:security@moosewave.com"
              className="font-medium text-pw-ember-700 underline underline-offset-4 hover:text-pw-ember-800"
            >
              security@moosewave.com
            </a>
            .
          </p>
        </div>
      </section>

      {/* === Closer / internal linking === */}
      <section className="border-t border-pw-surface bg-pw-surface/40">
        <div className="max-w-4xl mx-auto px-6 py-12 grid gap-8 md:grid-cols-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              Legal documents
            </div>
            <Link
              href="/legal/dpa"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              DPA →
            </Link>
            <Link
              href="/legal/sub-processors"
              className="mt-1 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              Sub-processors →
            </Link>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
              Read the engineering writeups
            </div>
            <Link
              href="/blog"
              className="mt-2 inline-block text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
            >
              The Moosewave blog →
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
        </div>
      </section>
    </div>
  );
}
