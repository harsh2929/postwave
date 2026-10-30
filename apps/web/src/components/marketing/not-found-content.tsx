// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

import { asRoute } from "@/lib/typed-routes";

const LINKS: { href: string; label: string }[] = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
];

/**
 * Marketing-styled not-found body (MKTC-002 / MKTP-009 / MKTN-002).
 *
 * Public visitors who mistype a URL must not see the dashboard 404
 * ("another workspace" / "Back to dashboard" → /app). This body uses pw-*
 * brand tokens, public copy, and a primary CTA back to the public home.
 * It carries no header/footer of its own so it can be composed inside the
 * marketing chrome (the marketing group's layout, or the standalone header
 * in the root not-found boundary).
 */
export function MarketingNotFoundContent(): JSX.Element {
  return (
    <section
      aria-labelledby="marketing-not-found-title"
      className="mx-auto flex w-full min-w-0 max-w-2xl flex-col items-start px-4 py-16 sm:px-6 sm:py-24 md:py-32"
    >
      <p className="font-hand text-2xl text-mw-blue">404</p>
      <h1
        id="marketing-not-found-title"
        className="mw-display mt-3 max-w-full break-words text-6xl text-mw-ink md:text-8xl"
      >
        We couldn&apos;t find that page.
      </h1>
      <p className="mt-4 max-w-xl [overflow-wrap:anywhere] text-pw-muted-on-paper">
        The link may be out of date or the page may have moved. Head back to the
        home page, or jump straight to one of the sections below.
      </p>
      <div className="mt-8 flex w-full flex-col gap-3 min-[360px]:w-auto min-[360px]:flex-row min-[360px]:flex-wrap">
        <Link
          href="/"
          className="mw-cut-paper mw-focus-blue mw-tactile inline-flex min-h-11 w-full max-w-full items-center justify-center bg-mw-yellow px-5 py-2.5 text-center text-sm font-semibold text-mw-ink [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 min-[360px]:w-auto"
        >
          Back to home
        </Link>
        <Link
          href="/features"
          className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-pw-surface px-5 py-2.5 text-center text-sm font-medium text-pw-ink2 transition-colors [overflow-wrap:anywhere] hover:bg-pw-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2 min-[360px]:w-auto"
        >
          Browse features
        </Link>
      </div>
      <div className="mt-10 w-full border-t border-pw-surface pt-6">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-pw-muted-on-paper">
          Popular destinations
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {LINKS.map((l) => (
            <li key={l.href} className="min-w-0">
              <Link
                href={asRoute(l.href)}
                className="inline-flex min-h-11 max-w-full items-center rounded-sm px-1 text-pw-ink2 underline-offset-4 transition-colors [overflow-wrap:anywhere] hover:text-pw-ember-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
