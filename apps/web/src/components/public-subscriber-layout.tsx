// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

import { LanguagePicker } from "@/components/LanguagePicker";

interface PublicSubscriberLayoutProps {
  children: ReactNode;
  poweredBy: string;
  skipLabel: string;
  mainId?: string;
  showPoweredBy?: boolean;
}

/**
 * Quiet, publisher-neutral chrome for tokenized subscriber journeys.
 *
 * Forms, preferences, and legacy gift links are opened from email or an
 * embed, often on a phone. They should feel related without inheriting the
 * marketing header or dashboard navigation. This shell also centralizes the
 * skip target, safe-area spacing, locale picker, and focus treatment so the
 * small terminal-state pages receive the same care as the interactive ones.
 */
export function PublicSubscriberLayout({
  children,
  poweredBy,
  skipLabel,
  mainId = "public-subscriber-main",
  showPoweredBy = true,
}: PublicSubscriberLayoutProps): JSX.Element {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden bg-muted/30 text-foreground">
      <a
        href={`#${mainId}`}
        className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-foreground focus:px-3 focus:text-sm focus:font-medium focus:text-background focus:not-sr-only"
      >
        {skipLabel}
      </a>

      <main
        id={mainId}
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-4 py-8 outline-none sm:px-6 sm:py-12"
      >
        <div className="w-full max-w-lg">{children}</div>
      </main>

      <footer className="border-t border-border/70 bg-background/75 px-4 py-4 text-xs text-muted-foreground backdrop-blur-sm [padding-bottom:max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-lg flex-col items-center justify-between gap-3 sm:flex-row">
          <LanguagePicker />
          {showPoweredBy ? (
            <div className="flex min-h-11 items-center sm:min-h-9">
              {poweredBy}{" "}
              <a
                href="https://moosewave.com"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 inline-flex min-h-11 items-center rounded-sm px-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9"
              >
                Moosewave
              </a>
            </div>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
