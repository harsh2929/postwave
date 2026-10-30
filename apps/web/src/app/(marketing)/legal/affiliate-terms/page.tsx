// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Affiliate program terms unavailable | Moosewave",
  description:
    "Moosewave has no active public affiliate program or affiliate terms in force.",
  alternates: { canonical: "https://moosewave.com/legal/affiliate-terms" },
  robots: { index: false, follow: false, nocache: true },
};

export default function AffiliateTermsUnavailablePage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-xs font-medium uppercase tracking-widest text-pw-ember-700">
        Program unavailable
      </p>
      <h1>No affiliate program terms are in force</h1>
      <p>
        This URL is retained only to make the program&apos;s closed status
        unambiguous. Moosewave is not accepting affiliate applications, issuing
        affiliate tracking identifiers, attributing sales to affiliates,
        promising commissions, or offering affiliate payouts.
      </p>
      <p>
        There is no public affiliate offer to accept. Nothing on this page, in
        source code, in a draft document, or in an internal screen creates an
        affiliate relationship, commission entitlement, or payment obligation.
      </p>
      <h2>If a program launches later</h2>
      <p>
        Moosewave will publish a dated, versioned, counsel-reviewed agreement
        before enrollment or tracking begins. It will define the contracting
        entity, eligibility, attribution, privacy, commission calculation,
        reversals, taxes, payout controls, disputes, and termination. A future
        agreement will apply only after a participant explicitly accepts that
        version; it will not apply retroactively merely because this URL exists.
      </p>
      <p>
        The current public status is available on the{" "}
        <Link href="/affiliates">affiliate program page</Link>.
      </p>
    </article>
  );
}
