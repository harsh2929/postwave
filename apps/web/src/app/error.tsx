// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBoundaryReset } from "@/components/dashboard/use-boundary-reset";
import { captureClientBoundaryError } from "@/lib/client-error-reporting";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const errorCardRef = useRef<HTMLDivElement>(null);
  const { resetFailed, resetting, retry } = useBoundaryReset(() => {
    // A failed Server Component payload (for example the workspace layout
    // during an API outage) stays cached across a client-only reset. Request
    // a fresh document only when the user retries that server failure.
    if (error.digest) window.location.reload();
    else return reset();
  });

  useEffect(() => {
    captureClientBoundaryError(error);
    errorCardRef.current?.focus();
  }, [error]);

  return (
    <main className="min-h-dvh bg-muted/20 px-4 py-8 text-foreground sm:px-6 sm:py-16">
      <div
        ref={errorCardRef}
        role="alert"
        aria-labelledby="app-error-title"
        aria-describedby="app-error-description"
        aria-busy={resetting || undefined}
        tabIndex={-1}
        className="mx-auto w-full min-w-0 max-w-xl rounded-2xl border border-destructive/25 bg-card p-5 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:p-8"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Runtime error
        </p>
        <h1
          id="app-error-title"
          className="mt-2 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]"
        >
          Something broke while loading Moosewave.
        </h1>
        <p
          id="app-error-description"
          className="mt-3 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]"
        >
          The app caught the failure before it could leave you on a blank
          screen. Retry the view; if it repeats, the error digest is{" "}
          <span className="font-mono [overflow-wrap:anywhere]">
            {error.digest ?? "unavailable"}
          </span>
          .
        </p>
        {resetFailed ? (
          <p
            role="alert"
            className="mt-4 text-sm text-destructive-emphasis [overflow-wrap:anywhere]"
          >
            Retry could not be started. Return home, or try again.
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button
            type="button"
            onClick={retry}
            loading={resetting}
            className="min-h-11 w-full sm:w-auto"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {resetting ? "Retrying…" : "Retry"}
          </Button>
          <Button
            asChild
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
          >
            <Link href="/">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to home
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
