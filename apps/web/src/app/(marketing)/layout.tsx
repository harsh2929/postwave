// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import type { Viewport } from "next";
import type { ReactNode } from "react";

import { CopyrightYear } from "@/components/copyright-year";
import { MoosewaveWordmark } from "@/components/brand/moosewave-mark";
import { CookieBanner } from "@/components/marketing/cookie-banner";
import { CookiePreferencesButton } from "@/components/marketing/cookie-preferences-button";
import { MarketingMobileNav } from "@/components/marketing/mobile-nav";
import { PreProductionBanner } from "@/components/marketing/pre-production-banner";
import { ProductMenu } from "@/components/marketing/product-menu";
import { JsonLd, organizationSchema } from "@/components/seo/json-ld";
import { TourLauncher } from "@/components/tour/TourLauncher";
import { TourProvider } from "@/components/tour/TourProvider";
import { publicSiteOrigin } from "@/lib/site-url";
import { asRoute } from "@/lib/typed-routes";

const SITE_URL = publicSiteOrigin();

// Marketing deliberately uses the fixed warm-paper palette. Advertising a
// dark UA colour scheme here made native controls (most visibly search fields
// and checkboxes) flip dark for visitors whose OS prefers dark mode while the
// page around them stayed light.
export const viewport: Viewport = {
  themeColor: "#FDFCF8",
  colorScheme: "light",
};

// Cross-page Organization schema. Search engines and AIO crawlers use this
// to build a knowledge-graph entry for "Moosewave" — name, logo, social
// presence, support contact. We do NOT emit a WebSite + SearchAction here:
// there's no real /search endpoint yet, and faking sitelinks-search-box
// markup against a non-existent route gets you penalised, not rewarded.
const ORG_SCHEMA = organizationSchema({
  name: "Moosewave",
  url: SITE_URL,
  logo: `${SITE_URL}/icon.png`,
  description:
    "A pre-production newsletter platform undergoing release qualification, with migration evidence, deliverability tooling, and voice-assisted drafting.",
  sameAs: [],
  email: "hello@moosewave.com",
});

// Top-level links shown alongside the Product mega-menu. Everything else moved
// into the mega-menu (see product-menu.tsx).
const NAV: { href: string; label: string }[] = [
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
];

const FOOTER_PRODUCT: { href: string; label: string }[] = [
  { href: "/features", label: "Features" },
  { href: "/migrations", label: "Migration" },
  { href: "/deliverability", label: "Deliverability" },
  { href: "/voice", label: "Voice AI" },
  { href: "/audiences", label: "Audiences & Ad Sync" },
  { href: "/commerce", label: "Commerce" },
  { href: "/sms", label: "SMS" },
  { href: "/automations", label: "Automations" },
  { href: "/forms", label: "Forms" },
  { href: "/landing-pages", label: "Landing pages" },
  { href: "/analytics", label: "Analytics" },
  { href: "/podcasts", label: "Podcasts" },
  { href: "/pricing", label: "Pricing" },
];

const FOOTER_PLATFORM: { href: string; label: string }[] = [
  { href: "/developers", label: "Developer Platform" },
  { href: "/mcp", label: "MCP source status" },
  { href: "/api-docs", label: "API reference" },
  { href: "/developers#webhooks", label: "Webhooks" },
  { href: "/migrate-anywhere", label: "Migrate Anywhere (OSS)" },
  { href: "/roadmap", label: "Roadmap" },
  { href: "/status", label: "Status" },
];

const FOOTER_COMPARE: { href: string; label: string }[] = [
  { href: "/roadmap", label: "Qualification roadmap" },
  { href: "/security", label: "Security status" },
  { href: "/migrations", label: "Migration paths" },
];

const FOOTER_RESOURCES: { href: string; label: string }[] = [
  { href: "/docs", label: "Docs" },
  { href: "/api-docs", label: "API reference" },
  { href: "/roadmap", label: "Release evidence policy" },
];

// The policies themselves belong here. Before this, the Legal column linked
// only to the two status pages, and /legal/* appeared nowhere else in global
// navigation — the cookie banner reached /legal/cookies and /security reached
// the DPA and sub-processor register, so the Privacy Policy, Terms, Refund
// Policy and AUP were unreachable from any marketing page. Terms §17 rests on
// "continued use constitutes acceptance" and §10 points at the Refund Policy,
// neither of which holds if a reader cannot find the document.
// Three published legal routes were still missing from this list — DPIA,
// Account deletion, and Affiliate terms. Account deletion is the one that
// mattered most: it is the page app-store reviewers and data subjects go
// looking for, and it existed while being reachable from nowhere.
//
// Accessibility sits here rather than under /legal/* on purpose. The EAA
// requires the statement to be reachable by the people it is for, and the
// /legal group is held behind the counsel publication gate
// (lib/legal-publication.ts), so a statement placed there would 404.
const FOOTER_LEGAL: { href: string; label: string }[] = [
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/terms", label: "Terms of Service" },
  { href: "/legal/cookies", label: "Cookie Policy" },
  { href: "/legal/refund", label: "Refund Policy" },
  { href: "/legal/aup", label: "Acceptable Use" },
  { href: "/legal/dpa", label: "DPA" },
  { href: "/legal/dpia", label: "DPIA" },
  { href: "/legal/sub-processors", label: "Sub-processors" },
  { href: "/legal/account-deletion", label: "Account deletion" },
  { href: "/legal/affiliate-terms", label: "Affiliate terms" },
  { href: "/accessibility", label: "Accessibility" },
  { href: "/roadmap", label: "Legal review status" },
  { href: "/security", label: "Control qualification" },
];

const FOOTER_COMPANY: { href: string; label: string }[] = [
  { href: "/about", label: "About" },
  { href: "mailto:hello@moosewave.com", label: "Contact" },
  { href: "/migrations", label: "Switch to Moosewave" },
];

export default function MarketingLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="mw-marketing-shell flex min-h-dvh flex-col"
      style={{ background: "var(--mw-paper)", color: "var(--mw-ink)" }}
    >
      {/* No-JS / no-scroll fallback: scroll-reveal wrappers (FadeRise,
          StaggerItem) set an initial opacity:0 that only clears once their
          IntersectionObserver fires. Without JS that never happens, leaving the
          page blank below the hero. Force the resting (visible) state for any
          revealed element when scripting is unavailable (MKTC-001). */}
      <noscript>
        <style>{`[data-motion-reveal]{opacity:1!important;transform:none!important}`}</style>
      </noscript>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-pw-ink focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <header
        className="sticky top-0 z-40 border-b"
        style={{
          borderColor: "rgb(32 32 30 / 0.1)",
          background: "rgb(255 251 238 / 0.95)",
        }}
      >
        <div className="mx-auto flex h-20 max-w-7xl items-center gap-3 px-4 sm:gap-7 sm:px-8 lg:gap-10">
          <Link
            href="/"
            className="mw-focus-blue group inline-flex min-h-11 shrink-0 items-center rounded-md transition-transform hover:-rotate-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            aria-label="Moosewave home"
          >
            <MoosewaveWordmark labelClassName="max-[359px]:hidden" />
          </Link>
          <nav
            aria-label="Primary"
            className="hidden items-center gap-6 text-sm font-medium lg:flex"
          >
            <ProductMenu />
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={asRoute(item.href)}
                className="mw-focus-blue mw-scribble-link inline-flex min-h-11 items-center rounded px-1 focus-visible:outline-none focus-visible:ring-2"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <MarketingMobileNav
              primaryLinks={NAV}
              productLinks={FOOTER_PRODUCT}
            />
            <Link
              href="/login"
              className="mw-focus-blue hidden min-h-11 items-center rounded-md px-3 transition-colors hover:text-mw-blue focus-visible:outline-none focus-visible:ring-2 sm:inline-flex"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="mw-cut-paper mw-focus-blue mw-tactile inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap bg-mw-yellow px-5 font-hand text-lg font-semibold leading-none text-mw-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-[359px]:px-3 max-[359px]:text-base"
            >
              Request access
            </Link>
          </div>
        </div>
      </header>

      <PreProductionBanner />

      <main
        id="main-content"
        tabIndex={-1}
        className="min-w-0 flex-1 outline-none"
      >
        {children}
      </main>

      <footer
        className="mw-site-footer mt-20 overflow-hidden sm:mt-24"
        style={{
          borderRadius: "3rem 3rem 0 0 / 1.5rem 1.5rem 0 0",
          background: "var(--mw-ink)",
          color: "var(--mw-paper)",
        }}
      >
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-x-6 gap-y-10 px-5 py-12 text-sm sm:px-8 sm:py-16 md:grid-cols-3 lg:grid-cols-6">
          <div>
            <div className="mb-3 font-hand text-xl font-semibold text-mw-yellow">
              Product
            </div>
            <ul className="space-y-2 text-pw-muted-on-ink">
              {FOOTER_PRODUCT.map((l) => (
                <li key={l.href}>
                  <Link
                    href={asRoute(l.href)}
                    className="inline-flex min-h-11 items-center transition-colors hover:text-pw-ink2 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-3 font-hand text-xl font-semibold text-mw-yellow">
              Platform
            </div>
            <ul className="space-y-2 text-pw-muted-on-ink">
              {FOOTER_PLATFORM.map((l) => (
                <li key={l.href}>
                  <Link
                    href={asRoute(l.href)}
                    className="inline-flex min-h-11 items-center transition-colors hover:text-pw-ink2 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-3 font-hand text-xl font-semibold text-mw-yellow">
              Qualification
            </div>
            <ul className="space-y-2 text-pw-muted-on-ink">
              {FOOTER_COMPARE.map((l) => (
                <li key={l.href}>
                  <Link
                    href={asRoute(l.href)}
                    className="inline-flex min-h-11 items-center transition-colors hover:text-pw-ink2 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-3 font-hand text-xl font-semibold text-mw-yellow">
              Resources
            </div>
            <ul className="space-y-2 text-pw-muted-on-ink">
              {FOOTER_RESOURCES.map((l) => (
                <li key={l.href}>
                  <Link
                    href={asRoute(l.href)}
                    className="inline-flex min-h-11 items-center transition-colors hover:text-pw-ink2 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-3 font-hand text-xl font-semibold text-mw-yellow">
              Legal
            </div>
            <ul className="space-y-2 text-pw-muted-on-ink">
              {FOOTER_LEGAL.map((l) => (
                <li key={l.href}>
                  <Link
                    href={asRoute(l.href)}
                    className="inline-flex min-h-11 items-center transition-colors hover:text-pw-ink2 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
              <li>
                <CookiePreferencesButton />
              </li>
            </ul>
          </div>
          <div>
            <div className="mb-3 font-hand text-xl font-semibold text-mw-yellow">
              Company
            </div>
            <ul className="space-y-2 text-pw-muted-on-ink">
              {FOOTER_COMPANY.map((l) => (
                <li key={l.href}>
                  <Link
                    href={asRoute(l.href)}
                    className="inline-flex min-h-11 items-center transition-colors hover:text-pw-ink2 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-5 text-xs text-pw-muted-on-ink sm:px-8">
            <div className="flex items-center gap-2">
              <MoosewaveWordmark
                compact
                markClassName="size-4"
                className="[--mw-logo-cutout:#20201e]"
              />
              <span>
                © <CopyrightYear buildYear={new Date().getFullYear()} />{" "}
                Moosewave. Pre-production release qualification.
              </span>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="mailto:hello@moosewave.com"
                className="inline-flex min-h-11 items-center rounded transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
                aria-label="Contact Moosewave"
              >
                Contact
              </a>
            </div>
          </div>
        </div>
      </footer>
      <CookieBanner />
      <JsonLd data={ORG_SCHEMA} id="moosewave-organization-jsonld" />
      {/* Keep the tour engine as a small client island. Wrapping the public
          page in its provider makes Lighthouse (and slow browsers) wait for
          the tour bundle before treating server-rendered hero text as LCP. */}
      <TourProvider tour="marketing" autoStart={false}>
        <TourLauncher />
      </TourProvider>
    </div>
  );
}
