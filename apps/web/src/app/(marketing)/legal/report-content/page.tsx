// SPDX-License-Identifier: AGPL-3.0-only
//
// The public notice-and-action page: DSA Art. 16 reporting, Art. 16(5) outcome
// lookup, and the Art. 11/12/13 contact points.
//
// One page rather than three because a person who has found something wrong
// should not have to work out which article of the Regulation their problem
// falls under before they can tell anyone about it.
import type { Metadata } from "next";
import Link from "next/link";

import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import { LEGAL_FACTS_VERSION } from "@/lib/legal/infrastructure";

import { ReportContentForm, ReportStatusLookup } from "./report-content-form";

const PAGE_URL = "https://moosewave.com/legal/report-content";
const PAGE_DESCRIPTION =
  "Report illegal or harmful content hosted by Moosewave, check the outcome of a report you have already made, and find our contact points for authorities and users under the Digital Services Act.";

export const metadata: Metadata = {
  title: "Report content | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true, "max-snippet": -1 },
  openGraph: {
    type: "article",
    url: PAGE_URL,
    title: "Report content to Moosewave",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
  },
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Report content", url: PAGE_URL },
]);

export default function ReportContentPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <JsonLd data={BREADCRUMBS_JSON_LD} />
      <h1>Report content</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: {LEGAL_FACTS_VERSION}. This page is our notice-and-action
        mechanism under Article 16 of the EU Digital Services Act.
      </p>

      <p>
        Moosewave hosts pages that our customers create: signup forms, landing
        pages, public newsletter archives and the comments on them. If you have
        found something on one of those pages that is illegal, or that breaks
        our <Link href="/legal/aup">acceptable use policy</Link>, tell us here.
        Anyone can use this form — you do not need an account and you do not
        need to be a Moosewave customer.
      </p>
      <p>
        We read every report. If content is illegal we act on it as quickly as
        we can, and we will tell you what we decided.
      </p>

      <h2>Report something</h2>
      <ReportContentForm />

      <h2>Check a report you already made</h2>
      <p>
        Enter the reference from your confirmation to see where your report has
        got to and, once we have decided, the reasons for that decision.
      </p>
      <ReportStatusLookup />

      <h2>What happens next</h2>
      <ol>
        <li>
          <strong>We confirm receipt.</strong> You get a reference as soon as
          the report is recorded, and the clock on our response starts at that
          moment.
        </li>
        <li>
          <strong>A person reviews it.</strong> We do not remove content
          automatically. If we ever do use automated means to reach a decision,
          we will say so in the decision itself.
        </li>
        <li>
          <strong>We decide and explain.</strong> If we restrict or remove
          content we give the customer who posted it a statement of reasons, and
          we tell you the outcome of your report.
        </li>
      </ol>
      <p>
        Submitting a report that you know to be false or misleading is itself a
        misuse of this mechanism. We may decline to act on reports from a source
        that repeatedly submits manifestly unfounded notices.
      </p>

      <h2>Other ways to reach us</h2>

      <h3>If you are an authority</h3>
      <p>
        Our single point of contact for Member State authorities, the European
        Commission and the European Board for Digital Services, under Article 11
        of the Digital Services Act, is{" "}
        <a href="mailto:legal@moosewave.com">legal@moosewave.com</a>. We accept
        communications in <strong>English</strong>.
      </p>
      <p>
        Orders to act against illegal content under Article 9, and orders to
        provide information under Article 10, should be sent to the same
        address.
      </p>

      <h3>If you are a user of the service</h3>
      <p>
        Our point of contact for recipients of the service, under Article 12, is{" "}
        <a href="mailto:support@moosewave.com">support@moosewave.com</a>. A person
        reads that inbox — it is not an automated tool, and you can ask to speak
        to a human at any point. For questions specifically about personal data,
        write to <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>{" "}
        or use the rights tools in{" "}
        <Link href="/legal/privacy">our privacy policy</Link>.
      </p>

      <h3>Legal representative in the Union</h3>
      <p>
        Moosewave is not established in the European Union. Article 13 of the
        Digital Services Act requires a provider in that position to designate a
        legal representative in a Member State where it offers its services.{" "}
        <strong>
          That representative has not yet been designated, and we will publish
          their name and address here as soon as it is.
        </strong>{" "}
        Until then, the Article 11 and Article 12 contact points above are the
        routes to us, and they are monitored. The same applies to our
        representative under Article 27 of the GDPR, which is noted in{" "}
        <Link href="/legal/privacy">our privacy policy</Link>.
      </p>

      <h3>Reporting a security vulnerability</h3>
      <p>
        Security reports go to a different place:{" "}
        <a href="/.well-known/security.txt" rel="noopener noreferrer">
          /.well-known/security.txt
        </a>
        .
      </p>

      <h2>Something else</h2>
      <p>
        If you received an email you did not sign up for, the fastest fix is the
        unsubscribe link in that message — it takes effect immediately and needs
        no account. If the sender has ignored it, report it here and choose{" "}
        <em>Spam or unsolicited messages</em>.
      </p>
      <p>
        If you want your personal data removed from a customer&rsquo;s mailing
        list, see the rights section of{" "}
        <Link href="/legal/privacy">our privacy policy</Link>; that route
        reaches the customer who controls the list, which this form does not.
      </p>
    </article>
  );
}
