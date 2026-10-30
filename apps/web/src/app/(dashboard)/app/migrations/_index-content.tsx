// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  GitCompareArrows,
  History,
  Import,
} from "lucide-react";
import { MIGRATION_DOCS_INDEX } from "@/lib/migration-docs";
import { type AdapterCapabilities, type MigrationJob } from "@/lib/types";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/dashboard/page-shell";
import { ServiceNotDeployedNotice } from "@/components/service-not-deployed-notice";
import { SourceCatalog } from "./_source-catalog";
import { MigrationHistory } from "./_migration-history";
import { Skeleton } from "@/components/ui/skeleton";

export function MigrationsIndexContent({
  capabilities,
  jobs,
  capabilitiesPending = false,
  jobsPending = false,
  capabilitiesUnavailable = false,
  jobsUnavailable = false,
  serviceNotDeployed = false,
  principalKey = "test-principal",
  tenantId = "test-tenant",
  onRetryCapabilities = () => undefined,
  onRetryJobs = () => undefined,
}: {
  capabilities: AdapterCapabilities[];
  jobs: MigrationJob[];
  capabilitiesPending?: boolean;
  jobsPending?: boolean;
  capabilitiesUnavailable?: boolean;
  jobsUnavailable?: boolean;
  /**
   * The migration reads answered 503 service_not_deployed: this environment
   * does not run migrations. Not a failure to retry, and nothing to start.
   */
  serviceNotDeployed?: boolean;
  principalKey?: string;
  tenantId?: string;
  /** May return the refetch promise so callers can show a busy state. */
  onRetryCapabilities?: () => unknown;
  onRetryJobs?: () => unknown;
}) {
  const notDeployedId = useId();
  return (
    <PageShell className="max-w-6xl space-y-8 [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11 sm:[&_[data-slot=button]]:min-h-9 sm:[&_[data-slot=button]]:min-w-0">
      <header className="relative isolate overflow-hidden rounded-2xl border bg-card px-4 py-5 shadow-pw-sm sm:px-6 sm:py-6">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/[0.1] via-transparent to-info-subtle/35"
        />
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-background/80 text-primary shadow-pw-sm sm:size-12">
              <Import className="size-5 sm:size-6" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                Workspace transfer
              </p>
              <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                Migrations
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Bring your audience, segments, automations, and campaign archive
                into Moosewave through a dry-run-first, reversible workflow.
              </p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
            <Button asChild variant="outline">
              <Link href={MIGRATION_DOCS_INDEX}>
                <BookOpen className="h-4 w-4" /> How it works
              </Link>
            </Button>
            {/* Primary "start" action — the index used to have neither CTA nor
              breadcrumb, so the only way to start was to scroll (MIGR-035).
              Kept in place but switched off where migrations don't run, with
              the notice below as its stated reason. */}
            {serviceNotDeployed ? (
              <Button type="button" disabled aria-describedby={notDeployedId}>
                Start a migration <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button asChild>
                <a href="#source-grid">
                  Start a migration <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
            )}
          </div>
        </div>
      </header>

      {serviceNotDeployed ? (
        <ServiceNotDeployedNotice
          id={notDeployedId}
          title="Migrations aren't set up in this environment"
        >
          Sources can&apos;t be connected and past migrations can&apos;t be
          listed here, so a migration can&apos;t be started. Nothing in your
          workspace has changed.
        </ServiceNotDeployedNotice>
      ) : null}

      <HowItWorks />

      <section className="space-y-4" aria-labelledby="migration-sources-title">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="migration-sources-title" className="text-lg font-semibold">
              Choose your source
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              We only show capabilities the connected adapter can actually
              preserve.
            </p>
          </div>
          {/* This destination is the Mailchimp parity workbench. Source
              capabilities for all platforms are listed below. */}
          <Link
            href="/app/compatibility"
            className="inline-flex min-h-11 items-center gap-1 self-start rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9 sm:self-auto"
          >
            <GitCompareArrows className="h-3.5 w-3.5" aria-hidden="true" />
            Mailchimp compatibility
          </Link>
        </div>
        {serviceNotDeployed ? (
          <NotInThisEnvironment>
            Migration sources can&apos;t be shown in this environment.
          </NotInThisEnvironment>
        ) : capabilitiesPending ? (
          <Skeleton className="h-52 w-full rounded-xl" />
        ) : capabilities.length === 0 ? (
          <DataUnavailable
            title={
              capabilitiesUnavailable
                ? "Source catalogue unavailable"
                : "No migration sources are available yet"
            }
            description={
              capabilitiesUnavailable
                ? "The source-capabilities request failed. This is not an empty catalogue; retry before choosing a migration path."
                : "This workspace has no migration adapters enabled."
            }
            onRetry={capabilitiesUnavailable ? onRetryCapabilities : undefined}
          />
        ) : (
          <SourceCatalog
            key={principalKey}
            capabilities={capabilities}
            authorityKey={principalKey}
            canAdmin
          />
        )}
      </section>

      <section className="space-y-4" aria-labelledby="recent-migrations-title">
        <div>
          <h2 id="recent-migrations-title" className="text-lg font-semibold">
            Recent migrations
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Resume unfinished work, inspect verification, or review rollback
            status.
          </p>
        </div>
        {serviceNotDeployed ? (
          <NotInThisEnvironment>
            Past migrations can&apos;t be shown in this environment.
          </NotInThisEnvironment>
        ) : jobsPending ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : jobsUnavailable ? (
          <DataUnavailable
            title="Migration history unavailable"
            description="The history request failed. This is not an empty migration history; retry before starting duplicate work."
            onRetry={onRetryJobs}
          />
        ) : jobs.length === 0 ? (
          <EmptyState
            icon={History}
            title="No migrations yet"
            description="Connect your current platform above. We'll inspect it, dry-run the import, and only commit when you say so."
            action={
              <Button asChild>
                <a href="#source-grid">
                  Start your first migration <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
            }
          />
        ) : (
          <MigrationHistory
            key={principalKey}
            jobs={jobs}
            principalKey={principalKey}
            tenantId={tenantId}
            onRefresh={() =>
              Promise.all([onRetryJobs(), onRetryCapabilities()])
            }
          />
        )}
      </section>
    </PageShell>
  );
}

/** A section's placeholder under the page's not-deployed notice. No retry. */
function NotInThisEnvironment({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function DataUnavailable({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-4 rounded-xl border border-warning/25 bg-warning-subtle/40 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {onRetry ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function MigrationsLoading() {
  return (
    <PageShell className="max-w-6xl space-y-8">
      <span className="sr-only" role="status">
        Verifying migration access
      </span>
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-52 w-full rounded-2xl" />
    </PageShell>
  );
}

export function IndexAccessState({
  title,
  description,
  retrying = false,
  onRetry,
}: {
  title: string;
  description: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <PageShell className="max-w-3xl space-y-4">
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        Migrations
      </h1>
      <div role="alert" className="rounded-xl border bg-card p-5">
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            loading={retrying}
            onClick={onRetry}
          >
            {retrying ? "Retrying…" : "Retry identity"}
          </Button>
        ) : null}
      </div>
    </PageShell>
  );
}

// A compact "how migrations work" strip: the 4-step, dry-run-first, reversible
// process reassurance that previously only appeared inside the wizard after
// picking a source (MIGR-036).
function HowItWorks() {
  const steps: Array<[string, string]> = [
    ["Connect", "Read-only access to your current platform."],
    ["Inspect", "We count subscribers, segments, and automations."],
    ["Dry-run", "See exactly what will land before anything imports."],
    [
      "Commit",
      "Nothing is imported until you approve — reversible for 7 days.",
    ],
  ];
  return (
    <section
      aria-label="How migrations work"
      className="rounded-2xl border bg-card p-4 shadow-pw-sm sm:p-5"
    >
      <h2 className="text-sm font-semibold">A controlled path to cutover</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(([title, body], i) => (
          <div key={title} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
            >
              {i + 1}
            </span>
            <div>
              <h3 className="text-sm font-medium">{title}</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
