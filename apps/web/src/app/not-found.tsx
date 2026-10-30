// SPDX-License-Identifier: AGPL-3.0-only
//
// Global not-found boundary. It catches URLs that never resolve into a route
// group, so it must be public-safe: a mistyped public URL previously landed on
// the dashboard 404 ("another workspace" / "Back to dashboard" → /app). This
// renders marketing chrome (header + footer, pw-* brand tokens) with public
// CTAs instead (MKTC-002 / MKTP-009 / MKTN-002). Authenticated /app routes get
// the dashboard-flavored 404 from the (dashboard) boundary.
import type { Metadata } from "next";
import Link from "next/link";

import { CopyrightYear } from "@/components/copyright-year";
import { MoosewaveWordmark } from "@/components/brand/moosewave-mark";
import { MarketingNotFoundContent } from "@/components/marketing/not-found-content";

export const metadata: Metadata = {
  title: "Page not found | Moosewave",
  robots: { index: false, follow: true },
};

export default function NotFoundPage(): JSX.Element {
  return (
    <div className="flex min-h-dvh min-w-0 flex-col overflow-x-clip bg-mw-paper text-mw-ink">
      <a
        href="#not-found-main"
        className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-pw-ink2 focus:px-3 focus:text-sm focus:font-medium focus:text-pw-paper focus:not-sr-only"
      >
        Skip to content
      </a>
      <header className="border-b border-mw-ink/20 bg-mw-paper backdrop-blur">
        <div className="mx-auto flex min-h-16 w-full min-w-0 max-w-6xl items-center gap-4 px-4 sm:gap-8 sm:px-6">
          <Link
            href="/"
            className="mw-focus-blue flex min-h-11 shrink-0 items-center rounded transition-transform hover:-rotate-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            aria-label="Moosewave home"
          >
            <MoosewaveWordmark markClassName="size-7" />
          </Link>
          <nav
            aria-label="Primary"
            className="hidden items-center gap-6 text-sm text-pw-muted-on-paper md:flex"
          >
            <Link
              href="/features"
              className="inline-flex min-h-11 items-center rounded-sm transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              Features
            </Link>
            <Link
              href="/pricing"
              className="inline-flex min-h-11 items-center rounded-sm transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              Pricing
            </Link>
            <Link
              href="/docs"
              className="inline-flex min-h-11 items-center rounded-sm transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              Docs
            </Link>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">
            <Link
              href="/signup"
              className="mw-cut-paper mw-focus-blue mw-tactile inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap bg-mw-yellow px-5 py-2 text-sm font-semibold text-mw-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            >
              Request access
            </Link>
          </div>
        </div>
      </header>

      <main
        id="not-found-main"
        tabIndex={-1}
        className="min-w-0 flex-1 outline-none"
      >
        <MarketingNotFoundContent />
      </main>

      <footer className="border-t border-mw-ink/20 bg-mw-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-pw-muted-on-paper sm:px-6">
          <span>
            © <CopyrightYear buildYear={new Date().getFullYear()} /> Moosewave.
          </span>
          <a
            href="mailto:hello@moosewave.com"
            className="inline-flex min-h-11 items-center rounded-sm px-1 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
          >
            Contact
          </a>
        </div>
      </footer>
    </div>
  );
}
