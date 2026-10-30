// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Shared load/empty chrome for the list-detail extra tabs. A failed read
 * renders a distinct alert with the server's sentence and a retry — never the
 * empty state — so an outage is not mistaken for "no data yet".
 */
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";

export function LoadFailure({
  what,
  error,
  busy,
  onRetry,
}: {
  what: string;
  error: unknown;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
    >
      <p className="font-medium text-destructive">{what} could not be loaded</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {apiErrorMessage(error, `The ${what.toLowerCase()} request failed`)}
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-3 gap-2"
        loading={busy}
        onClick={onRetry}
      >
        <RefreshCw aria-hidden className="size-4" /> Retry
      </Button>
    </div>
  );
}

export function Pending({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle as="h2" className="text-base">
            {title}
          </CardTitle>
          {description ? (
            <CardDescription className="mt-1">{description}</CardDescription>
          ) : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function percent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

export function dateOnly(iso: string): string {
  // Timezone-independent slice so server and client HTML agree.
  return /^\d{4}-\d{2}-\d{2}/u.test(iso) ? iso.slice(0, 10) : iso;
}
