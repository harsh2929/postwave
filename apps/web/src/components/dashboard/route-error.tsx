// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { captureClientBoundaryError } from "@/lib/client-error-reporting";

import { useBoundaryReset } from "./use-boundary-reset";

export function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const errorCardRef = useRef<HTMLDivElement>(null);
  // React.lazy remembers a rejected module import. Resetting only the React
  // boundary reuses that rejection after a dev-worker restart or stale deploy.
  const reloadRequired =
    error.name === "ChunkLoadError" ||
    /Loading (?:CSS )?chunk .+ failed/i.test(error.message);
  const { resetFailed, resetting, retry } = useBoundaryReset(() => {
    if (reloadRequired) window.location.reload();
    else return reset();
  });

  useEffect(() => {
    captureClientBoundaryError(error);
    errorCardRef.current?.focus();
  }, [error]);

  return (
    <div
      ref={errorCardRef}
      role="alert"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={resetting || undefined}
      tabIndex={-1}
      className="mx-auto w-full min-w-0 max-w-3xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:p-6"
    >
      <Card className="min-w-0 border-destructive/30">
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive-emphasis"
              aria-hidden
            >
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <CardTitle
                as="h1"
                id={headingId}
                className="[overflow-wrap:anywhere]"
              >
                Could not load this view
              </CardTitle>
              <CardDescription
                id={descriptionId}
                className="[overflow-wrap:anywhere]"
              >
                {reloadRequired
                  ? "This page’s files could not load. Reload the view to try again."
                  : "The rest of the app is still available. Retry this view after the connection or service recovers."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="rounded-md border border-border/60 bg-muted p-3 font-mono text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            Error reference: {error.digest ?? "unavailable"}
          </p>
          {resetFailed ? (
            <p
              role="alert"
              className="text-sm text-destructive-emphasis [overflow-wrap:anywhere]"
            >
              Retry could not be started. Return to the dashboard, or try again.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              onClick={retry}
              loading={resetting}
              className="min-h-11 w-full sm:w-auto"
            >
              <RefreshCw aria-hidden="true" />
              {resetting
                ? "Retrying…"
                : reloadRequired
                  ? "Reload view"
                  : "Retry"}
            </Button>
            <Button
              asChild
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
            >
              <Link href="/app">
                <ArrowLeft aria-hidden="true" />
                Back to dashboard
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
