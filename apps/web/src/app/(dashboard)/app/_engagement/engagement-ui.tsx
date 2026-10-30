// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { cn } from "@/lib/utils";

export function EngagementPageHeader({
  eyebrow,
  title,
  description,
  icon,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <DashboardPageHeader
      eyebrow={eyebrow}
      title={title}
      description={description}
      icon={icon}
      actions={actions}
      tone="pink"
    />
  );
}

export function EngagementSurface({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "rounded-[14px_18px_14px_18px] border border-mw-ink/20 bg-card p-4 shadow-[2px_3px_0_rgb(32_32_30_/_0.08)] sm:p-6",
        className,
      )}
    >
      <div>
        <h2
          id={id}
          className="font-display text-xl font-normal uppercase leading-none tracking-tight"
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function EngagementLoading({
  label,
  rows = 3,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-11 w-full", index === rows - 1 && "w-3/4")}
        />
      ))}
    </div>
  );
}

export function EngagementQueryError({
  title,
  description,
  onRetry,
  retrying = false,
}: {
  title: string;
  description: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-start"
    >
      <AlertCircle
        className="mt-0.5 size-5 shrink-0 text-destructive"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={retrying}
        onClick={onRetry}
        className="min-h-11 shrink-0 self-start"
      >
        <RefreshCw aria-hidden />
        Retry
      </Button>
    </div>
  );
}

export function EngagementIdentityGate({
  pending,
  error,
  retrying,
  onRetry,
  children,
}: {
  pending: boolean;
  error: boolean;
  retrying: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (pending) {
    return <EngagementLoading label="Checking workspace access" rows={4} />;
  }
  if (error) {
    return (
      <EngagementQueryError
        title="Workspace access could not be verified"
        description="No engagement or channel data was requested. Retry after your session or the API connection is restored."
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  }
  return <>{children}</>;
}

export function EngagementEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-[14px_18px_14px_18px] border border-dashed border-mw-ink/30 bg-mw-yellow/10 px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-lg text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

export function EngagementMetric({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "positive" | "warning" | "danger";
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[10px_14px_10px_14px] border border-mw-ink/20 bg-background/60 p-3 shadow-[2px_2px_0_rgb(32_32_30_/_0.06)]",
        tone === "positive" && "border-success/30 bg-success/5",
        tone === "warning" && "border-warning/30 bg-warning/5",
        tone === "danger" && "border-destructive/30 bg-destructive/5",
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 break-words text-xl font-semibold tabular-nums">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
