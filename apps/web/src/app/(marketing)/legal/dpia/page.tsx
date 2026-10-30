import Link from "next/link";
// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { INFRASTRUCTURE } from "@/lib/legal/infrastructure";

export const metadata: Metadata = {
  title: "DPIA template. Moosewave",
  description:
    "Data Protection Impact Assessment template pre-filled with Moosewave-specific answers, for enterprise procurement use.",
  alternates: { canonical: "https://moosewave.com/legal/dpia" },
};

export default function DpiaPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      {/*
        There is no /legal/dpia.pdf — no file under public/ and no route
        handler — so the "Download PDF" button that used to sit here 404'd, on
        the page an enterprise procurement team is pointed at. The template IS
        the page content below, so printing it is the honest way to get a PDF
        rather than shipping a link to a document that does not exist.
        Guarded by __tests__/static-asset-links.test.ts.
      */}
      <div className="not-prose">
        <h1>Data Protection Impact Assessment (DPIA) template</h1>
      </div>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-04-30. Pending counsel review. This template is
        provided for use by Moosewave customers conducting a DPIA under GDPR
        Article 35 (or equivalent) for their use of Moosewave as a processor.
        Pre-filled with Moosewave-specific answers where applicable.
      </p>

      <h2>How to use</h2>
      <ol>
        <li>
          Copy the content below into your DPIA template, or print this page to
          PDF from your browser.
        </li>
        <li>
          Confirm the pre-filled Moosewave-specific fields match your contracted
          plan.
        </li>
        <li>
          Fill the controller-side fields (your processing context, your risk
          appetite, your DPO sign-off).
        </li>
        <li>Retain a copy with your processing records per Article 30.</li>
      </ol>

      <h2>Section 1. Description of processing</h2>
      <p>
        <strong>Controller:</strong> [Customer organization]
        <br />
        <strong>Processor:</strong> Moosewave (operated by the Moosewave entity
        identified in the master agreement)
        <br />
        <strong>Joint controllers:</strong> None for subscriber data; Moosewave
        acts as independent controller for account / billing data.
      </p>
      <p>
        <strong>Nature of processing:</strong> Moosewave processes personal data
        of the customer&rsquo;s newsletter subscribers (the data subjects) for
        the purpose of sending the customer&rsquo;s marketing and editorial
        email content, managing consent state, applying segmentation, executing
        automation sequences, and providing engagement analytics back to the
        customer.
      </p>
      <p>
        <strong>Categories of data subjects:</strong> Newsletter subscribers,
        end customers (where the controller uses Moosewave for transactional /
        lifecycle email).
      </p>
      <p>
        <strong>Categories of personal data:</strong>
      </p>
      <ul>
        <li>Email address (mandatory)</li>
        <li>Name (optional, customer-supplied)</li>
        <li>Custom field values (customer-supplied; varies)</li>
        <li>
          Behavioral data: open, click, bounce, unsubscribe, complaint events
        </li>
        <li>
          Consent state and timestamp (where supplied at import or capture)
        </li>
        <li>IP address (at consent capture and engagement events)</li>
        <li>User agent (at engagement events)</li>
      </ul>
      <p>
        <strong>Special-category data:</strong> Moosewave does not intentionally
        process special-category data under Article 9. Customers who choose to
        use custom fields for such data must obtain Article 9 lawful basis
        themselves.
      </p>

      <h2>Section 2. Necessity and proportionality</h2>
      <p>
        <strong>Lawful basis (controller-side):</strong> typically consent (GDPR
        Art. 6(1)(a)) for marketing newsletters; legitimate interests (Art.
        6(1)(f)) where applicable for transactional or service-context email.
        Determined by controller.
      </p>
      <p>
        <strong>Data minimization:</strong> Moosewave requires only the email
        address as a mandatory field. All other fields are controller-supplied
        and controller-controlled. Behavioral data is collected only for
        engagement metrics the controller has chosen to receive.
      </p>
      <p>
        <strong>Purpose limitation:</strong> Moosewave processes data only on
        documented controller instructions per Article 28. Open-tracking and
        click-tracking are controlled per campaign in the campaign editor, which
        suppresses that tracking for the send. The IP address recorded with an
        engagement observation cannot be switched off, but it is not kept: 90
        days after the event it is erased along with the request headers and the
        TLS fingerprint, while the network ASN is retained so a later
        reclassification can still reach a verdict without the identifying
        material.
      </p>
      <p>
        <strong>Storage limitation:</strong> Engagement events default to a
        12-month retention window; controllers can configure it from 30 days up
        to 7 years in Settings &rarr; Privacy. On account termination, all
        controller data is deleted within 30 days.
      </p>

      <h2>Section 3. Risks to data subjects</h2>
      <div
        role="region"
        aria-label="Risk assessment matrix"
        tabIndex={0}
        className="not-prose overflow-x-auto rounded-lg border border-pw-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
      >
        <table className="min-w-[36rem] text-sm">
          <thead className="bg-pw-surface">
            <tr>
              <th scope="col" className="p-3 text-left font-medium">
                Risk
              </th>
              <th scope="col" className="p-3 text-left font-medium">
                Likelihood
              </th>
              <th scope="col" className="p-3 text-left font-medium">
                Severity
              </th>
              <th scope="col" className="p-3 text-left font-medium">
                Inherent rating
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-pw-line">
              <td className="p-3">
                Unauthorized disclosure of subscriber email list
              </td>
              <td className="p-3">Low</td>
              <td className="p-3">Medium</td>
              <td className="p-3">Medium</td>
            </tr>
            <tr className="border-t border-pw-line">
              <td className="p-3">Loss of subscriber data</td>
              <td className="p-3">Low</td>
              <td className="p-3">Medium</td>
              <td className="p-3">Low–Medium</td>
            </tr>
            <tr className="border-t border-pw-line">
              <td className="p-3">Unlawful third-country transfer</td>
              <td className="p-3">Low</td>
              <td className="p-3">Medium</td>
              <td className="p-3">Low</td>
            </tr>
            <tr className="border-t border-pw-line">
              <td className="p-3">Profiling beyond stated purpose</td>
              <td className="p-3">Very low</td>
              <td className="p-3">Low</td>
              <td className="p-3">Very low</td>
            </tr>
            <tr className="border-t border-pw-line">
              <td className="p-3">Sub-processor breach</td>
              <td className="p-3">Low</td>
              <td className="p-3">Medium</td>
              <td className="p-3">Medium</td>
            </tr>
            <tr className="border-t border-pw-line">
              <td className="p-3">Inability to honor data-subject rights</td>
              <td className="p-3">Very low</td>
              <td className="p-3">Medium</td>
              <td className="p-3">Low</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Section 4. Mitigations</h2>
      <ul>
        <li>
          <strong>Encryption in transit:</strong> TLS 1.2+ on all network paths;
          TLS 1.3 preferred.
        </li>
        <li>
          <strong>Encryption at rest:</strong> {INFRASTRUCTURE.encryptionAtRest}
          .
        </li>
        <li>
          <strong>Access controls:</strong> Role-based access for Moosewave
          personnel; least-privilege defaults; multi-factor authentication
          enforced.
        </li>
        <li>
          <strong>Audit logging:</strong> All controller-data access by Moosewave
          personnel is logged and retained for the account&rsquo;s configured
          audit-log window (default 90 days, configurable from 7 days up to 7
          years).
        </li>
        <li>
          <strong>Network segregation:</strong> Production environment isolated
          from development / staging; no direct database access from developer
          workstations.
        </li>
        <li>
          <strong>Sub-processor screening:</strong> All sub-processors listed in
          our <Link href="/legal/sub-processors">sub-processor register</Link>{" "}
          have signed DPAs and SCCs as appropriate.
        </li>
        <li>
          <strong>International transfers:</strong> EU SCCs (2021) incorporated
          into all third-country sub-processor agreements; UK IDTA addendum
          where applicable.
        </li>
        <li>
          <strong>Breach notification:</strong> Moosewave commits to notifying
          controllers within 72 hours of becoming aware of a personal-data
          breach affecting their data.
        </li>
        <li>
          <strong>Backups:</strong> Encrypted, geographically redundant, tested
          quarterly.
        </li>
        <li>
          <strong>Incident response:</strong> Documented runbook with on-call
          rotation; post-incident reviews shared with controllers on request.
        </li>
      </ul>

      <h2>Section 5. Data subject rights mechanisms</h2>
      <p>
        Moosewave provides controllers with self-service tools to respond to data
        subject requests within the GDPR / DPDP Act timelines:
      </p>
      <ul>
        <li>
          <strong>Right of access (Art. 15):</strong> Per-subscriber export
          available via the Subscribers UI and the public REST API.
        </li>
        <li>
          <strong>Right to rectification (Art. 16):</strong> Inline editing in
          the Subscribers UI; programmatic via API.
        </li>
        <li>
          <strong>Right to erasure (Art. 17):</strong> The{" "}
          <strong>Erase</strong> action in the Subscribers UI wipes all data
          including historical engagement events; a suppression-list entry is
          retained as a hash so the subscriber is not re-imported. Erase is
          irreversible &mdash; <strong>Archive</strong> is the reversible
          alternative where the controller does not intend Art. 17 erasure.
        </li>
        <li>
          <strong>Right to restriction (Art. 18):</strong> Blocklisting a
          subscriber stops further processing for sending purposes while
          retaining the record. There is no separate processing-pause flag, so
          restriction requests that go beyond suppression are handled with
          Moosewave&rsquo;s assistance rather than self-service.
        </li>
        <li>
          <strong>Right to portability (Art. 20):</strong> JSON / CSV export per
          subscriber.
        </li>
        <li>
          <strong>Right to object (Art. 21):</strong> Unsubscribe link injected
          into every commercial message and honored in real time.
        </li>
        <li>
          <strong>Automated decision-making (Art. 22):</strong> No fully
          automated decisions with legal effect on subscribers. Voice AI
          generation is recommended-only and requires controller approval before
          sending.
        </li>
      </ul>

      <h2>Sign-off</h2>
      <p>
        <strong>DPO / Privacy Officer (controller):</strong>{" "}
        ____________________ Date: __________
        <br />
        <strong>Senior accountable owner (controller):</strong>{" "}
        ____________________ Date: __________
      </p>

      <p className="text-pw-muted-on-paper text-xs">
        For supplemental information not covered above (penetration test
        summaries, SOC 2 reports when available, security questionnaires, custom
        DPA addenda), contact{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>.
      </p>
    </article>
  );
}
