// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical domain: moosewave.com. See docs/legal-pages-audit-2026-06-02.md
// (Blocker §1). Cross-referenced from Terms §1 (definitions) and §4
// (Acceptable Use).
//
// SEO intent: legal page; intentionally low-weight in SEO. Crawlable + canonical
// + breadcrumb only; max-snippet:-1 so AIO can quote policy text accurately.
import type { Metadata } from "next";

import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";

const PAGE_URL = "https://moosewave.com/legal/aup";
const PAGE_DESCRIPTION =
  "What you can and can't send through Moosewave. Built for newsletter writers; explicitly off-limits for cold outreach, purchased lists, and abuse.";

export const metadata: Metadata = {
  title: "Acceptable Use Policy | Moosewave",
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
    title: "Moosewave Acceptable Use Policy",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/legal/aup/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave Acceptable Use Policy",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave Acceptable Use Policy",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Acceptable Use Policy", url: PAGE_URL },
]);

export default function AupPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <JsonLd data={BREADCRUMBS_JSON_LD} />
      <h1>Acceptable Use Policy</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-04-30. Pending counsel review.
      </p>

      <p>
        Moosewave is built for one customer: the newsletter writer with an
        opted-in audience. Our pricing, our deliverability infrastructure, and
        our reputation across providers depend on every customer sending only to
        people who actively asked to hear from them. This policy is the line.
      </p>

      <h2>1. Prohibited uses</h2>
      <p>
        You may not use Moosewave to send, store, or facilitate any of the
        following:
      </p>
      <h3>1.1 Cold outreach</h3>
      <p>
        Cold sales emails, prospecting sequences to people who have not
        explicitly opted in, &quot;warm intro&quot; campaigns to scraped
        contacts, LinkedIn-scrape-to-email pipelines. Moosewave is not a
        cold-outreach tool. If your sequences look like cold outreach, your
        account will be suspended on first complaint and terminated on second.
      </p>
      <h3>1.2 Purchased, rented, or scraped lists</h3>
      <p>
        Lists from data brokers, &quot;email append&quot; services, scraping
        tools, or any source where the subscriber did not directly opt in to
        hear from you specifically. We require double opt-in for any imported
        list of more than 5,000 subscribers without prior sending history.
      </p>
      <h3>1.3 Adult content, gambling, crypto / NFT promotion</h3>
      <p>
        Pornographic content, escort services, online casino / sports betting
        promotion, ICO / token-launch promotion, NFT-drop promotion,
        get-rich-quick crypto schemes. These categories either have categorical
        reputation problems or specific legal issues we&rsquo;re not equipped to
        navigate.
      </p>
      <h3>1.4 Illegal goods and services</h3>
      <p>
        Unlicensed pharmaceuticals, controlled substances, weapons, forged
        documents, hacking tools, anything illegal under US, EU, UK, or Indian
        law. We follow the strictest applicable jurisdiction.
      </p>
      <h3>1.5 Harassment, hate, and incitement</h3>
      <p>
        Targeted harassment of individuals, content advocating violence against
        protected groups, doxxing, stalking-enablement.
      </p>
      <h3>1.6 Malware, phishing, and credential theft</h3>
      <p>
        Anything that attempts to deliver malicious payloads, capture
        credentials, impersonate a brand to deceive recipients, or spread CSAM.
        These trigger immediate, permanent account termination and may be
        reported to law enforcement.
      </p>
      <h3>1.7 Other</h3>
      <p>
        MLM / pyramid schemes, fake-news / disinformation campaigns, unsolicited
        transactional bulk (e.g. mass &quot;your account was updated&quot;
        messages to non-customers), any content that materially damages provider
        reputation (Gmail, Outlook, iCloud, Yahoo, Proton).
      </p>

      <h2>2. Required practices</h2>
      <h3>2.1 Opt-in consent</h3>
      <p>
        Every recipient on your list must have actively asked to be on it. We
        accept single opt-in for organic signups via your own forms, but we
        strongly recommend (and default to) double opt-in. We require double
        opt-in for any list import larger than 5,000 subscribers without
        verifiable prior sending history.
      </p>
      <h3>2.2 Suppression list honor</h3>
      <p>
        Moosewave maintains an unsubscribe / bounce / complaint suppression list
        per account. The send engine refuses to send to suppressed addresses.
        You may not bypass this, including by exporting the list, uploading it
        elsewhere, or using a different sender to reach the same addresses.
      </p>
      <h3>2.3 Accurate sender identification</h3>
      <p>
        From-name and from-address must accurately represent your publication or
        organization. CAN-SPAM, CASL, and GDPR all require a valid physical
        postal address in every commercial message. Moosewave&rsquo;s editor
        enforces this at send time.
      </p>
      <h3>2.4 Functional unsubscribe</h3>
      <p>
        Every commercial message must include a one-click unsubscribe link.
        Moosewave injects this automatically and you may not remove it.
        Unsubscribes are honored within 10 business days per CAN-SPAM (we honor
        immediately).
      </p>
      <h3>2.5 Honest subject lines and headers</h3>
      <p>
        Subject lines must accurately describe message content. False Re: / Fwd:
        prefixes, fake reply chains, deceptive headers all violate CAN-SPAM and
        our AUP.
      </p>

      <h2>3. Compliance with email law</h2>
      <p>
        You are responsible for compliance with the email regulations of every
        jurisdiction your subscribers live in:
      </p>
      <ul>
        <li>
          <strong>US:</strong> CAN-SPAM Act
        </li>
        <li>
          <strong>Canada:</strong> CASL (express consent required; implied
          consent has expiration windows)
        </li>
        <li>
          <strong>EU / EEA / UK:</strong> GDPR + ePrivacy Directive (consent for
          marketing; legitimate interest requires balancing test)
        </li>
        <li>
          <strong>Australia:</strong> Spam Act 2003
        </li>
        <li>
          <strong>India:</strong> DPDP Act 2023 (consent-based processing for
          marketing)
        </li>
      </ul>
      <p>
        Moosewave provides the technical compliance scaffolding (suppression
        lists, unsubscribe injection, consent timestamps, audit logging). The
        legal compliance is yours.
      </p>

      <h2>4. Enforcement</h2>
      <p>
        Moosewave monitors complaint rates, bounce rates, spam-trap hits, and
        provider feedback loops. Triggered behavior escalates as follows:
      </p>
      <ol>
        <li>
          <strong>Soft warning</strong>, spam-complaint rate at or above 0.10%
          across the trailing 7 days, first spam-trap hit, first unauthenticated
          bulk send. Email notification + dashboard banner with remediation
          steps. 0.10% is where inbox placement starts to degrade, not where we
          stop you.
        </li>
        <li>
          <strong>Automatic send block</strong>, any single day in the trailing
          7 at or above 0.30% &mdash; the ceiling Gmail, Yahoo and Outlook
          enforce. This one is not a review decision: the send is refused at
          submit time and clears on its own once 7 consecutive days stay below
          the ceiling. Days with fewer than 500 sends are ignored, so a small
          test cannot trip it.
        </li>
        <li>
          <strong>Send suspension</strong>, repeated excursion or single
          material policy violation (e.g. clear cold-outreach pattern). Sending
          paused while we review; account stays accessible for export and
          remediation.
        </li>
        <li>
          <strong>Account termination</strong>, material AUP violation, severe
          abuse signal, or failure to remediate after suspension. 30-day
          data-export window unless the violation involves illegal content (in
          which case data is quarantined for legal hold).
        </li>
        <li>
          <strong>Immediate termination</strong>, phishing, malware, CSAM,
          illegal goods, or any conduct that threatens immediate harm to
          recipients or to Moosewave&rsquo;s shared sender reputation. No notice;
          no refund.
        </li>
      </ol>

      <h2>5. Reporting abuse</h2>
      <p>
        If you received an email through Moosewave that you believe violates this
        policy, please report it:
      </p>
      <ul>
        <li>
          Email <a href="mailto:abuse@moosewave.com">abuse@moosewave.com</a> with
          the original message including full headers.
        </li>
        <li>
          If you need a secure intake path for a large report, email
          abuse@moosewave.com and request one in the subject line.
        </li>
      </ul>
      <p>
        We acknowledge abuse reports within one business day and act within
        five. We do not share complainant identity with the sender.
      </p>

      <h2>6. Updates</h2>
      <p>
        We update this AUP as the threat landscape changes and as we learn from
        real abuse cases. Material changes are emailed to account owners 30 days
        in advance.
      </p>

      <h2>7. Contact</h2>
      <p>
        Abuse: <a href="mailto:abuse@moosewave.com">abuse@moosewave.com</a>
        <br />
        Trust &amp; Safety:{" "}
        <a href="mailto:trust@moosewave.com">trust@moosewave.com</a>
      </p>
    </article>
  );
}
