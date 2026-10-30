// SPDX-License-Identifier: AGPL-3.0-only

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PageShell } from "@/components/dashboard/page-shell";
import { ServiceNotDeployedNotice } from "@/components/service-not-deployed-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isServiceNotDeployed } from "@/lib/service-availability";
import { cn } from "@/lib/utils";

/**
 * Consistent frame for operator/admin routes. These surfaces are unusually
 * action-dense, so their mobile contract includes 44px controls and visible
 * keyboard focus without forcing desktop controls to stay oversized.
 */
export function OperationsShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <PageShell
      className={cn(
        "pw-interaction-surface",
        className,
      )}
    >
      {children}
    </PageShell>
  );
}

export function OperationsHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <span
            aria-hidden
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15"
          >
            <Icon className="size-4" />
          </span>
          {eyebrow}
        </p>
        <h1 className="break-words font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}

export function OperationsSection({
  id,
  title,
  description,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card
      role="region"
      aria-labelledby={id}
      className={cn("min-w-0 scroll-mt-24 overflow-hidden", className)}
    >
      <CardHeader className="gap-2 border-b bg-muted/20 p-4 sm:p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle as="h2" id={id} className="text-base">
              {title}
            </CardTitle>
            {description ? (
              <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {aside ? <div className="shrink-0">{aside}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-4 sm:p-5">{children}</CardContent>
    </Card>
  );
}

export function OperationsLoading({
  label = "Loading section",
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function OperationsFailure({
  title = "This section could not be loaded",
  description,
  error,
  onRetry,
  retrying = false,
}: {
  title?: string;
  description: ReactNode;
  /**
   * The failure itself. A not-deployed answer (503 service_not_deployed) is
   * the environment, not a failure: it renders the shared neutral notice and
   * never offers a retry that cannot succeed.
   */
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (isServiceNotDeployed(error)) {
    return (
      <ServiceNotDeployedNotice title="This isn't set up in this environment">
        This environment doesn&apos;t include this feature, so trying again
        won&apos;t change it.
      </ServiceNotDeployedNotice>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="leading-5">{description}</AlertDescription>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 border-destructive/40 text-foreground"
          onClick={onRetry}
          loading={retrying}
        >
          Try again
        </Button>
      ) : null}
    </Alert>
  );
}
