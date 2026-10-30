// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { CheckCircle2, CloudOff, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OfflinePendingLink } from "@/components/offline-pending-link";
import { OfflineStatus } from "@/components/offline/offline-status";

export const metadata = {
  title: "Offline",
};

export default function OfflinePage() {
  return (
    <div className="min-h-dvh overflow-x-hidden bg-muted/20 text-foreground">
      <a
        href="#offline-main"
        className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-foreground focus:px-3 focus:text-sm focus:font-medium focus:text-background focus:not-sr-only"
      >
        Skip to content
      </a>
      <main
        id="offline-main"
        tabIndex={-1}
        className="mx-auto flex min-h-dvh max-w-2xl items-center px-4 py-8 outline-none sm:px-6 sm:py-12"
      >
        <div className="w-full rounded-2xl border bg-card p-5 shadow-sm sm:p-8">
          <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <WifiOff className="size-5" aria-hidden="true" />
          </div>
          <p className="mt-5 text-sm font-medium text-muted-foreground">
            Moosewave
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            You are offline
          </h1>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Your connection dropped, but previously loaded work can still be
            useful. Moosewave will clearly separate what is available now from
            actions that need the server.
          </p>

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <section className="rounded-xl border bg-muted/20 p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <CheckCircle2
                  className="size-4 text-emerald-600"
                  aria-hidden="true"
                />
                Available offline
              </h2>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-5 text-muted-foreground marker:text-muted-foreground/60">
                <li>Cached dashboards and recent campaign summaries</li>
                <li>Previously loaded subscribers and public archives</li>
                <li>Supported form and segment edits, queued for replay</li>
              </ul>
            </section>
            <section className="rounded-xl border bg-muted/20 p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <CloudOff
                  className="size-4 text-amber-600"
                  aria-hidden="true"
                />
                Connection required
              </h2>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-5 text-muted-foreground marker:text-muted-foreground/60">
                <li>Sends, campaign edits, and subscriber changes</li>
                <li>Deletes, billing, imports, and OAuth connections</li>
                <li>API keys and compliance workflows</li>
              </ul>
            </section>
          </div>

          <OfflinePendingLink />
          <OfflineStatus />
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Button asChild className="min-h-11 w-full sm:w-auto">
              <Link href="/app">Open dashboard</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
            >
              <Link href="/">Home</Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
