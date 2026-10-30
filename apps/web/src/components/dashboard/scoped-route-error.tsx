// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { captureClientBoundaryError } from "@/lib/client-error-reporting";
import { asRoute } from "@/lib/typed-routes";

import { useBoundaryReset } from "./use-boundary-reset";

export interface ScopedRouteErrorProps {
  backHref: string;
  backLabel: string;
  description: string;
  error: Error & { digest?: string };
  reset: () => void | Promise<void>;
  title: string;
}

/** PII-safe, in-context recovery UI for a leaf dashboard route. */
export function ScopedRouteError({
  backHref,
  backLabel,
  description,
  error,
  reset,
  title,
}: ScopedRouteErrorProps) {
  const headingId = useId();
  const descriptionId = useId();
  const errorCardRef = useRef<HTMLElement>(null);
  const { resetFailed, resetting, retry } = useBoundaryReset(reset);

  useEffect(() => {
    captureClientBoundaryError(error);
    errorCardRef.current?.focus();
  }, [error]);

  return (
    <section
      ref={errorCardRef}
      role="alert"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={resetting || undefined}
      tabIndex={-1}
      className="mx-auto w-full min-w-0 max-w-xl px-4 py-10 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-6 sm:py-16"
    >
      <div className="min-w-0 rounded-2xl border border-destructive/30 bg-card p-5 text-left shadow-sm sm:p-7">
        <span
          className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive-emphasis"
          aria-hidden="true"
        >
          <AlertTriangle className="h-5 w-5" />
        </span>
        <h1
          id={headingId}
          className="font-display text-xl font-semibold tracking-tight [overflow-wrap:anywhere]"
        >
          {title}
        </h1>
        <p
          id={descriptionId}
          className="mt-2 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]"
        >
          {description}
        </p>
        <p className="mt-4 rounded-md border border-border/60 bg-muted p-3 font-mono text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          Error reference: {error.digest ?? "unavailable"}
        </p>
        {resetFailed ? (
          <p
            role="alert"
            className="mt-3 text-sm text-destructive-emphasis [overflow-wrap:anywhere]"
          >
            Retry could not be started. Use the safe navigation link below, or
            try again.
          </p>
        ) : null}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            onClick={retry}
            loading={resetting}
            className="min-h-11 w-full sm:w-auto"
          >
            <RefreshCw aria-hidden="true" />
            {resetting ? "Retrying…" : "Try again"}
          </Button>
          <Button
            asChild
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
          >
            <Link href={asRoute(backHref)}>
              <ArrowLeft aria-hidden="true" />
              {backLabel}
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
