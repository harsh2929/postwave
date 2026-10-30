// SPDX-License-Identifier: AGPL-3.0-only
//
// A provider redirect is not payment evidence. Until this route can exchange a
// short-lived server-issued completion receipt against the webhook projection,
// it must remain neutral for both missing and attacker-supplied query strings.

import type { Metadata } from "next";
import Link from "next/link";

import { pageMetadata } from "@/lib/marketing-metadata";

export const metadata: Metadata = pageMetadata({
  title: "Checkout status | Moosewave",
  description:
    "Return to Moosewave after checkout and verify account status from a signed email or the billing page.",
  path: "/pricing/success",
});

export default function PricingSuccessPage(): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto px-6 py-20 md:py-28">
      <div className="rounded-xl border border-pw-ink2/10 bg-pw-paper p-8 md:p-12">
        <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-700">
          Checkout return
        </div>
        <h1 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight text-pw-ink2">
          We can&apos;t verify a payment from this page.
        </h1>
        <p className="mt-4 text-pw-muted-on-paper text-lg leading-relaxed">
          A redirect or URL parameter is not proof that a charge succeeded. Do
          not retry payment from a copied link. Use a signed message from Dodo
          Payments or check the billing page after signing in.
        </p>

        <div className="mt-8 rounded-lg border border-pw-ink2/10 bg-pw-ink2/[0.025] p-5 text-sm leading-relaxed text-pw-ink2/90">
          Paid checkout is currently marked Coming soon. Moosewave will only
          show a confirmed purchase here after the signed payment webhook and
          workspace entitlement agree.
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/app/billing"
            prefetch={false}
            className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
          >
            Check billing status
          </Link>
          <Link
            href="/pricing"
            className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
          >
            Back to pricing
          </Link>
        </div>

        <p className="mt-10 border-t border-pw-ink2/10 pt-5 text-xs text-pw-muted-on-paper">
          Need help reconciling a real charge? Forward the provider receipt to{" "}
          <a
            href="mailto:founders@moosewave.com"
            className="underline hover:text-pw-ember-700"
          >
            founders@moosewave.com
          </a>
          . Do not send card details.
        </p>
      </div>
    </div>
  );
}
