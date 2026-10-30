import Link from "next/link";
// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical domain: moosewave.com. See docs/legal-pages-audit-2026-06-02.md
// (Blocker §1). Use moosewave.com for all URLs, canonical, breadcrumbs, and
// support email aliases on every legal page.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service. Moosewave",
  description:
    "Review draft of the Moosewave terms covering accounts, monthly subscriptions, acceptable use, intellectual property, liability, and disputes.",
  alternates: { canonical: "https://moosewave.com/legal/terms" },
};

export default function TermsPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <h1>Terms of Service</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-09-22. Review draft — Coming soon and pending
        counsel approval. It is not an offer and paid checkout is not open. The
        published terms accepted during checkout will control a purchase.
      </p>

      <h2>1. Definitions</h2>
      <p>For the purposes of these Terms of Service (the &quot;Terms&quot;):</p>
      <ul>
        <li>
          <strong>&quot;Moosewave&quot;</strong>, <strong>&quot;we&quot;</strong>
          , <strong>&quot;us&quot;</strong>, or <strong>&quot;our&quot;</strong>{" "}
          means the Moosewave operating entity identified in the master order
          form, currently Moosewave Inc. (Delaware) for global customers and
          Moosewave Technologies Pvt. Ltd. (Karnataka, India) for customers
          contracted under the India entity.
        </li>
        <li>
          <strong>&quot;Customer&quot;</strong>,{" "}
          <strong>&quot;you&quot;</strong>, or <strong>&quot;your&quot;</strong>{" "}
          means the individual or legal entity that has registered for and uses
          the Service.
        </li>
        <li>
          <strong>&quot;Service&quot;</strong> means the Moosewave hosted
          software platform, including the Sandbox, Launch, Growth, and Scale
          plans, the Migration adapters, the Inbox Reality
          deliverability service, the Voice AI sequence generator, all related
          APIs, and the marketing site.
        </li>
        <li>
          <strong>&quot;Subscriber Data&quot;</strong> means personal data of
          Customer&rsquo;s newsletter subscribers that Customer uploads,
          imports, or otherwise causes Moosewave to process.
        </li>
        <li>
          <strong>&quot;Customer Content&quot;</strong> means email templates,
          campaign content, sequences, segments, automations, custom field
          definitions, and any other content Customer creates or imports via the
          Service.
        </li>
        <li>
          <strong>&quot;AUP&quot;</strong> means the{" "}
          <Link href="/legal/aup">Acceptable Use Policy</Link> incorporated into
          these Terms by reference.
        </li>
        <li>
          <strong>&quot;DPA&quot;</strong> means the{" "}
          <Link href="/legal/dpa">Data Processing Addendum</Link> incorporated
          into these Terms by reference and applicable where Moosewave processes
          personal data on Customer&rsquo;s behalf.
        </li>
      </ul>

      <h2>2. Account registration and termination</h2>
      <h3>2.1 Eligibility</h3>
      <p>
        You must be at least 18 years old (or the age of legal majority in your
        jurisdiction) and capable of forming a binding contract. If you register
        on behalf of an organization, you represent that you have authority to
        bind that organization to these Terms.
      </p>
      <h3>2.2 Account security</h3>
      <p>
        You are responsible for safeguarding your credentials and for all
        activity under your account. Notify us promptly at{" "}
        <a href="mailto:security@moosewave.com">security@moosewave.com</a> if you
        suspect unauthorized access. We are not liable for losses caused by
        unauthorized account use that you fail to report promptly.
      </p>
      <h3>2.3 Customer-initiated termination</h3>
      <p>
        You may terminate your account at any time via Settings &rarr; Privacy
        &rarr; &ldquo;Delete my account&rdquo; or by emailing{" "}
        <a href="mailto:support@moosewave.com">support@moosewave.com</a>.
        Termination of a paid subscription takes effect at the end of the
        current billing period unless applicable law requires otherwise.
      </p>
      <h3>2.4 Moosewave-initiated termination</h3>
      <p>
        We may suspend or terminate your account for material breach of these
        Terms or the AUP, for non-payment of fees, in response to legal
        compulsion, or where your use poses a material risk to the Service or to
        other customers (e.g. sustained shared-IP reputation damage). Where
        reasonably possible we provide notice and an opportunity to cure;
        immediate termination is reserved for serious abuse cases per AUP §4.
      </p>
      <h3>2.5 Effect of termination</h3>
      <p>
        Upon termination, Customer Content and Subscriber Data remain available
        for export for 30 days. After that window we delete the data per the
        retention schedule in our{" "}
        <Link href="/legal/privacy">Privacy Policy</Link>, except where legal
        hold or regulatory obligation requires retention.
      </p>

      <h2>3. Subscription plans</h2>
      <h3>3.1 Sandbox and paid monthly plans</h3>
      <p>
        Sandbox is a free evaluation plan with simulated profiles and no
        production recipients. Launch ($39/month), Growth ($99/month), and
        Scale ($349/month) are planned recurring subscriptions. Each has finite
        profiles, accepted-recipient, seat, automation, AI-credit, preview,
        report, storage, API, retention, and support allowances shown on the
        pricing page and at checkout. Annual billing is Coming soon and is not
        offered at launch.
      </p>
      <h3>3.2 Usage measurement and hard caps</h3>
      <p>
        An active profile is a deduplicated profile that is currently emailable;
        the highest daily count in the billing period determines profile usage.
        An accepted recipient is counted when a configured sending provider
        accepts a Moosewave submission. A pre-submission rejection does not
        count; a new provider submission after a retry does. Allowances reset
        each calendar billing period, do not roll over, and stop the affected
        paid action at the cap. Moosewave does not automatically bill overages.
      </p>
      <h3>3.3 Add-ons</h3>
      <p>
        Optional add-ons (e.g. dedicated IP or priority support) are billed per
        their published terms and cancellable per the same rules as the
        paid plans.
      </p>
      <h3>3.4 Price changes</h3>
      <p>
        We may change recurring subscription prices with at least 60 days&rsquo;
        notice. The change takes effect at the next billing cycle after the
        notice period.
      </p>
      <h3>3.5 Taxes</h3>
      <p>
        Fees are exclusive of taxes unless stated otherwise. You are responsible
        for any applicable taxes (VAT, GST, sales tax) unless we are required to
        collect them, in which case the applicable amount will be added to your
        invoice.
      </p>

      <h2>4. Acceptable use</h2>
      <p>
        Your use of the Service is subject to the{" "}
        <Link href="/legal/aup">Acceptable Use Policy</Link>. The AUP is
        material to these Terms; violation may result in suspension or
        termination per Section 2.4 and AUP §4.
      </p>

      <h2>5. Customer data and intellectual property</h2>
      <h3>5.1 Customer ownership</h3>
      <p>
        As between the parties, you retain all right, title, and interest in and
        to Customer Content and Subscriber Data. You grant Moosewave a worldwide,
        non-exclusive, royalty-free license to host, process, transmit, display,
        modify (only as required to operate the Service, e.g. MJML compilation,
        format conversion), and create derivative works of Customer Content and
        Subscriber Data solely to provide the Service to you in accordance with
        these Terms.
      </p>
      <h3>5.2 Voice profiles and AI generations</h3>
      <p>
        Voice profiles built from your inputs are derived works of your inputs
        and remain yours. Moosewave does not use individual Customer Content to
        train shared models or general-purpose LLMs. Aggregated, de-identified
        usage signals (e.g. average sequence length, popular template
        categories) may inform product improvements without revealing Customer
        Content.
      </p>
      <h3>5.3 Feedback</h3>
      <p>
        If you send us suggestions or feedback, we may use it without obligation
        or attribution.
      </p>

      <h2>6. Moosewave&rsquo;s intellectual property</h2>
      <p>
        Moosewave application source is offered under the AGPL-3.0-only license,
        and identified reusable packages such as SDKs, the CLI, MCP server,
        migration library, and React components are offered under their
        repository MIT licenses. The applicable LICENSE file controls each
        source component.
      </p>
      <p>
        Moosewave integrates a pinned upstream Listmonk service; it does not
        represent that dependency as a Moosewave fork. Trademarks, logos,
        designs, hosted-service access, customer support, and separately
        identified brand assets are not licensed merely because source code is
        available. Source licensing does not create a production-supported
        self-host or continuity service.
      </p>

      <h2>7. Privacy and data processing</h2>
      <p>
        Our collection and use of personal data is governed by our{" "}
        <Link href="/legal/privacy">Privacy Policy</Link>. To the extent
        Moosewave processes personal data on your behalf as a processor under
        GDPR, the UK GDPR, the DPDP Act 2023, or analogous laws, the{" "}
        <Link href="/legal/dpa">DPA</Link> applies and is incorporated into
        these Terms by reference.
      </p>

      <h2>8. Sub-processors</h2>
      <p>
        We use the third-party sub-processors listed at{" "}
        <Link href="/legal/sub-processors">/legal/sub-processors</Link> to
        operate the Service. We give 30 days&rsquo; notice before adding new
        sub-processors and you may terminate for cause if you reasonably object.
        The sub-processor list is part of the DPA.
      </p>

      <h2>9. Service availability</h2>
      <p>
        The launch plans do not include a public contractual uptime SLA or
        service-credit schedule. Current operational status is available at{" "}
        <Link href="/status">/status</Link>. A customer-specific commitment is
        binding only when it appears in an executed order.
      </p>

      <h2>10. Refunds</h2>
      <p>
        Refunds are governed by the{" "}
        <Link href="/legal/refund">Refund Policy</Link>. The intended launch
        policy provides a 14-day refund window for the first subscription,
        once per customer and workspace; renewals are otherwise non-refundable
        except as required by law or for qualifying payment or service failures.
      </p>

      <h2>11. Disclaimers</h2>
      <p>
        EXCEPT AS EXPRESSLY PROVIDED IN THESE TERMS, THE SERVICE IS PROVIDED
        &quot;AS IS&quot; AND &quot;AS AVAILABLE.&quot; TO THE MAXIMUM EXTENT
        PERMITTED BY LAW, MOOSEWAVE DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED,
        INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
        PURPOSE, NON-INFRINGEMENT, AND ANY WARRANTY ARISING FROM COURSE OF
        DEALING OR USAGE OF TRADE. MOOSEWAVE DOES NOT WARRANT UNINTERRUPTED OR
        ERROR-FREE OPERATION OR THAT INBOX PLACEMENT, AI VOICE OUTPUT, OR
        DELIVERABILITY DIAGNOSES WILL ACHIEVE ANY SPECIFIC OUTCOME.
      </p>

      <h2>12. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR
        ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES,
        OR FOR ANY LOST PROFITS, REVENUES, DATA, OR GOODWILL, ARISING FROM OR
        RELATING TO THESE TERMS OR THE SERVICE, EVEN IF ADVISED OF THE
        POSSIBILITY.
      </p>
      <p>
        EACH PARTY&rsquo;S TOTAL CUMULATIVE LIABILITY ARISING FROM OR RELATING
        TO THESE TERMS WILL NOT EXCEED THE FEES PAID OR PAYABLE BY CUSTOMER TO
        MOOSEWAVE IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT
        GIVING RISE TO THE CLAIM.
      </p>
      <p>
        These limitations do not apply to: (a) breach of confidentiality; (b)
        infringement of intellectual property; (c) willful misconduct or fraud;
        (d) Customer&rsquo;s payment obligations; (e) Customer&rsquo;s
        indemnification obligations; or (f) liability that cannot be limited
        under applicable law.
      </p>

      <h2>13. Indemnification</h2>
      <h3>13.1 By Customer</h3>
      <p>
        You will defend, indemnify, and hold harmless Moosewave from and against
        any third-party claim arising from (a) Customer Content or Subscriber
        Data, including claims that they infringe third-party rights or violate
        applicable law; (b) your violation of the AUP; or (c) your breach of
        these Terms.
      </p>
      <h3>13.2 By Moosewave</h3>
      <p>
        We will defend you against any third-party claim alleging that the
        Service, when used as authorized, infringes a valid third-party
        intellectual property right, and will pay damages finally awarded
        against you (or settlement amounts we agree to pay), subject to the
        liability cap in Section 12. Our sole obligation if such a claim is made
        is to (i) procure the right to continue use, (ii) modify the Service to
        be non-infringing, or (iii) terminate the affected portion of the
        Service and refund any prepaid unused fees.
      </p>
      <h3>13.3 Procedure</h3>
      <p>
        The indemnified party must give prompt written notice, allow the
        indemnifying party to control the defense and settlement, and provide
        reasonable cooperation. The indemnifying party may not settle in a way
        that imposes obligations on the indemnified party without consent.
      </p>

      <h2>14. Governing law</h2>
      <p>
        For Customers contracted with Moosewave Inc. (Delaware): these Terms are
        governed by the laws of the State of Delaware, United States, without
        regard to conflict-of-laws principles.
      </p>
      <p>
        For Customers contracted with Moosewave Technologies Pvt. Ltd. (India):
        these Terms are governed by the laws of India, with venue in Bengaluru,
        Karnataka.
      </p>
      <p>
        The UN Convention on Contracts for the International Sale of Goods does
        not apply.
      </p>

      <h2>15. Dispute resolution</h2>
      <h3>15.1 Informal resolution</h3>
      <p>
        Before filing any formal proceeding, the parties agree to attempt
        good-faith resolution by sending a written notice to
        <a href="mailto:legal@moosewave.com"> legal@moosewave.com</a> and engaging
        in 30 days of negotiation.
      </p>
      <h3>15.2 Arbitration (Delaware-governed contracts)</h3>
      <p>
        Any dispute not resolved informally will be resolved by binding
        arbitration administered by JAMS under its Streamlined Arbitration
        Rules, conducted in Wilmington, Delaware (or remotely by mutual
        agreement). Judgment on the award may be entered in any court of
        competent jurisdiction.
      </p>
      <h3>15.3 Arbitration carve-out</h3>
      <p>
        The arbitration requirement does not apply to: (a) claims for injunctive
        relief to protect intellectual property; (b) small-claims-court claims
        within that court&rsquo;s jurisdictional limits; or (c) claims that
        cannot be arbitrated under applicable law.
      </p>
      <h3>15.4 Class action waiver</h3>
      <p>
        To the maximum extent permitted by law, each party agrees to bring
        claims only in its individual capacity and not as part of a class,
        collective, or representative action.
      </p>
      <h3>15.5 India-governed contracts</h3>
      <p>
        For India-entity contracts, disputes will be resolved by the courts of
        Bengaluru, Karnataka, with arbitration available at either party&rsquo;s
        election under the Arbitration and Conciliation Act 1996.
      </p>

      <h2>16. Confidentiality</h2>
      <p>
        Each party will protect the other&rsquo;s confidential information with
        the same degree of care it uses to protect its own (and no less than
        reasonable care). Confidential information excludes information that is
        or becomes public through no breach, was known prior to disclosure, was
        independently developed, or is rightfully received from a third party
        without confidentiality obligations.
      </p>

      <h2>17. Changes to these terms</h2>
      <p>
        We may update these Terms from time to time. For material changes, we
        will give at least 30 days&rsquo; notice via email to the account owner
        and an in-product banner. Continued use of the Service after the
        effective date constitutes acceptance. If you do not accept material
        changes, you may terminate per Section 2.3 and receive a prorated refund
        of any unused prepaid recurring fees.
      </p>

      <h2>18. Miscellaneous</h2>
      <h3>18.1 Entire agreement</h3>
      <p>
        These Terms (together with the AUP, DPA, Privacy Policy, Refund Policy,
        Cookie Policy, and any signed order forms) constitute the entire
        agreement between the parties and supersede all prior agreements
        regarding the same subject matter.
      </p>
      <h3>18.2 Order of precedence</h3>
      <p>
        In the event of conflict: signed master order form &gt; DPA &gt; these
        Terms &gt; AUP and other policies.
      </p>
      <h3>18.3 Severability</h3>
      <p>
        If any provision is held unenforceable, the remaining provisions
        continue in effect.
      </p>
      <h3>18.4 Assignment</h3>
      <p>
        You may not assign these Terms without our written consent, except to an
        affiliate or in connection with a merger, acquisition, or sale of
        substantially all assets, provided the assignee assumes all obligations.
        We may assign freely with notice.
      </p>
      <h3>18.5 Independent contractors</h3>
      <p>
        The parties are independent contractors. Nothing in these Terms creates
        a partnership, joint venture, agency, or employment relationship.
      </p>
      <h3>18.6 Notices</h3>
      <p>
        Notices to Moosewave must be sent to{" "}
        <a href="mailto:legal@moosewave.com">legal@moosewave.com</a>. Notices to
        you may be sent to the email address on file or delivered via in-product
        notification.
      </p>
      <h3>18.7 Survival</h3>
      <p>
        Sections that by their nature should survive termination (including
        Sections 5, 6, 11, 12, 13, 14, 15, 16, 17, and 18) survive termination
        of these Terms.
      </p>
      <h3>18.8 Force majeure</h3>
      <p>
        Neither party is liable for delay or failure due to events beyond
        reasonable control (acts of God, war, terrorism, pandemic, civil unrest,
        government action, internet infrastructure outage, sub-processor outage
        despite reasonable failover), provided the affected party gives prompt
        notice and uses commercially reasonable efforts to mitigate.
      </p>

      <h2>19. Contact</h2>
      <p>
        Legal: <a href="mailto:legal@moosewave.com">legal@moosewave.com</a>
        <br />
        Billing: <a href="mailto:billing@moosewave.com">billing@moosewave.com</a>
        <br />
        Privacy: <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>
        <br />
        Security:{" "}
        <a href="mailto:security@moosewave.com">security@moosewave.com</a>
      </p>

      <p className="text-pw-muted-on-paper text-xs mt-10">
        This is a working draft pending counsel review. Last updated:
        2026-06-02.
      </p>
    </article>
  );
}
