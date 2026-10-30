// SPDX-License-Identifier: AGPL-3.0-only
//
// Technical and organisational measures (GDPR Art. 32), published because the
// DPA incorporates them by reference.
//
// WHY THIS PAGE EXISTS. DPA Annex 2 and the standard support macro both told
// customers the TOM document was at https://moosewave.com/legal/tom. It was not:
// the only TOM document was docs/privacy/tom.md, internal to the repository. A
// DPA that incorporates a document by reference to a URL that 404s does not
// incorporate anything, and the customer's privacy reviewer has no way to
// assess the Art. 32 measures they are being asked to accept.
//
// The infrastructure facts here are imported rather than written, so this page
// cannot drift from the sub-processor register and the DPA the way the previous
// generation of legal copy did. See @/lib/legal/infrastructure.
import Link from "next/link";
import type { Metadata } from "next";

import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import {
  INFRASTRUCTURE,
  LEGAL_FACTS_VERSION,
  SUBPROCESSORS_PATH,
} from "@/lib/legal/infrastructure";

const PAGE_URL = "https://moosewave.com/legal/tom";
const PAGE_DESCRIPTION =
  "The technical and organisational measures Moosewave applies under GDPR Article 32, incorporated into the Data Processing Addendum as Annex 2.";

export const metadata: Metadata = {
  title: "Technical and organisational measures | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true, "max-snippet": -1 },
  openGraph: {
    type: "article",
    url: PAGE_URL,
    title: "Moosewave technical and organisational measures",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
  },
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Technical and organisational measures", url: PAGE_URL },
]);

export default function TomPage(): JSX.Element {
  return (
    <article className="max-w-4xl mx-auto px-6 py-16">
      <JsonLd data={BREADCRUMBS_JSON_LD} />
      <h1>Technical and organisational measures</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: {LEGAL_FACTS_VERSION}. Pending counsel review. This
        document is Annex 2 to the{" "}
        <Link href="/legal/dpa">Data Processing Addendum</Link> and is
        incorporated into it by reference.
      </p>

      <p>
        These are the measures Moosewave applies under Article 32 of the GDPR to
        protect Customer Personal Data. They describe what the platform actually
        does; where a measure is a commitment rather than a current control, it
        says so.
      </p>

      <h2>1. Platform and hosting</h2>
      <p>
        Moosewave Cloud runs on {INFRASTRUCTURE.cloudProvider} in{" "}
        {INFRASTRUCTURE.primaryRegion}. {INFRASTRUCTURE.compute} runs the
        application, {INFRASTRUCTURE.database} holds application data,{" "}
        {INFRASTRUCTURE.objectStorage} holds objects, and{" "}
        {INFRASTRUCTURE.secrets} holds credentials. {INFRASTRUCTURE.edge}.
      </p>
      <p>
        Moosewave operates no data centre of its own. Physical and environmental
        security is provided by AWS under the controls attested in its ISO 27001
        and SOC 2 reports. The full recipient list, with regions and transfer
        bases, is on the{" "}
        <Link href={SUBPROCESSORS_PATH}>sub-processors page</Link>.
      </p>

      <h2>2. Confidentiality</h2>
      <h3>2.1 Tenant isolation</h3>
      <p>
        Tenant isolation is enforced by the database, not only by application
        code. Every multi-tenant table carries PostgreSQL row-level security
        keyed on the request&rsquo;s tenant identifier, so a query that omits or
        forges the tenant filter returns nothing rather than another
        customer&rsquo;s rows. The isolation policies are covered by
        database-backed tests that run against a non-superuser role, because a
        superuser connection bypasses RLS and would make those tests pass
        vacuously.
      </p>
      <h3>2.2 Access control</h3>
      <ul>
        <li>
          Role-based access with least-privilege defaults for both customer
          users and Moosewave personnel.
        </li>
        <li>
          Multi-factor authentication is enforced for all production access.
        </li>
        <li>
          Sensitive operations require step-up re-authentication independently
          of session age.
        </li>
        <li>
          Per-tenant API key scoping; every request is authorised against the
          tenant it names.
        </li>
        <li>No direct database access from developer workstations.</li>
      </ul>
      <h3>2.3 Encryption</h3>
      <ul>
        <li>
          <strong>At rest:</strong> {INFRASTRUCTURE.encryptionAtRest}.
        </li>
        <li>
          <strong>In transit:</strong> {INFRASTRUCTURE.encryptionInTransit}.
          HSTS is enabled on public endpoints.
        </li>
        <li>
          Secrets are held in a dedicated secret manager and are never present
          in source control or in logs.
        </li>
      </ul>

      <h2>3. Integrity</h2>
      <ul>
        <li>
          Personnel access to Customer Personal Data is audit-logged. Logs are
          retained for the account&rsquo;s configured audit window (default 90
          days, configurable from 7 days to 7 years) and beyond it where an
          entry is under legal hold.
        </li>
        <li>
          Audit records can be mirrored to a customer-controlled sink with a
          Merkle-chained integrity proof, so tampering with the copy Moosewave
          holds is detectable by the customer.
        </li>
        <li>
          Free-text and custom fields are scanned for undeclared personal data
          so that the processing record and the retention model stay accurate.
        </li>
        <li>
          Personal data is redacted from error reports and product telemetry
          before transmission.
        </li>
      </ul>

      <h2>4. Availability and resilience</h2>
      <ul>
        <li>Encrypted, geographically redundant backups.</li>
        <li>
          Point-in-time recovery, with restore exercises run against an isolated
          environment.
        </li>
        <li>
          A documented disaster-recovery runbook with measured recovery point
          and recovery time objectives.
        </li>
        <li>
          Production is segregated from development and staging; egress from
          production is allowlisted per sub-processor endpoint.
        </li>
      </ul>

      <h2>5. Application security</h2>
      <ul>
        <li>Code review is required for every change to production code.</li>
        <li>
          Dependency, container and static-analysis scanning run in continuous
          integration, with high-severity findings blocking the build.
        </li>
        <li>
          Release artefacts are signed, and only verified digests are promoted
          to production.
        </li>
        <li>
          Mobile over-the-air updates are cryptographically signed; the build
          refuses to configure an unsigned update channel for any
          non-development profile.
        </li>
        <li>
          A published vulnerability disclosure policy at{" "}
          <a href="/.well-known/security.txt" rel="noopener noreferrer">
            /.well-known/security.txt
          </a>
          .
        </li>
      </ul>

      <h2>6. Data minimisation and retention</h2>
      <ul>
        <li>
          Each data class has an enforced retention window with a purge worker
          behind it, not merely a configurable number in a settings page.
        </li>
        <li>
          Retention windows are configurable per workspace within bounds set by
          the platform.
        </li>
        <li>
          Erasure is verified by proving the subject&rsquo;s absence from every
          store named in the erasure inventory, rather than by asserting that
          the erasure job ran.
        </li>
      </ul>

      <h2>7. Personnel</h2>
      <ul>
        <li>
          All personnel with access to Customer Personal Data are bound by
          confidentiality obligations.
        </li>
        <li>Background checks for production access, per applicable law.</li>
        <li>Annual security and privacy training.</li>
      </ul>

      <h2>8. Incident response</h2>
      <p>
        Moosewave maintains a documented incident-response runbook with an
        on-call rotation. A personal-data breach opens an incident record that
        starts the Article 33 notification clock, records the affected data
        categories and tenants, and produces the notification packets for the
        supervisory authority, affected controllers and affected data subjects.
        As a processor, Moosewave notifies affected controllers without undue
        delay after becoming aware of a breach; see{" "}
        <Link href="/legal/dpa">DPA</Link> §9.
      </p>

      <h2>9. Review</h2>
      <p>
        These measures are reviewed at least annually and whenever the platform
        architecture changes materially. The infrastructure facts on this page
        are generated from a single register shared with the{" "}
        <Link href={SUBPROCESSORS_PATH}>sub-processors page</Link>, the{" "}
        <Link href="/legal/dpa">DPA</Link> and the{" "}
        <Link href="/legal/privacy">Privacy Policy</Link>, so those documents
        cannot disagree with each other about where data lives.
      </p>

      <p>
        Questions:{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>
      </p>
    </article>
  );
}
