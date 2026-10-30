// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Download } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { REGION_LABELS, getTenantRegion } from "@/lib/region-api";
import { DPA_DOWNLOAD_PATH, getDpaMetadata } from "@/lib/privacy-api";
import { whoami } from "@/lib/auth-api";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import { qk, STALE } from "@/lib/query-keys";

export default function DataRegionSettingsPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const canAdmin = meQuery.isSuccess && canReadAdminData(identity);
  const [tenantId, userId, role, viewerState] =
    adminReadIdentityParts(identity);
  const regionKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "data-region"),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );
  const dpaKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "data-region-dpa"),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );
  const regionQuery = useQuery({
    queryKey: regionKey,
    queryFn: getTenantRegion,
    enabled: meQuery.isSuccess,
    staleTime: STALE.detail,
  });
  const dpaQuery = useQuery({
    queryKey: dpaKey,
    queryFn: getDpaMetadata,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.detail,
    retry: false,
  });
  const region = regionQuery.data ?? null;
  const loading =
    meQuery.isLoading || (regionQuery.isPending && !regionQuery.data);
  const servingLabel = region
    ? (REGION_LABELS[region.deployment_region] ?? region.deployment_region)
    : "";
  const previousDpaKeyRef = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    const previous = previousDpaKeyRef.current;
    if (previous && previous !== dpaKey) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
    }
    previousDpaKeyRef.current = dpaKey;
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    void queryClient.cancelQueries({ queryKey: dpaKey });
    queryClient.removeQueries({ queryKey: dpaKey });
  }, [canAdmin, dpaKey, meQuery.isPending, meQuery.isSuccess, queryClient]);

  useEffect(() => {
    if (!regionQuery.error) return;
    toast.error(
      regionQuery.error instanceof Error
        ? regionQuery.error.message
        : "Could not load data region settings.",
    );
  }, [regionQuery.error]);

  if (meQuery.isError) {
    return (
      <div className="max-w-3xl space-y-6">
        <header>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Data region
          </h2>
        </header>
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive" role="alert">
              Workspace identity could not be verified. No region or DPA request
              was made.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void meQuery.refetch()}
            >
              Retry identity check
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Data region
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Where your workspace data is stored, and the compliance artifacts that
          document it.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Residency</CardTitle>
          <CardDescription>
            The geographic region your workspace data is stored in. It is set
            when your workspace is provisioned and underpins compliance
            attestations (GDPR Article 44, SOC 2 Common Criteria 6).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="warning">
            <AlertTitle>Region change requires migration</AlertTitle>
            <AlertDescription>
              Changing region requires a tenant migration job. Contact{" "}
              <a
                href="mailto:support@moosewave.com"
                className="font-medium underline underline-offset-2"
              >
                support@moosewave.com
              </a>
              .
            </AlertDescription>
          </Alert>

          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : region ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border bg-card p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Workspace data region
                  </div>
                  <div className="mt-1 text-lg font-semibold">
                    {REGION_LABELS[region.data_region] ?? region.data_region}
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {region.data_region}
                  </div>
                </div>
                <div className="rounded-lg border bg-card p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Serving from
                  </div>
                  <div className="mt-1 text-lg font-semibold">
                    {servingLabel}
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {region.deployment_region}
                  </div>
                  <div className="mt-2 text-xs">
                    {region.matches ? (
                      <span className="inline-flex items-center rounded-full bg-success-subtle px-2 py-0.5 font-medium text-success-emphasis">
                        Stored and served in-region
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-warning-subtle px-2 py-0.5 font-medium text-warning-emphasis">
                        Served from a different region than stored
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Downstream services (email delivery and object storage) run in
                the serving region shown above.
                {regionQuery.dataUpdatedAt ? (
                  <>
                    {" "}
                    Last checked{" "}
                    <RelativeTime
                      iso={new Date(regionQuery.dataUpdatedAt).toISOString()}
                    />
                    .
                  </>
                ) : null}
              </p>
            </>
          ) : regionQuery.isError ? (
            // "Unavailable" below would read as a workspace with no region on
            // record; this says the request failed, so the operator retries.
            <p className="text-sm text-destructive">
              Could not load your data region. Reload to try again.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Region information is unavailable.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Compliance documents</CardTitle>
          <CardDescription>
            Artifacts a reviewer can hand to their compliance team. The Data
            Processing Agreement includes the authoritative subprocessor list.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {meQuery.isPending ? (
            <Skeleton className="h-9 w-48" />
          ) : !canAdmin ? (
            <p className="text-sm text-muted-foreground" role="status">
              {ADMIN_READ_ONLY_MESSAGE} DPA metadata and download access were
              not requested.
            </p>
          ) : dpaQuery.isPending ? (
            <Skeleton className="h-9 w-48" />
          ) : dpaQuery.data ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  Data Processing Agreement (v{dpaQuery.data.version})
                </div>
                <div className="text-xs text-muted-foreground">
                  {dpaQuery.data.processor_name} as processor ·{" "}
                  {dpaQuery.data.controller_name} as controller
                </div>
              </div>
              <Button asChild type="button" variant="outline" size="sm">
                <a href={DPA_DOWNLOAD_PATH} download>
                  <Download className="h-4 w-4" />
                  Download DPA
                </a>
              </Button>
            </div>
          ) : dpaQuery.isError ? (
            // The metadata endpoint answers 200 or fails — it has no "this
            // deployment ships no DPA" reply. Rendering the copy below on a
            // failed request told compliance reviewers the artifact does not
            // exist when the server simply did not answer.
            <p className="text-sm text-destructive">
              Could not load the Data Processing Agreement. Reload to try again.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              The DPA isn&apos;t available on this deployment. Contact{" "}
              <a
                href="mailto:support@moosewave.com"
                className="font-medium underline underline-offset-2"
              >
                support@moosewave.com
              </a>{" "}
              for compliance documentation and the current subprocessor list.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
