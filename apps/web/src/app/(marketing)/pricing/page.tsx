// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { CheckoutCTA } from "./_components/checkout-cta";
import { FaqItem } from "./_components/faq-item";
import { pageMetadata } from "@/lib/marketing-metadata";
import { TIERS } from "@/lib/pricing";
import { cn } from "@/lib/utils";

const PRICING_DESCRIPTION =
  "Moosewave pricing: Sandbox, Launch, Growth, and Scale plans with finite, predictable allowances.";

export const metadata: Metadata = pageMetadata({
  title: "Pricing | Moosewave",
  description: PRICING_DESCRIPTION,
  path: "/pricing",
  eyebrow: "Pricing",
  ogSubtitle: "Predictable monthly plans. No surprise overage bills.",
});

const FAQ: { q: string; a: string }[] = [
  {
    q: "Can I subscribe now?",
    a: "Not yet. Monthly checkout is marked Coming soon while the final legal documents and Dodo payment, refund, cancellation, and customer-portal rehearsals are completed.",
  },
  {
    q: "What counts as an active profile?",
    a: "One unique, currently emailable person, deduplicated across lists. Suppressed, unsubscribed, bounced, and archive-only records do not count toward the active-profile allowance.",
  },
  {
    q: "What counts toward the monthly sending allowance?",
    a: "One recipient accepted for provider submission. A recipient rejected by suppression or validation before submission does not count. A retry counts only when it is submitted again.",
  },
  {
    q: "What happens at the allowance?",
    a: "Moosewave warns at 70%, 85%, and 100%, then stops new sends at 100%. There is no automatic overage bill and unused allowance does not roll over. You can upgrade or request a reviewed capacity order.",
  },
  {
    q: "Can I use my own sender?",
    a: "That is the intended sender-choice model. The same accepted-recipient allowance applies to managed and customer-controlled routes so switching routes cannot bypass a plan limit. Exact provider availability is shown during onboarding.",
  },
  {
    q: "Is annual billing available?",
    a: "Annual billing is Coming soon. The planned prices are $390 for Launch, $990 for Growth, and $3,890 for Scale. Monthly allowances would still reset monthly. Annual checkout will stay closed until its separate Dodo products are implemented and rehearsed.",
  },
  {
    q: "What's Sandbox for?",
    a: "Sandbox is the evaluation environment for simulated profiles, sends, engagement events, and migration dry-runs. It cannot deliver to production recipients.",
  },
  {
    q: "How will cancellation and refunds work?",
    a: "The intended policy is a 14-day first-subscription refund, once per workspace or customer, followed by cancellation at period end. Renewals are otherwise non-refundable except where law requires or for duplicate, unauthorized, or material-service-failure cases. The published policy at checkout will control.",
  },
  {
    q: "Can I migrate without paying first?",
    a: "Use an available Sandbox workspace to run a dry-run before committing data. The migration wizard lists the sources enabled for that environment, and its report identifies translated, preserved-for-review, and unsupported records before import.",
  },
  {
    q: "Are AI and Inbox Reality unlimited?",
    a: "No. Every paid plan has finite AI-credit, rendered-preview, and full Inbox Reality allowances. Moosewave reports evidence from the configured inbox roster; it does not guarantee inbox placement.",
  },
  {
    q: "What about GDPR / DPA / privacy?",
    a: "The product includes privacy-oriented export, suppression, consent, and audit tooling. Those features do not by themselves make a customer compliant. DPA availability, processing location, subprocessors, and contractual commitments must be confirmed in an executed agreement; public legal drafts are not counsel approval.",
  },
];

export default function PricingPage(): JSX.Element {
  return (
    <div>
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight">
            Predictable plans. Hard limits. No surprise bill.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Choose a monthly allowance that fits the team you have now. Paid
            plans are Coming soon while payment and legal release checks finish.
          </p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6 py-20 space-y-24">
        {/* The approved catalog is visible; paid activation remains release-held. */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {TIERS.map((t, i) => {
            const isFeatured = i === 2; // Growth is the balanced default.
            return (
              <div
                key={t.tier}
                className={cn(
                  "rounded-xl border bg-pw-paper p-6 flex flex-col",
                  isFeatured
                    ? "border-pw-ember-500 ring-1 ring-pw-ember-500/20 shadow-sm"
                    : "border-pw-ink2/10",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-base font-semibold text-pw-ink2">
                      {t.name}
                    </div>
                    <div className="mt-1 text-xs text-pw-muted-on-paper">
                      {t.tagline}
                    </div>
                  </div>
                  {isFeatured ? (
                    <span className="text-[10px] font-mono uppercase tracking-wider text-pw-ember-700 bg-pw-ember-50 px-2 py-0.5 rounded shrink-0">
                      Coming soon
                    </span>
                  ) : null}
                </div>
                <div className="mt-5 flex items-baseline gap-2">
                  <span className="text-4xl font-semibold tracking-tight text-pw-ink2">
                    {t.price}
                  </span>
                  <span className="text-sm text-pw-muted-on-paper">
                    {t.cadence === "free" ? "free" : "/ month"}
                  </span>
                </div>
                <div className="mt-2 text-xs font-mono text-pw-muted-on-paper">
                  {t.annualPrice
                    ? `${t.annualPrice} planned annually · Coming soon`
                    : "simulation only · no production recipients"}
                </div>
                <ul className="mt-6 space-y-2 text-sm flex-1">
                  {t.features.map((f) => (
                    <li
                      key={f.label}
                      className={cn(
                        "flex gap-2 items-start",
                        !f.included && "text-pw-muted-on-paper line-through",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          f.included
                            ? "text-pw-ember-600"
                            : "text-pw-muted-on-paper",
                          "leading-6",
                        )}
                      >
                        {f.included ? "✓" : "·"}
                      </span>
                      <span>{f.label}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  <CheckoutCTA
                    tier={t.tier}
                    isFeatured={isFeatured}
                    label={
                      t.cadence === "free"
                        ? "Request Sandbox access"
                        : `Join the ${t.name} waitlist`
                    }
                  />
                </div>
              </div>
            );
          })}
        </section>

        {/* FAQ */}
        <section>
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Frequently asked.
          </h2>
          <div className="mt-6 border-t border-pw-ink2/10">
            {FAQ.map((f) => (
              <FaqItem key={f.q} q={f.q} a={f.a} />
            ))}
          </div>
          <p className="mt-4 text-sm text-pw-muted-on-paper">
            Prices are in USD and exclude applicable indirect tax. Taxes will
            be calculated at checkout. Paid checkout remains closed until the
            published legal terms and payment rehearsal are approved.
          </p>
        </section>

        {/* Final CTA */}
        <section className="text-center border-t border-pw-ink2/10 pt-12">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Review migration evidence before purchase.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            If a Sandbox workspace and your source adapter are enabled in the
            evaluation environment, run a dry-run and review its translated,
            preserved, and unsupported records before choosing a plan.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/migrations"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              Review migration options →
            </Link>
            <Link
              href="/signup"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              Review current signup terms
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
