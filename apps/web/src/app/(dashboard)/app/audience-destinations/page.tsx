// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Audience destinations and holdout groups.
 *
 * Five paths desktop reached and web did not.
 *
 * CAPABILITIES DIFFER PER PROVIDER AND ONE DIFFERENCE MATTERS BEFORE YOU
 * CHOOSE. Google Ads, LinkedIn, Snap and TikTok report `diagnostics: true`;
 * Meta reports `false`. Five logos rendered identically imply the same
 * troubleshooting support behind each, and the one where a failed sync cannot
 * be explained is precisely the one worth flagging in advance rather than
 * discovering during an incident.
 *
 * `configured` and `diagnostics` are also different questions — credentials
 * existing is not the same as failures being explainable — so both are shown.
 */

import { useMemo } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  CheckCircle2,
  CircleOff,
  Megaphone,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { Button } from "@/components/ui/button";
import { whoami } from "@/lib/auth-api";
import {
  getDestinationProviders,
  listControlGroups,
  withoutDiagnostics,
} from "@/lib/audience-destinations-api";
import { base, STALE } from "@/lib/query-keys";
const AudienceDestinationsManager = dynamic(
  () =>
    import("./audience-destinations-manager").then(
      (module) => module.AudienceDestinationsManager,
    ),
  {
    ssr: false,
    loading: () => <OperationalClientFallback label="destination controls" />,
  },
);

function OperationalClientFallback({ label }: { label: string }) {
  return (
    <section
      role="status"
      aria-busy="true"
      className="min-h-32 rounded-xl border border-dashed p-5 text-sm text-muted-foreground"
    >
      Loading {label}…
    </section>
  );
}

export default function AudienceDestinationsPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "audience-destinations",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const providers = useQuery({
    queryKey: [...keyBase, "providers"],
    queryFn: getDestinationProviders,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const controls = useQuery({
    queryKey: [...keyBase, "control-groups"],
    queryFn: listControlGroups,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });

  const caps = providers.data?.capabilities ?? {};
  const capRows = Object.entries(caps);
  const providerNames = Array.isArray(providers.data?.providers)
    ? providers.data.providers
    : [];
  const noDiagnostics = withoutDiagnostics(caps);
  const controlRows = Array.isArray(controls.data) ? controls.data : [];

  if (meQuery.isLoading || meQuery.isError || !meQuery.data) {
    return (
      <DataSurfaceShell className="max-w-5xl">
        <DataSurfaceHeader
          icon={Megaphone}
          eyebrow="Audience activation"
          title="Audience destinations"
          description="Review the ad platforms your segments can be pushed to, whether each is configured, and whether failed syncs can be diagnosed before you choose a destination."
        />
        {meQuery.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : (
          <QueryError
            title="Workspace identity could not be loaded"
            description="Destination requests were not started without a verified workspace context."
            onRetry={() => void meQuery.refetch()}
          />
        )}
      </DataSurfaceShell>
    );
  }

  return (
    <DataSurfaceShell className="max-w-5xl">
      <DataSurfaceHeader
        icon={Megaphone}
        eyebrow="Audience activation"
        title="Audience destinations"
        description="Review the ad platforms your segments can be pushed to, whether each is configured, and whether failed syncs can be diagnosed before you choose a destination."
        actions={
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/app/audience-syncs">View syncs</Link>
          </Button>
        }
      />

      <DataSection
        id="ad-providers"
        title="Provider capabilities"
        description="Configured means this deployment registered an adapter. Credential resolution, account approval, and provider diagnostics are separate readiness checks."
        aside={
          providers.isSuccess ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.max(capRows.length, providerNames.length)} providers
            </span>
          ) : undefined
        }
      >
        {providers.isLoading ? (
          <SectionSkeleton rows={3} />
        ) : providers.isError ? (
          <QueryError
            title="Destination providers could not be loaded"
            description="Provider capabilities are unavailable and have not been represented as unsupported."
            onRetry={() => void providers.refetch()}
          />
        ) : capRows.length === 0 && providerNames.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            No destination providers offered by this build.
          </p>
        ) : capRows.length === 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {providerNames.map((name, index) => (
              <li
                key={`${name}-${index}`}
                className="rounded-xl border bg-background p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="break-words font-medium capitalize">
                    {name.replace(/_/gu, " ")}
                  </p>
                  <StatusPill status="unknown" />
                </div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Configuration and diagnostic capabilities were not reported
                  for this provider.
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <>
            {noDiagnostics.length > 0 ? (
              // The difference worth knowing BEFORE picking one.
              <div className="mb-4 flex gap-3 rounded-xl border border-warning/35 bg-warning-subtle/60 p-4 text-sm">
                <TriangleAlert
                  aria-hidden
                  className="mt-0.5 size-5 shrink-0 text-warning-emphasis"
                />
                <p className="min-w-0 break-words leading-6 text-muted-foreground">
                  <strong className="font-medium capitalize text-foreground">
                    {noDiagnostics.join(", ").replace(/_/gu, " ")}
                  </strong>{" "}
                  {noDiagnostics.length === 1 ? "does" : "do"} not support sync
                  diagnostics. A failed push there cannot be explained after the
                  fact.
                </p>
              </div>
            ) : null}
            <ul className="grid gap-3 sm:grid-cols-2">
              {capRows.map(([name, c]) =>
                c ? (
                  <li
                    key={name}
                    className="rounded-xl border bg-background p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="break-words font-medium capitalize">
                        {name.replace(/_/gu, " ")}
                      </p>
                      <StatusPill
                        status={
                          c.configured
                            ? "adapter registered"
                            : "adapter unavailable"
                        }
                      />
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      {c.diagnostics ? (
                        <ShieldCheck
                          aria-hidden
                          className="size-4 shrink-0 text-success"
                        />
                      ) : (
                        <CircleOff
                          aria-hidden
                          className="size-4 shrink-0 text-warning-emphasis"
                        />
                      )}
                      {c.diagnostics
                        ? "Failure diagnostics available"
                        : "Failure diagnostics unavailable"}
                    </div>
                  </li>
                ) : null,
              )}
            </ul>
          </>
        )}
      </DataSection>

      <AudienceDestinationsManager
        me={meQuery.data}
        providers={providers.data}
      />

      <DataSection
        id="ad-controls"
        title="Control groups"
        description="Holdout groups preserve a comparison cohort so you can measure incremental campaign lift."
        aside={
          controls.isSuccess ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {controlRows.length} groups
            </span>
          ) : undefined
        }
      >
        <DestinationRows
          rows={controlRows}
          loading={controls.isLoading}
          errored={controls.isError}
          emptyTitle="No holdout groups"
          emptyDescription="Campaign lift is not currently being measured against a control group."
          retry={() => void controls.refetch()}
        />
      </DataSection>
    </DataSurfaceShell>
  );
}

function DestinationRows({
  rows,
  loading,
  errored,
  emptyTitle,
  emptyDescription,
  retry,
}: {
  rows: unknown[];
  loading: boolean;
  errored: boolean;
  emptyTitle: string;
  emptyDescription: string;
  retry: () => void;
}) {
  if (loading) return <SectionSkeleton rows={2} />;
  if (errored) {
    return (
      <QueryError
        description="This list could not be read and has not been shown as empty."
        onRetry={retry}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-5 text-center">
        <CheckCircle2
          aria-hidden
          className="mx-auto size-6 text-muted-foreground"
        />
        <p className="mt-2 text-sm font-medium">{emptyTitle}</p>
        <p className="mx-auto mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
          {emptyDescription}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y overflow-hidden rounded-xl border">
      {rows.map((row, index) => {
        const record =
          row && typeof row === "object" && !Array.isArray(row)
            ? (row as Record<string, unknown>)
            : {};
        const label =
          record.name ?? record.label ?? record.provider ?? record.id;
        const status = record.status ?? record.state;
        return (
          <li
            key={`${String(record.id ?? label ?? "item")}-${index}`}
            className="grid min-w-0 gap-2 p-3.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <span className="break-words font-medium">
              {String(label ?? `Item ${index + 1}`)}
            </span>
            {status != null ? <StatusPill status={String(status)} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
