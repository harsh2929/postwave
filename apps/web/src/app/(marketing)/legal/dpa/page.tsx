import Link from "next/link";
// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical domain: moosewave.com. See docs/legal-pages-audit-2026-06-02.md
// (Blocker §1). Use moosewave.com for all URLs, canonical, breadcrumbs, and
// support email aliases on every legal page.
//
// SEO intent: legal page; intentionally low-weight. Crawlable + canonical +
// breadcrumb only; max-snippet:-1 so AIO can quote policy text accurately.
import type { Metadata } from "next";

import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import { INFRASTRUCTURE } from "@/lib/legal/infrastructure";

const PAGE_URL = "https://moosewave.com/legal/dpa";
const PAGE_DESCRIPTION =
  "Moosewave's GDPR / UK GDPR / DPDP Act-aligned Data Processing Addendum, including SCCs, technical and organizational measures, and sub-processor terms.";

export const metadata: Metadata = {
  title: "Data Processing Addendum (DPA) | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: {
    index: true,
    follow: true,
    "max-snippet": -1,
  },
  openGraph: {
    type: "article",
    url: PAGE_URL,
    title: "Moosewave Data Processing Addendum",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/legal/dpa/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave Data Processing Addendum",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave Data Processing Addendum",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Data Processing Addendum", url: PAGE_URL },
]);

export default function DpaPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <JsonLd data={BREADCRUMBS_JSON_LD} />
      <h1>Data Processing Addendum</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-06-02. This is a working draft pending counsel
        review. This DPA supplements and is incorporated into the{" "}
        <Link href="/legal/terms">Moosewave Terms of Service</Link> (the
        &quot;Agreement&quot;). On execution, it forms a binding addendum
        between Moosewave and Customer governing the processing of Customer
        Personal Data.
      </p>

      <h2>1. Definitions</h2>
      <ul>
        <li>
          <strong>&quot;Applicable Data Protection Law&quot;</strong> means: (i)
          the EU General Data Protection Regulation (Regulation 2016/679,
          &quot;EU GDPR&quot;); (ii) the UK GDPR and the UK Data Protection Act
          2018 (&quot;UK GDPR&quot;); (iii) the Swiss Federal Act on Data
          Protection; (iv) the California Consumer Privacy Act / CPRA; (v)
          India&rsquo;s Digital Personal Data Protection Act 2023
          (&quot;DPDP&quot;); and (vi) other privacy laws applicable to the
          processing.
        </li>
        <li>
          <strong>&quot;Controller&quot;</strong>,{" "}
          <strong>&quot;Processor&quot;</strong>,{" "}
          <strong>&quot;Personal Data&quot;</strong>,{" "}
          <strong>&quot;Processing&quot;</strong>,{" "}
          <strong>&quot;Data Subject&quot;</strong>,{" "}
          <strong>&quot;Personal Data Breach&quot;</strong>, and{" "}
          <strong>&quot;Sub-processor&quot;</strong> have the meanings ascribed
          in the EU GDPR (and, for jurisdictions where terminology differs, the
          equivalent terms, e.g. <em>Data Fiduciary</em> and{" "}
          <em>Data Processor</em> under DPDP).
        </li>
        <li>
          <strong>&quot;Customer Personal Data&quot;</strong> means Personal
          Data that Moosewave processes on behalf of Customer in the course of
          providing the Service.
        </li>
        <li>
          <strong>&quot;SCCs&quot;</strong> means the Standard Contractual
          Clauses approved by the European Commission in Decision 2021/914, as
          updated.
        </li>
        <li>
          <strong>&quot;UK Addendum&quot;</strong> means the UK International
          Data Transfer Addendum to the SCCs issued by the UK Information
          Commissioner.
        </li>
        <li>
          <strong>&quot;TOMs&quot;</strong> means the technical and
          organizational measures described in Annex 2.
        </li>
      </ul>

      <h2>2. Subject matter and duration</h2>
      <p>
        The subject matter of the Processing is the provision of the Service to
        Customer pursuant to the Agreement. The duration of Processing
        corresponds to the term of the Agreement, plus such additional period as
        is necessary for return / deletion of Customer Personal Data in
        accordance with Section 13.
      </p>

      <h2>3. Nature and purpose of processing</h2>
      <p>
        Moosewave processes Customer Personal Data to deliver the Service:
        storing subscribers and consent state, executing send campaigns and
        automation sequences, applying segmentation, recording engagement
        events, generating deliverability and analytics reports, generating
        Voice AI sequence drafts on Customer&rsquo;s instruction, and providing
        related support.
      </p>

      <h2>4. Categories of Data Subjects</h2>
      <p>
        Newsletter subscribers, end customers, and other natural persons whose
        Personal Data Customer chooses to upload to or capture through the
        Service.
      </p>

      <h2>5. Categories of Personal Data</h2>
      <p>
        Email address (mandatory); name (optional); custom field values defined
        by Customer; consent state and timestamp; IP address; user agent;
        engagement events (open, click, bounce, unsubscribe, complaint,
        conversion if instrumented). Customer is responsible for ensuring it
        does not upload special-category data (Article 9 of the EU GDPR) without
        appropriate lawful basis.
      </p>

      <h2>6. Roles</h2>
      <p>
        Customer is the Controller of Customer Personal Data. Moosewave is the
        Processor acting on Customer&rsquo;s documented instructions. Moosewave
        is an independent Controller for account, billing, security, and
        product-usage data, governed by the{" "}
        <Link href="/legal/privacy">Privacy Policy</Link>.
      </p>

      <h2>7. Processor obligations</h2>
      <h3>7.1 Documented instructions</h3>
      <p>
        Moosewave processes Customer Personal Data only on Customer&rsquo;s
        documented instructions, including with regard to international
        transfers. The Agreement, this DPA, and Customer&rsquo;s use of the
        Service constitute Customer&rsquo;s documented instructions. Customer
        may give additional instructions in writing; Moosewave will inform
        Customer if it considers an instruction infringes Applicable Data
        Protection Law.
      </p>
      <h3>7.2 Confidentiality</h3>
      <p>
        Moosewave ensures persons authorized to process Customer Personal Data
        are subject to a duty of confidentiality and access only on a
        need-to-know basis.
      </p>
      <h3>7.3 Security</h3>
      <p>
        Moosewave implements the TOMs in Annex 2, appropriate to the risk.
        Customer agrees the TOMs provide a level of security appropriate to the
        risk and the nature of Customer Personal Data.
      </p>
      <h3>7.4 Sub-processors (general written authorization)</h3>
      <p>
        Customer grants Moosewave general written authorization to engage
        Sub-processors. The current list is at{" "}
        <Link href="/legal/sub-processors">/legal/sub-processors</Link> and
        forms Annex 3. Moosewave will give Customer at least 30 days&rsquo; prior
        notice (via the account-owner email) of new Sub-processors. Customer may
        object on reasonable data protection grounds within 15 days of notice.
        If the parties cannot resolve the objection in good faith, Customer may
        terminate the affected portion of the Service and receive a prorated
        refund of any unused prepaid recurring fees.
      </p>
      <h3>7.5 Sub-processor terms</h3>
      <p>
        Moosewave imposes data protection obligations on each Sub-processor that
        are no less protective than those in this DPA, by way of a written
        contract. Moosewave remains liable to Customer for the performance of
        Sub-processor obligations.
      </p>
      <h3>7.6 Audit rights</h3>
      <p>
        On Customer&rsquo;s reasonable written request and no more than once per
        calendar year (or more frequently if required by Applicable Data
        Protection Law or following a Personal Data Breach), Moosewave will make
        available evidence of compliance with this DPA. This evidence may
        include:
      </p>
      <ul>
        <li>third-party audit reports (e.g. SOC 2 Type II once available);</li>
        <li>
          summary results of penetration tests (made available under NDA);
        </li>
        <li>
          completed security questionnaires from Moosewave&rsquo;s standard set;
        </li>
        <li>
          on-site or virtual audit rights for Customers with regulatory
          obligations requiring direct audit, subject to reasonable notice (≥30
          days), confidentiality, and non-disruption to Moosewave&rsquo;s
          operations.
        </li>
      </ul>
      <h3>7.7 Breach notification</h3>
      <p>
        Moosewave will notify Customer without undue delay and in any event
        within 72 hours of becoming aware of a Personal Data Breach affecting
        Customer Personal Data. The notice will include (to the extent known)
        the nature of the breach, categories and approximate number of Data
        Subjects and records affected, likely consequences, measures taken or
        proposed, and the contact point for further information. Moosewave will
        provide reasonable cooperation with Customer&rsquo;s breach-notification
        obligations.
      </p>
      <h3>7.8 Assistance with Data Subject rights</h3>
      <p>
        Moosewave will assist Customer in responding to Data Subject requests by
        providing self-service tooling &mdash; per-subscriber export and
        deletion requests, inline rectification, and blocklisting to stop
        further processing for sending purposes &mdash; and reasonable
        additional cooperation where the tooling is insufficient, including for
        restriction requests under Article 18 that the tooling does not cover
        directly. Direct Data Subject requests received by Moosewave will be
        referred to the Customer.
      </p>
      <h3>7.9 Data Protection Impact Assessment</h3>
      <p>
        Moosewave will provide reasonable assistance with Customer&rsquo;s DPIA
        obligations and prior consultation with supervisory authorities. A
        pre-filled DPIA template is published at{" "}
        <Link href="/legal/dpia">/legal/dpia</Link>.
      </p>

      <h2>8. International transfers</h2>
      <p>
        Where Moosewave transfers Customer Personal Data from the EEA, UK, or
        Switzerland to a third country without an adequacy decision, the SCCs
        (Module Two: Controller-to-Processor) and, where applicable, the UK
        Addendum, are incorporated into this DPA by reference. The parties agree
        to the SCCs as set out in Annex 4.
      </p>
      <p>
        For DPDP transfers, Moosewave complies with the cross-border transfer
        rules notified by the Indian central government from time to time.
      </p>

      <h2>9. Special categories of data</h2>
      <p>
        Moosewave is not designed for processing special-category data (Article 9
        of the EU GDPR). Customer agrees not to upload such data unless it has
        an appropriate lawful basis and has notified Moosewave so additional
        safeguards can be assessed.
      </p>

      <h2>10. Personnel</h2>
      <p>
        All Moosewave personnel with access to Customer Personal Data are bound
        by confidentiality, undergo background checks per applicable law,
        complete annual security and privacy training, and use multi-factor
        authentication for all production access. Production access is logged
        and reviewed quarterly.
      </p>

      <h2>11. CCPA / CPRA addendum</h2>
      <p>
        For Customer Personal Data subject to the CCPA / CPRA, the parties
        acknowledge that Moosewave is a &quot;Service Provider&quot; processing
        Personal Information on Customer&rsquo;s behalf for the limited and
        specified Business Purposes set out in the Agreement. Moosewave will not
        (a) sell or share such Personal Information; (b) retain, use, or
        disclose it outside the direct business relationship; or (c) combine it
        with Personal Information from other sources except as permitted under
        the CCPA.
      </p>

      <h2>12. Term</h2>
      <p>
        This DPA enters into force on the date of acceptance of the Agreement
        and remains in force for as long as Moosewave processes Customer Personal
        Data.
      </p>

      <h2>13. Termination, return or deletion of data</h2>
      <p>
        On termination of the Agreement, Moosewave will, at Customer&rsquo;s
        choice, delete or return Customer Personal Data within 30 days of
        termination, unless retention is required by Applicable Data Protection
        Law (in which case Moosewave will continue to protect the data and limit
        further processing to that retention purpose). Customer may export data
        at any time during the term via the in-app export tools and the public
        REST API.
      </p>

      <h2>14. Liability</h2>
      <p>
        Each party&rsquo;s liability arising out of or related to this DPA is
        subject to the exclusions and limitations of liability set out in the
        Agreement. Where Applicable Data Protection Law imposes joint and
        several liability on the parties to a Data Subject, the parties&rsquo;
        allocation of responsibility between themselves remains subject to those
        exclusions and limitations.
      </p>

      <h2>15. Governing law</h2>
      <p>
        This DPA is governed by the law specified in the Agreement. Where the
        SCCs apply, the SCCs are governed by the law of an EEA Member State that
        allows third-party-beneficiary rights per the Commission&rsquo;s
        requirements; the parties select the law of Ireland for that purpose.
      </p>

      <h2>16. Order of precedence</h2>
      <p>
        In case of conflict, the SCCs prevail over this DPA, and this DPA
        prevails over the rest of the Agreement, with respect to the Processing
        of Customer Personal Data.
      </p>

      <h2>17. Signature</h2>
      <p>
        This DPA is accepted by Customer&rsquo;s acceptance of the Agreement.
        Customers requiring a counter-signed PDF for procurement records may
        request one at{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>; Moosewave
        will counter-sign within five business days.
      </p>

      <hr />

      <h2>Annex 1. Description of Processing</h2>
      <ul>
        <li>
          <strong>Subject matter:</strong> Provision of the Moosewave Service.
        </li>
        <li>
          <strong>Duration:</strong> Term of the Agreement plus the deletion /
          return window in Section 13.
        </li>
        <li>
          <strong>Nature and purpose:</strong> as described in Section 3.
        </li>
        <li>
          <strong>Categories of Data Subjects:</strong> as described in Section
          4.
        </li>
        <li>
          <strong>Categories of Personal Data:</strong> as described in Section
          5.
        </li>
        <li>
          <strong>Frequency of transfer:</strong> continuous, as dictated by
          Customer&rsquo;s use of the Service.
        </li>
        <li>
          <strong>Retention:</strong> per the Privacy Policy retention schedule
          and any Customer-configured overrides.
        </li>
      </ul>

      <h2>Annex 2. Technical and Organizational Measures (TOMs)</h2>
      <h3>Access control</h3>
      <ul>
        <li>Role-based access control with least-privilege defaults.</li>
        <li>
          Multi-factor authentication required for all personnel access to
          production.
        </li>
        <li>
          Production access requires named-individual SSH keys; shared
          credentials prohibited.
        </li>
        <li>
          Customer-facing authentication via Moosewave first-party auth, with MFA
          available to all customers and required for Scale workspaces.
        </li>
      </ul>
      <h3>Encryption</h3>
      <ul>
        <li>{INFRASTRUCTURE.encryptionInTransit}; HSTS enabled.</li>
        <li>{INFRASTRUCTURE.encryptionAtRest}.</li>
        <li>
          Secrets stored in dedicated secret manager; not present in source
          control or logs.
        </li>
      </ul>
      <h3>Network security</h3>
      <ul>
        <li>
          Cloudflare WAF and DDoS mitigation in front of public endpoints.
        </li>
        <li>Production network segregated from development and staging.</li>
        <li>No direct database access from developer workstations.</li>
        <li>Egress allowlists for Sub-processor endpoints.</li>
      </ul>
      <h3>Application security</h3>
      <ul>
        <li>Code review required for all changes to production code.</li>
        <li>
          Dependency vulnerability scanning in CI; high-severity findings
          blocking.
        </li>
        <li>Static analysis on all proprietary services.</li>
        <li>Annual third-party penetration test (V2 onward).</li>
      </ul>
      <h3>Operational security</h3>
      <ul>
        <li>
          Audit logging of personnel access to Customer Personal Data; logs
          retained for the account&rsquo;s configured audit-log window (default
          90 days, configurable from 7 days up to 7 years), and beyond it where
          an entry is under legal hold.
        </li>
        <li>
          Background checks for personnel with production access (per applicable
          law).
        </li>
        <li>Annual security and privacy training.</li>
        <li>Documented incident response runbook with on-call rotation.</li>
        <li>
          Encrypted geographically redundant backups; quarterly restore tests.
        </li>
      </ul>
      <h3>Physical security</h3>
      <ul>
        <li>
          Production hosting in {INFRASTRUCTURE.cloudProvider}{" "}
          {INFRASTRUCTURE.primaryRegion} data centres, under the physical and
          environmental controls attested in AWS&rsquo;s ISO 27001 and SOC 2
          reports. Moosewave operates no data centre of its own.
        </li>
      </ul>
      <h3>Data segregation</h3>
      <ul>
        <li>Multi-tenant Postgres with row-level security by tenant.</li>
        <li>
          Per-tenant API authentication and authorization on every request.
        </li>
        <li>Per-tenant DKIM signing domain for sending traffic.</li>
      </ul>
      <h3>Vendor management</h3>
      <ul>
        <li>
          Sub-processors selected based on documented security posture and
          regulatory alignment.
        </li>
        <li>
          Written DPAs and SCCs (where applicable) on file for every
          Sub-processor.
        </li>
        <li>Annual review of Sub-processor list and posture.</li>
      </ul>

      <h2>Annex 3. Sub-processor list</h2>
      <p>
        The current Sub-processor list is published at{" "}
        <Link href="/legal/sub-processors">/legal/sub-processors</Link> and is
        updated as Sub-processors are added, removed, or change scope. The
        published list at any given time forms part of this DPA.
      </p>

      <h2>Annex 4. Standard Contractual Clauses</h2>
      <p>
        Where the SCCs apply (Module Two: Controller-to-Processor), the parties
        select the following options:
      </p>
      <ul>
        <li>
          <strong>Clause 7 (Docking clause):</strong> applicable.
        </li>
        <li>
          <strong>Clause 9(a) (Sub-processors):</strong> Option 2. general
          written authorization, with at least 30 days&rsquo; notice as set out
          in Section 7.4 above.
        </li>
        <li>
          <strong>Clause 11 (Redress):</strong> the optional language on
          independent-dispute-resolution body is <em>not</em> selected.
        </li>
        <li>
          <strong>Clause 17 (Governing law):</strong> the laws of Ireland.
        </li>
        <li>
          <strong>Clause 18 (Choice of forum):</strong> the courts of Ireland.
        </li>
        <li>
          <strong>Annex I.A (Parties):</strong> Customer (data exporter) as
          identified in the Agreement; Moosewave (data importer) as identified in
          Section 1 of the Privacy Policy.
        </li>
        <li>
          <strong>Annex I.B (Description of transfer):</strong> as described in
          Annex 1 of this DPA.
        </li>
        <li>
          <strong>Annex I.C (Competent supervisory authority):</strong> the
          Irish Data Protection Commission, unless Applicable Data Protection
          Law mandates otherwise.
        </li>
        <li>
          <strong>Annex II (Technical and Organizational Measures):</strong> as
          set out in Annex 2 of this DPA.
        </li>
        <li>
          <strong>Annex III (Sub-processors):</strong> as published per Annex 3
          of this DPA.
        </li>
      </ul>
      <p>
        For UK transfers, the UK Addendum is incorporated and modifies the SCCs
        as required by the UK Information Commissioner.
      </p>

      <p className="text-pw-muted-on-paper text-xs mt-10">
        This is a working draft pending counsel review. Last updated:
        2026-06-02.
      </p>
    </article>
  );
}
