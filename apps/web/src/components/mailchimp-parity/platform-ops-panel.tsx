// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  createAccountExport,
  createBatch,
  type AccountExport,
} from "@/lib/mailchimp-compat-api";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";

import {
  loadPlatformOpsData,
  type PlatformOpsData,
} from "./product-panel-data";
import {
  errorMessage,
  LoadingLine,
  MetricBox,
  PanelError,
} from "./product-panel-primitives";

export function PlatformOpsPanel({ className = "" }: { className?: string }) {
  const queryClient = useQueryClient();
  const [busyAction, setBusyAction] = useState<"batch" | "export" | null>(null);
  const busyRef = useRef(false);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identityReady = Boolean(meQuery.data);
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const canWrite = canWriteCampaigns(meQuery.data);
  const integrationsBaseKey = useMemo(
    () => base("integrations", tenantId, role),
    [role, tenantId],
  );
  const platformOpsKey = useMemo(
    () => [...integrationsBaseKey, "mailchimp-platform-ops"] as const,
    [integrationsBaseKey],
  );
  const platformOpsQuery = useQuery({
    queryKey: platformOpsKey,
    queryFn: ({ signal }) => loadPlatformOpsData(signal),
    enabled: identityReady,
    staleTime: STALE.list,
  });
  const batches = platformOpsQuery.data?.batches ?? null;
  const exportsState = platformOpsQuery.data?.exportsState ?? null;
  const sites = platformOpsQuery.data?.sites ?? null;
  const domains = platformOpsQuery.data?.domains ?? null;
  const marketplace = platformOpsQuery.data?.marketplace ?? null;
  const agency = platformOpsQuery.data?.agency ?? null;
  const loading =
    meQuery.isLoading || (platformOpsQuery.isPending && !platformOpsQuery.data);
  const error =
    platformOpsQuery.error || meQuery.error
      ? errorMessage(
          platformOpsQuery.error ?? meQuery.error,
          "Could not load platform operations.",
        )
      : null;
  const retrying = meQuery.isFetching || platformOpsQuery.isFetching;

  function retryLoad() {
    void meQuery.refetch().then((auth) => {
      if (auth.data) {
        void platformOpsQuery.refetch();
      }
    });
  }

  function invalidatePlatformOps() {
    void queryClient.invalidateQueries({
      queryKey: platformOpsKey,
      exact: false,
    });
  }

  async function handleCreateBatch() {
    if (!canWrite || busyRef.current) return;
    busyRef.current = true;
    setBusyAction("batch");
    try {
      await confirmFreshCampaignWriteAuthority(meQuery.data);
      const batch = await createBatch({
        operations: [
          {
            method: "GET",
            path: "/api/mailchimp/3.0/lists",
            operation_id: "ui-batch-validation",
          },
        ],
      });
      queryClient.setQueryData<PlatformOpsData>(platformOpsKey, (cur) => ({
        batches: {
          batches: [batch, ...(cur?.batches?.batches ?? [])],
          total_items: (cur?.batches?.total_items ?? 0) + 1,
        },
        exportsState: cur?.exportsState ?? null,
        sites: cur?.sites ?? null,
        domains: cur?.domains ?? null,
        marketplace: cur?.marketplace ?? null,
        agency: cur?.agency ?? null,
      }));
      if (batch.errored_operations > 0) {
        toast.error("Batch validation failed.", {
          description: `${batch.errored_operations}/${batch.total_operations} operations were rejected.`,
        });
      } else {
        toast.success("Batch request validated.", {
          description:
            "This checks compatibility syntax and persistence; it does not execute live side effects.",
        });
      }
      invalidatePlatformOps();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not queue batch.",
      );
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  async function handleCreateExport() {
    if (!canWrite || busyRef.current) return;
    busyRef.current = true;
    setBusyAction("export");
    try {
      await confirmFreshCampaignWriteAuthority(meQuery.data);
      const accountExport: AccountExport = await createAccountExport({
        sections: ["contacts", "campaigns", "templates", "reports"],
      });
      queryClient.setQueryData<PlatformOpsData>(platformOpsKey, (cur) => ({
        batches: cur?.batches ?? null,
        exportsState: {
          exports: [accountExport, ...(cur?.exportsState?.exports ?? [])],
          total_items: (cur?.exportsState?.total_items ?? 0) + 1,
        },
        sites: cur?.sites ?? null,
        domains: cur?.domains ?? null,
        marketplace: cur?.marketplace ?? null,
        agency: cur?.agency ?? null,
      }));
      toast.success("Account export started.");
      invalidatePlatformOps();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start export.",
      );
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Developer and platform operations</CardTitle>
        <CardDescription>
          Batch ops, account exports, connected sites, verified domains,
          marketplace, and agency ecosystem surfaces.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <LoadingLine /> : null}
        {error ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="flex-1">
              <PanelError message={error} />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={retryLoad}
              disabled={retrying}
            >
              {retrying ? "Retrying..." : "Retry"}
            </Button>
          </div>
        ) : null}
        {/* One rejected leg of loadPlatformOpsData's Promise.all leaves all six
            of these null, and the `?? 0` fallbacks would then read as measured
            counts — "0 verified" domains to an admin checking whether a
            migration kept them. The same zeros would appear beside "Loading
            parity data..." before anything had been fetched. Show the metrics
            only once a real read has landed. */}
        {loading || error ? null : (
          <div className="grid gap-3 lg:grid-cols-3">
            <MetricBox
              label="Batches"
              value={batches?.total_items ?? 0}
              detail={batches?.batches?.[0]?.status}
            />
            <MetricBox
              label="Account exports"
              value={exportsState?.total_items ?? 0}
              detail={exportsState?.exports?.[0]?.status}
            />
            <MetricBox
              label="Connected sites"
              value={sites?.total_items ?? 0}
              detail={sites?.sites?.[0]?.sync_status}
            />
            <MetricBox
              label="Verified domains"
              value={domains?.total_items ?? 0}
              detail={`${domains?.domains?.filter((d) => d.verified).length ?? 0} verified`}
            />
            <MetricBox
              label="Marketplace"
              value={marketplace?.total_items ?? 0}
              detail={marketplace?.status}
            />
            <MetricBox
              label="Agency program"
              value={agency?.status ?? "not configured"}
              detail={`${agency?.resources?.length ?? 0} resources`}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreateBatch}
            disabled={!canWrite || busyAction !== null}
            title={!canWrite ? CAMPAIGN_READ_ONLY_MESSAGE : undefined}
          >
            {busyAction === "batch"
              ? "Validating..."
              : "Validate batch request"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreateExport}
            disabled={!canWrite || busyAction !== null}
            title={!canWrite ? CAMPAIGN_READ_ONLY_MESSAGE : undefined}
          >
            {busyAction === "export" ? "Starting..." : "Start account export"}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/app/settings/domain">Verified domains</Link>
          </Button>
        </div>
        {identityReady && !canWrite ? (
          <p className="text-sm text-muted-foreground" role="status">
            {CAMPAIGN_READ_ONLY_MESSAGE}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
