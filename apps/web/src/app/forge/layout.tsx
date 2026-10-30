// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ForgeMotionPolicy } from "@/app/forge/_components/forge-motion-policy";
import { asRoute } from "@/lib/typed-routes";

export const metadata: Metadata = {
  title: "Moosewave Forge — Release-held agent source review",
  description:
    "Source illustrations for sandbox, budget, approval, and agent concepts whose distribution and runtime qualification remain held.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0F0F0F",
  colorScheme: "dark",
};

const FORGE_NAV: { href: string; label: string }[] = [
  { href: "/forge#release-status", label: "Release status" },
  { href: "/forge#surface", label: "Surface" },
  { href: "/forge#primitives", label: "Primitives" },
  { href: "/forge/docs", label: "Docs" },
  { href: "https://github.com/postwave", label: "GitHub" },
];

export default function ForgeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-pw-ink text-pw-paper antialiased">
      <a
        href="#forge-main"
        className="fixed left-3 top-3 z-[100] -translate-y-24 rounded-md bg-pw-paper px-4 py-2 font-mono text-sm font-semibold text-pw-ink shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-pw-ember-400"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-50 border-b border-white/10 bg-pw-ink/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center px-4 sm:px-6 lg:h-14 lg:flex-nowrap">
          <Link
            href="/forge"
            className="flex h-14 items-center gap-2 font-mono text-sm font-semibold tracking-tight text-pw-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-400"
          >
            <span className="inline-block h-2 w-2 rounded-sm bg-pw-ember-500" />
            Moosewave Forge
          </Link>
          <nav
            aria-label="Forge"
            className="order-3 -mx-4 flex w-[calc(100%+2rem)] touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain border-t border-white/10 px-4 sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 lg:order-none lg:mx-0 lg:ml-auto lg:w-auto lg:border-0 lg:px-0"
          >
            {FORGE_NAV.map((item) => (
              <Link
                key={item.href}
                href={asRoute(item.href)}
                className="inline-flex min-h-11 shrink-0 items-center px-2 font-mono text-xs text-white/60 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-400 lg:min-h-9"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/app"
            className="ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md bg-pw-ember-500 px-3 font-mono text-xs font-medium text-white shadow-[0_2px_0_0_#7A081B] transition-colors hover:bg-pw-ember-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300 lg:ml-4 lg:min-h-9"
          >
            Review hold
          </Link>
        </div>
      </header>
      <main id="forge-main" tabIndex={-1} className="outline-none">
        <ForgeMotionPolicy>{children}</ForgeMotionPolicy>
      </main>
      <footer className="border-t border-white/10 py-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 text-xs text-white/50 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="font-mono">
            Moosewave Forge · release-held agent source review · part of{" "}
            <Link
              href="/"
              className="text-pw-ember-300 underline decoration-pw-ember-300/60 underline-offset-4 hover:text-pw-ember-200"
            >
              Moosewave
            </Link>
          </div>
          <div className="flex flex-wrap gap-x-5 font-mono">
            <Link
              href="https://github.com/postwave"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center hover:text-white md:min-h-0"
            >
              GitHub
            </Link>
            <Link
              href="/docs"
              className="inline-flex min-h-11 items-center hover:text-white md:min-h-0"
            >
              Docs
            </Link>
            <Link
              href="/legal/terms"
              className="inline-flex min-h-11 items-center hover:text-white md:min-h-0"
            >
              Terms
            </Link>
            <Link
              href="/legal/privacy"
              className="inline-flex min-h-11 items-center hover:text-white md:min-h-0"
            >
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
