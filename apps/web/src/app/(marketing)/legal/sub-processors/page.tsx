// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: legal page; intentionally low-weight. Crawlable + canonical +
// breadcrumb only; max-snippet:-1 so AIO can quote sub-processor entries.
import Link from "next/link";
import type { Metadata } from "next";

import { JsonLd, breadcrumbSchema } from "@/components/seo/json-ld";
import {
  INFRASTRUCTURE,
  LEGAL_FACTS_VERSION,
  SUBPROCESSORS,
  TOM_PATH,
} from "@/lib/legal/infrastructure";

const PAGE_URL = "https://moosewave.com/legal/sub-processors";
const PAGE_DESCRIPTION =
  "The full list of third-party services Moosewave uses to operate, what each one does, what data they touch, and where they sit.";

export const metadata: Metadata = {
  title: "Sub-processors | Moosewave",
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
    title: "Moosewave Sub-processors",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/legal/sub-processors/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave sub-processors list",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave Sub-processors",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const BREADCRUMBS_JSON_LD = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Sub-processors", url: PAGE_URL },
]);

export default function SubProcessorsPage(): JSX.Element {
  return (
    <article className="max-w-5xl mx-auto px-6 py-16">
      <JsonLd data={BREADCRUMBS_JSON_LD} />
      <h1>Sub-processors</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: {LEGAL_FACTS_VERSION}. Pending counsel review.
      </p>

      <p>
        Moosewave engages the third-party services below as sub-processors to
        operate the platform. Each one processes a specific category of data for
        a specific purpose.
      </p>

      <h2>Where the platform runs</h2>
      <p>
        Moosewave Cloud runs on {INFRASTRUCTURE.cloudProvider} in{" "}
        <strong>{INFRASTRUCTURE.primaryRegion}</strong>:{" "}
        {INFRASTRUCTURE.compute} for compute, {INFRASTRUCTURE.database} for
        application data, {INFRASTRUCTURE.objectStorage} for object storage, and{" "}
        {INFRASTRUCTURE.secrets}. {INFRASTRUCTURE.edge}.
      </p>
      <p>
        The primary region is in the United States. If you are in the EEA, the
        UK or Switzerland, that means your personal data is transferred to a
        third country as a matter of course rather than by exception, and the
        transfer mechanism in the table below is the basis we rely on for it.
        The safeguards behind those mechanisms are described in our{" "}
        <Link href={TOM_PATH}>technical and organisational measures</Link>.
      </p>
      <p className="text-pw-muted-on-paper text-sm">
        <strong>Canonical</strong> sub-processors are in the deploy path for
        every workspace. <strong>Conditional</strong> ones are engaged only when
        a workspace uses the feature they support — if you never enable AI
        features, SMS or a non-SES transactional sender, the corresponding
        vendors never receive your data.
      </p>

      <div
        role="region"
        aria-label="Sub-processor register"
        tabIndex={0}
        className="not-prose mt-6 overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
      >
        <table className="w-full text-sm">
          <thead className="bg-pw-surface">
            <tr>
              <th scope="col" className="text-left p-3 font-medium">
                Sub-processor
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                Purpose
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                Data category
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                Region
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                EU/UK transfer basis
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                Engaged
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                DPA
              </th>
            </tr>
          </thead>
          <tbody>
            {SUBPROCESSORS.map((r) => (
              <tr key={r.name} className="border-t align-top">
                <td className="p-3">
                  <div className="font-medium">{r.name}</div>
                  <a
                    href={r.url}
                    rel="noopener noreferrer"
                    className="text-xs underline text-pw-muted-on-paper"
                  >
                    {r.url.replace("https://", "")}
                  </a>
                </td>
                <td className="p-3 text-pw-muted-on-paper">{r.purpose}</td>
                <td className="p-3 text-pw-muted-on-paper">{r.data}</td>
                <td className="p-3 text-pw-muted-on-paper">{r.region}</td>
                <td className="p-3 text-pw-muted-on-paper">{r.transfer}</td>
                <td className="p-3 text-pw-muted-on-paper">
                  {r.assurance === "canonical" ? "Always" : "When enabled"}
                </td>
                <td className="p-3">
                  <a
                    href={r.dpa}
                    rel="noopener noreferrer"
                    className="text-xs underline"
                  >
                    DPA
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Customer notification policy</h2>
      <p>
        We give customers <strong>30 days notice</strong> before adding a new
        sub-processor or materially changing the role of an existing one. Notice
        is delivered to the account owner’s email address and posted to this
        page with a dated changelog entry.
      </p>
      <p>
        If you want to object to a new sub-processor, raise it on reasonable
        data protection grounds <strong>within 15 days of the notice</strong> —
        that deadline is set by <Link href="/legal/dpa">DPA</Link> §7.4, which
        governs this page as its Annex 3. If we cannot resolve the objection in
        good faith, you may terminate the affected portion of the Service and
        receive a prorated refund of any unused prepaid recurring fees. The
        subscription remains governed by the published Refund Policy, and you
        retain the data-export rights described in the Terms. This policy
        creates no self-host, escrow,
        or continuity commitment.
      </p>

      <h2>Notification subscription</h2>
      <p>
        To receive sub-processor change notifications, ensure your account owner
        email is current and that you have not opted out of policy emails
        (Settings &rarr; Notifications). Customers with executed enterprise DPAs
        receive notifications to the designated DPA contact in addition to the
        account owner.
      </p>

      <h2>Changelog</h2>
      <ul>
        {/* legal-vendor-claim-ok: a register that drops vendors without
            saying so is its own transparency failure. */}
        <li>
          <strong>2026-09-05</strong>. Corrected to match the deployed platform.
          Added Amazon Web Services, which operates the compute, database,
          object storage, secrets and sending path and had been omitted.
          Added Twilio (SMS). Removed Hetzner and Neon, which described a
          prototype that was never a Moosewave Cloud platform, and Vercel, which
          is not used. Reclassified Postmark from primary sending pipe to
          optional transactional and domain-provisioning provider. Added the
          EU/UK transfer basis and the engagement condition for every entry.
        </li>
        <li>
          <strong>2026-04-30</strong>. Initial published list (V1 launch).
        </li>
      </ul>

      <p>
        Questions:{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>
      </p>
    </article>
  );
}
