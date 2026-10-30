// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function GovernancePageHeader({
  icon: Icon,
  eyebrow = "Trust & governance",
  title,
  description,
  refreshLabel = "Refresh",
  refreshing = false,
  onRefresh,
}: {
  icon: LucideIcon;
  eyebrow?: string;
  title: string;
  description: string;
  refreshLabel?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <DashboardPageHeader
      eyebrow={eyebrow}
      title={title}
      description={description}
      icon={<Icon className="size-5" aria-hidden="true" />}
      tone="blue"
      actions={
        onRefresh ? (
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={onRefresh}
            loading={refreshing}
          >
            {!refreshing ? <RefreshCw aria-hidden="true" /> : null}
            {refreshing ? "Refreshing…" : refreshLabel}
          </Button>
        ) : null
      }
    />
  );
}

export function GovernanceSection({
  icon: Icon,
  title,
  description,
  children,
  className,
  contentClassName,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const headingId = `governance-${title.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;

  return (
    <Card className={cn("min-w-0 overflow-hidden", className)}>
      <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-3">
        <div className="flex items-start gap-3">
          {Icon ? (
            <div className="mt-0.5 flex size-9 shrink-0 rotate-[-1deg] items-center justify-center rounded-[8px_11px_8px_11px] border border-mw-ink/20 bg-mw-pink-soft text-mw-blue">
              <Icon className="size-4" aria-hidden="true" />
            </div>
          ) : null}
          <div className="min-w-0">
            <CardTitle as="h2" id={headingId} className="text-base leading-5">
              {title}
            </CardTitle>
            {description ? (
              <CardDescription className="mt-1 leading-5">
                {description}
              </CardDescription>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent
        aria-labelledby={headingId}
        className={cn("min-w-0 p-4 pt-0 sm:p-6 sm:pt-0", contentClassName)}
      >
        {children}
      </CardContent>
    </Card>
  );
}

export function GovernanceLoading({
  label,
  rows = 2,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-busy="true" className="space-y-2.5">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className={cn(
            "h-4 max-w-full",
            index === 0 ? "w-72" : index % 2 === 0 ? "w-80" : "w-full",
          )}
        />
      ))}
    </div>
  );
}

export function GovernanceError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-destructive-emphasis"
          aria-hidden="true"
        />
        <p className="min-w-0 break-words text-sm leading-5 text-foreground">
          {message}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="shrink-0 bg-background sm:self-start"
        onClick={onRetry}
        loading={retrying}
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

export interface GovernanceMetric {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

export function GovernanceMetrics({
  items,
  columns = 3,
}: {
  items: readonly GovernanceMetric[];
  columns?: 2 | 3 | 4;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-2 sm:grid-cols-2",
        columns === 3 && "lg:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
      )}
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="min-w-0 rounded-[10px_14px_10px_14px] border border-mw-ink/20 bg-muted/25 p-3.5 shadow-[2px_2px_0_rgb(32_32_30_/_0.06)]"
        >
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {item.label}
          </dt>
          <dd className="mt-1 min-w-0 break-words text-xl font-semibold tabular-nums tracking-tight">
            {item.value}
          </dd>
          {item.detail ? (
            <dd className="mt-1 min-w-0 break-words text-xs leading-5 text-muted-foreground">
              {item.detail}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

export function GovernanceEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-sm leading-5 text-muted-foreground">
      {children}
    </p>
  );
}
