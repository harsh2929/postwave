// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Affiliate program unavailable | Moosewave",
  description:
    "Moosewave is not accepting affiliate applications and does not currently offer public affiliate tracking, commissions, or payouts.",
  robots: { index: false, follow: false, nocache: true },
};

export default function AffiliatesUnavailablePage(): JSX.Element {
  return (
    <section
      aria-labelledby="affiliate-status-title"
      className="mx-auto max-w-3xl px-6 py-24"
    >
      <div className="text-xs font-medium uppercase tracking-widest text-pw-ember-700">
        Program status
      </div>
      <h1
        id="affiliate-status-title"
        className="mt-3 text-4xl font-semibold tracking-tight text-pw-ink2"
      >
        Affiliate enrollment is closed.
      </h1>
      <p className="mt-5 leading-relaxed text-pw-muted-on-paper">
        Moosewave is not accepting affiliate applications, issuing public
        tracking links, recording affiliate attribution, promising commissions,
        or offering affiliate payouts.
      </p>
      <p className="mt-4 leading-relaxed text-pw-muted-on-paper">
        No commission rate, attribution window, payment schedule, eligibility
        rule, or other commercial term is currently offered. Draft code,
        schemas, screens, and documents do not create an affiliate relationship
        or payment right.
      </p>
      <p className="mt-4 leading-relaxed text-pw-muted-on-paper">
        If a program launches, its complete versioned terms and privacy
        disclosures will be published before any enrollment or tracking begins,
        and participation will require explicit acceptance.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex text-sm font-medium text-pw-ember-700 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
      >
        Return to Moosewave
      </Link>
    </section>
  );
}
