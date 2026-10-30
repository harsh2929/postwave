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
import {
  INFRASTRUCTURE,
  SUBPROCESSORS_PATH,
} from "@/lib/legal/infrastructure";

const PAGE_URL = "https://moosewave.com/legal/privacy";
const PAGE_DESCRIPTION =
  "How Moosewave collects, uses, shares, and protects personal data. Per-data-type retention. Data subject rights. Sub-processor list.";

export const metadata: Metadata = {
  title: "Privacy Policy | Moosewave",
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
    title: "Moosewave Privacy Policy",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/legal/privacy/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave Privacy Policy",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave Privacy Policy",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Privacy Policy", url: PAGE_URL },
]);

export default function PrivacyPolicyPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <JsonLd data={BREADCRUMBS_JSON_LD} />
      <h1>Privacy Policy</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-06-02. This is a working draft pending counsel
        review.
      </p>

      <h2>1. Who we are</h2>
      <p>
        Moosewave is operated by Moosewave Inc. (a Delaware corporation) for
        global customers, and by Moosewave Technologies Pvt. Ltd. (Bengaluru,
        Karnataka, India) for customers contracted under the India entity.
        Wherever this policy refers to <strong>&quot;Moosewave&quot;</strong>,{" "}
        <strong>&quot;we&quot;</strong>, or <strong>&quot;our&quot;</strong>, it
        means the operating entity that contracts with you.
      </p>
      <p>
        This Privacy Policy explains what personal data we collect, why, how we
        use it, who we share it with, how long we keep it, and what rights you
        have. It applies to:
      </p>
      <ul>
        <li>
          visitors to <code>moosewave.com</code> and its sub-paths;
        </li>
        <li>Moosewave customers and their authorized users;</li>
        <li>
          subscribers whose data customers process through the Service (where
          Moosewave acts as a processor on the customer&rsquo;s behalf, see
          Section 3.3).
        </li>
      </ul>

      <h2>2. Two roles: controller and processor</h2>
      <p>Moosewave plays two distinct roles depending on the data:</p>
      <ul>
        <li>
          <strong>Independent controller</strong> for our relationship with our
          customers and prospects: account data, billing data, support
          correspondence, marketing analytics, security telemetry. This Privacy
          Policy governs that role.
        </li>
        <li>
          <strong>Processor on behalf of customers</strong> for the subscriber
          data customers upload, import, or capture through the Service. The
          customer is the controller; we act on their documented instructions
          per Article 28 of the GDPR. The{" "}
          <Link href="/legal/dpa">Data Processing Addendum (DPA)</Link> governs
          that role.
        </li>
      </ul>

      <h2>3. Data we collect</h2>
      <h3>3.1 Account data</h3>
      <p>
        When you sign up: email address, name (optional), password hash managed
        by Moosewave first-party auth, organization name (optional), country, and
        the timestamp and IP address of registration.
      </p>
      <h3>3.2 Billing data</h3>
      <p>
        When you purchase: billing email, billing address, last four digits of
        payment method, transaction history. Full payment details are handled by
        Stripe (global) or Razorpay (India) and are never stored on Moosewave
        servers.
      </p>
      <h3>3.3 Subscriber data (processed on behalf of customer)</h3>
      <p>
        Customers upload, import via OAuth / API adapters, or capture through
        Moosewave forms the personal data of their newsletter subscribers. This
        typically includes:
      </p>
      <ul>
        <li>email address (mandatory);</li>
        <li>name (optional);</li>
        <li>custom field values defined by the customer;</li>
        <li>consent state and timestamp (if provided at import);</li>
        <li>
          engagement events: opens, clicks, bounces, unsubscribes, complaints;
        </li>
        <li>
          IP address and user agent at consent capture and engagement events.
        </li>
      </ul>
      <p>
        Moosewave does not control the categories or accuracy of subscriber data.
        Subscribers wishing to exercise rights should contact the customer (the
        controller) first; we will assist the customer as required by the DPA.
      </p>
      <h3>3.4 Usage and telemetry</h3>
      <p>
        Pseudonymous usage events (page views, feature interactions, funnel
        completion) via PostHog (EU-hosted) when you have opted in to analytics
        cookies. Application errors via Sentry (with PII filters applied to
        stack traces and request context). Performance and infrastructure
        metrics that do not identify individuals.
      </p>
      <h3>3.5 Support data</h3>
      <p>
        Email correspondence, in-app chat (when available), and any attachments
        you choose to share when contacting support.
      </p>
      <h3>3.6 Cookies and similar technologies</h3>
      <p>
        See our <Link href="/legal/cookies">Cookie Policy</Link> for the full
        register and how to control optional cookies.
      </p>

      <h2>4. Why we collect it (purposes and lawful bases)</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Purpose</th>
            <th scope="col">Data categories</th>
            <th scope="col">Lawful basis (GDPR)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Provide and operate the Service</td>
            <td>Account, billing, subscriber (as processor), support</td>
            <td>Contract (Art. 6(1)(b))</td>
          </tr>
          <tr>
            <td>Process payments</td>
            <td>Billing</td>
            <td>Contract</td>
          </tr>
          <tr>
            <td>Comply with legal obligations (tax, fraud)</td>
            <td>Billing, audit logs</td>
            <td>Legal obligation (Art. 6(1)(c))</td>
          </tr>
          <tr>
            <td>Product improvement and analytics</td>
            <td>Usage telemetry (opt-in)</td>
            <td>
              Consent (Art. 6(1)(a)) for cookies; legitimate interests for
              server-side aggregates
            </td>
          </tr>
          <tr>
            <td>Security, abuse prevention, AUP enforcement</td>
            <td>Account, IP, usage, audit logs</td>
            <td>Legitimate interests (Art. 6(1)(f))</td>
          </tr>
          <tr>
            <td>Customer marketing communications</td>
            <td>Account, marketing-opt-in state</td>
            <td>Consent or legitimate interests with opt-out</td>
          </tr>
        </tbody>
      </table>

      <h2>5. How we share data</h2>
      <p>
        We share personal data only with the sub-processors listed at{" "}
        <Link href="/legal/sub-processors">/legal/sub-processors</Link>, each of
        whom processes a specific category for a specific purpose under a
        written DPA.
      </p>
      <p>
        We may also disclose personal data when required to comply with valid
        legal process (subpoena, court order, regulatory request) or to protect
        rights, property, and safety. We publish an annual transparency report
        summarizing legal requests; we challenge requests we believe are
        overbroad.
      </p>
      <p>
        We do not sell personal data. We do not share personal data with
        advertising networks for cross-context behavioral advertising.
      </p>
      <p>
        In the event of a corporate transaction (merger, acquisition, asset
        sale), personal data may transfer to the successor subject to this
        Privacy Policy or a successor policy with materially equivalent
        protection. We will give affected customers notice of any change in
        controllership and provide an opportunity to terminate.
      </p>

      <h2>6. International transfers</h2>
      <p>
        Moosewave Cloud runs on {INFRASTRUCTURE.cloudProvider} in{" "}
        {INFRASTRUCTURE.primaryRegion}. Because the primary region is in the
        United States, personal data of individuals in the EEA, the UK and
        Switzerland is transferred to a third country as a matter of course
        rather than by exception. The full list of recipients, their locations
        and the transfer basis relied on for each is on our{" "}
        <Link href={SUBPROCESSORS_PATH}>sub-processors page</Link>. For those
        transfers:
      </p>
      <ul>
        <li>
          Where a recipient is certified under the EU-US Data Privacy Framework
          and the transfer falls within the European Commission&rsquo;s
          adequacy decision of 10 July 2023, we rely on that certification.
        </li>
        <li>
          Otherwise, and as a fallback for every DPF recipient, we rely on the
          European Commission&rsquo;s 2021 Standard Contractual Clauses (SCCs),
          as updated, with sub-processors.
        </li>
        <li>
          For UK transfers, we use the UK International Data Transfer Addendum
          (IDTA) where applicable.
        </li>
        <li>
          We assess third-country sub-processors for the supplementary measures
          described in EDPB Recommendations 01/2020 and documented those
          assessments.
        </li>
      </ul>
      <p>
        For India entity contracts, transfers are governed by the DPDP Act 2023
        cross-border-transfer rules.
      </p>

      <h2>7. Retention periods</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Data category</th>
            <th scope="col">Retention</th>
            <th scope="col">Trigger</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Active account data</td>
            <td>Duration of account + 30 days</td>
            <td>Account closure</td>
          </tr>
          <tr>
            <td>Billing records</td>
            <td>7 years</td>
            <td>Legal / tax obligation</td>
          </tr>
          <tr>
            <td>Subscriber data (as processor)</td>
            <td>
              Per controller instructions; default 30 days post-account-closure
              for export, then deletion
            </td>
            <td>Controller deletion request or account closure</td>
          </tr>
          <tr>
            <td>Engagement events (opens / clicks)</td>
            <td>Default 12 months; configurable from 30 days up to 7 years</td>
            <td>Per-account retention setting</td>
          </tr>
          <tr>
            <td>Suppression list (hashed)</td>
            <td>Indefinite while account active</td>
            <td>Required for unsubscribe honor</td>
          </tr>
          <tr>
            <td>
              Audit logs (including Moosewave-personnel access to customer data)
            </td>
            <td>
              Default 90 days; configurable from 7 days up to 7 years. Entries
              under legal hold are retained until the hold lifts
            </td>
            <td>Per-account retention setting</td>
          </tr>
          <tr>
            <td>Support correspondence</td>
            <td>3 years from last interaction</td>
            <td>Quality and dispute resolution</td>
          </tr>
          <tr>
            <td>PostHog analytics events</td>
            <td>13 months</td>
            <td>Default; deletable on request</td>
          </tr>
          <tr>
            <td>Sentry errors</td>
            <td>90 days</td>
            <td>Default platform retention</td>
          </tr>
          <tr>
            <td>Cookie consent record</td>
            <td>13 months</td>
            <td>Re-consent timer</td>
          </tr>
        </tbody>
      </table>

      <h2>8. Your rights</h2>
      <p>
        Subject to applicable law (GDPR, UK GDPR, DPDP Act 2023, CCPA / CPRA,
        PIPEDA, LGPD, and others), you have rights to:
      </p>
      <ul>
        <li>access your personal data;</li>
        <li>request correction of inaccurate data;</li>
        <li>
          request deletion (right to be forgotten), subject to legal-hold
          exceptions;
        </li>
        <li>request portability in a machine-readable format;</li>
        <li>request restriction of processing;</li>
        <li>object to processing based on legitimate interests;</li>
        <li>
          withdraw consent where processing is consent-based, without affecting
          prior lawful processing;
        </li>
        <li>lodge a complaint with your supervisory authority.</li>
      </ul>
      <p>
        To exercise rights regarding your account or marketing data, email{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a> or use
        the in-app data-export and account-closure tools. You can also start
        from the{" "}
        <Link href="/legal/account-deletion">account deletion page</Link>. We
        respond within 30 days (extendable to 60 for complex requests, with
        notice). To exercise rights as a subscriber of a Moosewave customer,
        contact the customer (the controller); we will assist them as required
        by the DPA.
      </p>
      <p>
        California residents: you also have the right to know what personal
        information we collect, sell, or share (we do not sell or share for
        cross-context behavioral advertising), to request deletion, to correct
        inaccurate information, and to non-discrimination for exercising rights.
        Submit requests via{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>.
      </p>

      <h2>9. Cookies</h2>
      <p>
        See our <Link href="/legal/cookies">Cookie Policy</Link> for the full
        list, categories, and controls.
      </p>

      <h2>10. Children&rsquo;s data</h2>
      <p>
        Moosewave is not directed at children. We do not knowingly collect
        personal data from anyone under 16 (under 13 in the US). If you believe
        a child has provided us personal data, contact{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a> and we
        will delete it. Customers using Moosewave to send commercial messages to
        minors are responsible for the applicable consent and parental
        authorization requirements in their jurisdiction.
      </p>

      <h2>11. Security</h2>
      <p>
        We protect personal data with technical and organizational measures
        appropriate to the risk:
      </p>
      <ul>
        <li>encryption in transit (TLS 1.2+; TLS 1.3 preferred);</li>
        <li>encryption at rest (AES-256 on databases and object storage);</li>
        <li>
          role-based access with multi-factor authentication for personnel;
        </li>
        <li>
          least-privilege defaults; production isolation from development;
        </li>
        <li>audit logging of personnel access to customer data;</li>
        <li>
          regular vulnerability scanning and (V2 onward) annual third-party
          penetration testing;
        </li>
        <li>
          documented incident response with 72-hour customer notification
          commitment for breaches affecting their data;
        </li>
        <li>geographically redundant encrypted backups.</li>
      </ul>

      <h2>12. Updates to this policy</h2>
      <p>
        We will update this policy from time to time. For material changes we
        will give at least 30 days&rsquo; notice via email to account owners and
        an in-product banner. Non-material edits (typos, clarifications) take
        effect on publication. The &quot;Last updated&quot; date at the top
        reflects the most recent change.
      </p>

      <h2>13. EU and UK representatives</h2>
      <p>
        Moosewave is established outside the European Union and the United
        Kingdom. Under Article 27 of the GDPR and Article 27 of the UK GDPR,
        Moosewave will appoint and publicly list an EU representative and a UK
        representative prior to making the Service generally available to data
        subjects in those jurisdictions. Until those appointments are recorded
        on this page, data subjects in the EU/EEA, Switzerland, and the UK may
        contact Moosewave directly using the channels in Section 14 below; we
        will respond on the same terms we would respond to a representative.
      </p>
      {/*
        TODO(privacy-legal-publication): once appointed, populate the two
        blocks below from POSTWAVE_EU_REPR_NAME / POSTWAVE_EU_REPR_ADDRESS
        and POSTWAVE_UK_REPR_NAME / POSTWAVE_UK_REPR_ADDRESS environment
        variables on a server-rendered version of this page. Static
        placeholder copy is intentional pre-GA per the audit
        (docs/legal-pages-audit-2026-06-02.md, Blocker §2).
      */}
      <p>
        <strong>EU representative (Art. 27 GDPR).</strong> To be appointed
        (typically via VeraSafe, Prighter, or an equivalent provider). Until
        then, EU/EEA and Swiss subjects may contact{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>.
      </p>
      <p>
        <strong>UK representative (Art. 27 UK GDPR).</strong> To be appointed.
        Until then, UK subjects may contact{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>.
      </p>

      <h2>14. Contact</h2>
      <p>
        Privacy: <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>
        <br />
        Data Protection Officer:{" "}
        <a href="mailto:dpo@moosewave.com">dpo@moosewave.com</a>
        <br />
        Postal: Moosewave Inc., 1209 Orange Street, Wilmington, DE 19801, USA.
        Moosewave Technologies Pvt. Ltd., Bengaluru, Karnataka 560001, India.
      </p>

      <p className="text-pw-muted-on-paper text-xs mt-10">
        This is a working draft pending counsel review. Last updated:
        2026-06-02.
      </p>
    </article>
  );
}
