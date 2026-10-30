// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { captureClientBoundaryError } from "@/lib/client-error-reporting";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const errorCardRef = useRef<HTMLDivElement>(null);
  const resetLockRef = useRef(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    // Scrub PII patterns from the error message before reporting.
    // Audit finding (frontend PII): Sentry's beforeSend hook in
    // instrumentation-client strips request bodies + cookies + auth
    // headers, but NOT exception messages. An API error whose
    // message embeds a subscriber email (e.g. "user alice@x.com
    // not found") would otherwise reach Sentry intact.
    captureClientBoundaryError(error);
    errorCardRef.current?.focus();
  }, [error]);

  function retry() {
    if (resetLockRef.current) return;
    resetLockRef.current = true;
    setResetting(true);
    reset();
    // `reset` normally replaces this boundary. If the same failure remains,
    // release the same-tick activation lock so Retry is still available.
    queueMicrotask(() => {
      resetLockRef.current = false;
      if (errorCardRef.current?.isConnected) setResetting(false);
    });
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <main className="min-h-dvh bg-muted/20 px-4 py-8 text-foreground sm:px-6 sm:py-16">
          <div
            ref={errorCardRef}
            role="alert"
            tabIndex={-1}
            className="mx-auto max-w-xl rounded-2xl border border-destructive/25 bg-card p-5 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:p-8"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Runtime error
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              Something broke while loading Moosewave.
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The app caught the failure before it could leave you on a blank
              screen. Retry the view; if it repeats, the error digest is{" "}
              <span className="break-all font-mono [overflow-wrap:anywhere]">
                {error.digest ?? "unavailable"}
              </span>
              .
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Button
                type="button"
                className="min-h-11"
                loading={resetting}
                onClick={retry}
              >
                <RefreshCw className="h-4 w-4" />
                {resetting ? "Retrying…" : "Retry"}
              </Button>
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/">
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  Back to home
                </Link>
              </Button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
