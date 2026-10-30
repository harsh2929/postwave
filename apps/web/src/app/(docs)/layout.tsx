// Moosewave docs layout - sidebar + topbar + search.
//
// This layout owns the entire `/docs/*` URL space (except `/docs` itself,
// which is owned by the marketing route group `(marketing)/docs/page.tsx`
// and serves as a small hub). The layout is rendered server-side, with
// client islands for the search modal, sidebar interactivity, and the
// existing telemetry / cookie banner / language picker, kept consistent
// with the rest of the app.

import Link from "next/link";
import type { ReactNode } from "react";

import { CopyrightYear } from "@/components/copyright-year";
import { MoosewaveWordmark } from "@/components/brand/moosewave-mark";
import { DocsMobileNav } from "@/components/docs/DocsMobileNav";
import { DocsToc } from "@/components/docs/DocsToc";
import { SearchBar } from "@/components/docs/SearchBar";
import { Sidebar } from "@/components/docs/Sidebar";
import { DocsNavProvider } from "@/components/docs/docs-nav-context";
import { docsNavSummary } from "@/lib/docs/nav-index";

export default function DocsLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  // Sidebar data is derived at build time and memoized, so deriving it is
  // cheap — but DocsNavProvider is a client component, so whatever we pass is
  // re-serialized into the flight payload of every /docs document. The full
  // tree is ~208 KB of JSON for groups that all render collapsed, so only the
  // summary (group names + counts) crosses the boundary here; the sidebar
  // fetches the item-level index from /api/docs/nav on first need (RSC-01).
  const navData = docsNavSummary();

  return (
    <DocsNavProvider value={navData}>
      <div className="flex min-h-dvh flex-col bg-mw-paper text-mw-ink">
        <a
          href="#docs-main"
          className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-pw-ink focus:px-3 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-mw-ink/20 bg-mw-paper backdrop-blur">
          <div className="mx-auto flex min-h-16 max-w-7xl items-center gap-2 px-4 md:min-h-20 md:gap-4 md:px-6">
            <DocsMobileNav />
            <Link
              href="/"
              prefetch={false}
              className="mw-focus-blue flex min-h-11 shrink-0 items-center gap-2 rounded transition-transform hover:-rotate-1 focus-visible:outline-none focus-visible:ring-2"
              aria-label="Moosewave / docs home"
            >
              <MoosewaveWordmark markClassName="size-7" />
              <span
                aria-hidden
                className="ml-1 mt-0.5 hidden font-hand text-lg text-mw-blue md:inline"
              >
                / docs
              </span>
            </Link>
            <nav
              aria-label="Docs primary"
              className="ml-4 hidden items-center gap-2 text-sm text-pw-muted-on-paper md:flex"
            >
              <Link
                href="/docs/getting-started"
                prefetch={false}
                className="inline-flex min-h-9 items-center rounded px-2 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                Get Started
              </Link>
              <Link
                href="/docs/api"
                prefetch={false}
                className="inline-flex min-h-9 items-center rounded px-2 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                API
              </Link>
              <Link
                href="/docs/skills"
                prefetch={false}
                className="inline-flex min-h-9 items-center rounded px-2 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                Skills
              </Link>
              <Link
                href="/docs/migrations"
                prefetch={false}
                className="inline-flex min-h-9 items-center rounded px-2 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                Migrations
              </Link>
              <Link
                href="/docs/changelog"
                prefetch={false}
                className="inline-flex min-h-9 items-center rounded px-2 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                Changelog
              </Link>
            </nav>
            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              {/* Search is now visible on mobile too (one instance — a second
                SearchBar would double-bind the Cmd/Ctrl-K listener). */}
              <div className="block">
                <SearchBar />
              </div>
              <Link
                href="/login"
                prefetch={false}
                className="hidden min-h-9 items-center rounded-md px-3 text-sm text-pw-muted-on-paper transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:inline-flex"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                prefetch={false}
                className="mw-cut-paper mw-focus-blue mw-tactile inline-flex min-h-11 items-center justify-center bg-mw-yellow px-4 text-sm font-semibold text-mw-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 md:min-h-9"
              >
                Sign up
              </Link>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-7xl w-full grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_216px] gap-8 px-4 md:px-6 py-6 md:py-8 flex-1">
          <aside
            className="hidden lg:block sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto pr-2"
            aria-label="Documentation navigation"
          >
            <Sidebar />
          </aside>

          <main
            id="docs-main"
            tabIndex={-1}
            className="min-w-0 outline-none pb-20"
          >
            {children}
          </main>

          {/* Right-rail "On this page" TOC — third column on wide viewports
            (MKTN-010). Derives its entries from the rendered page in a client
            island, so it stays empty (and hidden) on pages without section ids. */}
          <aside
            className="hidden xl:block sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto"
            aria-label="On this page"
          >
            <DocsToc />
          </aside>
        </div>

        <footer className="border-t border-mw-ink/20 bg-mw-paper">
          <div className="mx-auto max-w-7xl px-4 md:px-6 py-6 text-xs text-pw-muted-on-paper flex flex-wrap items-center justify-between gap-3">
            <span>
              © <CopyrightYear buildYear={new Date().getFullYear()} />{" "}
              Moosewave. Pre-production documentation; availability is defined
              by release evidence and executed terms.
            </span>
            <div className="flex gap-2 sm:gap-4">
              <Link
                href="/legal/terms"
                prefetch={false}
                className="inline-flex min-h-11 items-center rounded px-1 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
              >
                Terms
              </Link>
              <Link
                href="/legal/privacy"
                prefetch={false}
                className="inline-flex min-h-11 items-center rounded px-1 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
              >
                Privacy
              </Link>
              <Link
                href="/status"
                prefetch={false}
                className="inline-flex min-h-11 items-center rounded px-1 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
              >
                Status
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </DocsNavProvider>
  );
}
