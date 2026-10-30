// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { absoluteTime, timeAgo } from "@/lib/relative-time";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning";

export function statusVariant(status?: string): BadgeVariant {
  const value = (status ?? "").toLowerCase();
  if (["ready", "pass", "active", "connected", "verified", "complete", "sent", "success"].includes(value)) {
    return "success";
  }
  if (["missing", "failed", "rejected", "unsupported", "blocked", "error"].includes(value)) {
    return "destructive";
  }
  if (["warning", "partial", "planned", "pending", "manual", "requires_setup"].includes(value)) {
    return "warning";
  }
  if (["draft", "catalog", "facade", "metadata"].includes(value)) {
    return "secondary";
  }
  return "outline";
}

export function formatDate(value?: string) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/**
 * A timestamp rendered as relative time ("in 2 days" / "3h ago") with the exact
 * absolute time one hover/focus away (ANL-023). Relative time is a client-only
 * notion, so it renders a stable absolute placeholder until mounted to avoid a
 * hydration mismatch (these panels are client-fetched, but the guard keeps the
 * primitive safe wherever it's reused).
 */
export function DateStamp({ value }: { value?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!value) return <span>Not scheduled</span>;
  const relative = mounted ? timeAgo(value) : "";
  const absolute = absoluteTime(value);
  return (
    <span title={absolute || undefined} className="tabular-nums">
      {relative || absolute || value}
    </span>
  );
}

export function metric(value: unknown, fallback = "0") {
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

/**
 * Humanize a backend enum/snake_case value for display so machine tokens like
 * `not_native` / `available_requires_pro` don't leak into the UI as labels
 * (LAND-029). Numbers pass through locale-formatted.
 */
export function humanizeStatus(value?: string | number): string {
  if (typeof value === "number") return value.toLocaleString();
  const s = (value ?? "").toString().trim();
  if (!s) return "";
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function pct(value: unknown) {
  if (typeof value !== "number") return "0%";
  return `${Math.round(value * 100)}%`;
}

export function entries(record?: Record<string, unknown>) {
  return Object.entries(record ?? {}).filter(([, value]) => value !== undefined && value !== null);
}

export function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Panel-level error with an inline Retry that re-runs the panel's load, matching
 * the page-level KPI error banner instead of dead-ending on a browser reload
 * (ANL-002).
 */
export function PanelError({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis">
      <span className="min-w-0">{message}</span>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Legacy single-line loading text, retained for the non-analytics parity panels
 * (content-studio / multi-channel-ops / platform-ops) that still import it. The
 * analytics panels use the grid-shaped skeleton below instead (ANL-019).
 */
export function LoadingLine() {
  return <div className="text-sm text-muted-foreground">Loading parity data...</div>;
}

/**
 * Grid-shaped loading skeleton matching a panel's inner card layout, replacing
 * the bare "Loading parity data..." text line so the loading treatment is
 * consistent through fetch (ANL-019).
 */
export function PanelGridSkeleton({ cells = 3 }: { cells?: number }) {
  return (
    <div className="grid gap-3 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: cells }).map((_, i) => (
        <div key={`panel-sk-${i}`} className="space-y-3 rounded-md border p-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-2 w-3/4" />
          <Skeleton className="h-2 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * Compact, consistent empty state for panel cards — icon + short copy (+ an
 * optional CTA) so panel empties match the page-level EmptyState treatment
 * instead of a bare gray line (ANL-040).
 */
export function PanelEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center">
      <p className="text-xs font-medium text-foreground">{title}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function MetricBox({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: string | number;
  detail?: string | number;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-md bg-muted/40 px-3 py-2", className)}>
      <div className="text-[11px] font-medium uppercase text-muted-foreground break-words">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold break-words">{metric(value)}</div>
      {detail !== undefined && detail !== "" ? (
        <div className="mt-0.5 text-xs text-muted-foreground break-words">{metric(detail, "")}</div>
      ) : null}
    </div>
  );
}
