// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { IspCampaignSelect } from "@/app/(dashboard)/app/lifecycle/isp-campaign-select";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementMetric,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "@/app/(dashboard)/app/_engagement/engagement-ui";
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  getGrowthSummary,
  getIspBreakdown,
  getIspBreakdownByCampaign,
  getLifecycleDistribution,
  listLifecycleStages,
} from "@/lib/lifecycle-api";
import { base, STALE } from "@/lib/query-keys";

// Goals & pacing sits below the stage and acquisition cards and brings its
// own admin API, editor and confirmations, so it loads after first paint and
// keeps the route's initial JavaScript inside the bundle budget. The fallback
// is the skeleton the manager itself shows while its progress loads.
const GoalsManager = dynamic(
  () =>
    import("@/app/(dashboard)/app/lifecycle/goals-manager").then(
      (module) => module.GoalsManager,
    ),
  {
    loading: () => (
      <EngagementLoading label="Loading goal progress" rows={3} />
    ),
  },
);

const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

export default function LifecyclePage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "lifecycle",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );
  const identityReady = Boolean(meQuery.data);

  const stages = useQuery({
    queryKey: [...keyBase, "stages"],
    queryFn: listLifecycleStages,
    staleTime: STALE.reference,
    enabled: identityReady,
  });
  const distribution = useQuery({
    queryKey: [...keyBase, "distribution"],
    queryFn: getLifecycleDistribution,
    staleTime: STALE.dashboard,
    enabled: identityReady,
  });
  const growth = useQuery({
    queryKey: [...keyBase, "growth"],
    queryFn: getGrowthSummary,
    staleTime: STALE.dashboard,
    enabled: identityReady,
  });
  /** "" = the tenant-wide window; otherwise one campaign's delivery events. */
  const [ispCampaignId, setIspCampaignId] = useState("");
  const isp = useQuery({
    queryKey: ispCampaignId
      ? [...keyBase, "isp", "campaign", ispCampaignId]
      : [...keyBase, "isp"],
    queryFn: () =>
      ispCampaignId
        ? getIspBreakdownByCampaign(ispCampaignId)
        : getIspBreakdown(),
    staleTime: STALE.reference,
    enabled: identityReady,
  });

  const stageList = Array.isArray(stages.data) ? stages.data : [];
  const dist = Array.isArray(distribution.data) ? distribution.data : [];
  const byStage = new Map(dist.map((row) => [row.stage, row.count]));
  const maxStageCount = Math.max(
    1,
    ...stageList.map((stage) => byStage.get(stage) ?? 0),
  );
  const growthSummary = growth.data;
  const ispRows = Array.isArray(isp.data) ? isp.data : [];

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Audience journey"
        title="Lifecycle"
        description="See where subscribers sit in the funnel, which sources are growing it, and whether goals and mailbox-provider quality support the same story."
        icon={<GitBranch aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="lc-stages"
            title="Lifecycle stages"
            description="The declared stage vocabulary stays visible even when a stage currently has no subscribers."
          >
            {stages.isPending || distribution.isPending ? (
              <EngagementLoading label="Loading lifecycle stages" rows={5} />
            ) : stages.isError || distribution.isError ? (
              <EngagementQueryError
                title="Lifecycle breakdown could not be loaded"
                description="Both the configured vocabulary and its subscriber distribution are required; a partial result is not shown as complete."
                retrying={stages.isFetching || distribution.isFetching}
                onRetry={() => {
                  void stages.refetch();
                  void distribution.refetch();
                }}
              />
            ) : stageList.length === 0 ? (
              <EngagementEmpty
                title="No lifecycle vocabulary"
                description="This build did not return any declared stages, so subscriber counts cannot be labelled safely."
              />
            ) : (
              <ol
                className="space-y-3"
                aria-label="Lifecycle stage distribution"
              >
                {stageList.map((stage, index) => {
                  const count = byStage.get(stage) ?? 0;
                  return (
                    <li
                      key={stage}
                      className="rounded-lg border bg-background/60 p-3"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 break-words font-medium capitalize">
                          <span className="mr-2 text-xs text-muted-foreground tabular-nums">
                            {index + 1}
                          </span>
                          {stage.replace(/_/gu, " ")}
                        </span>
                        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                          {count.toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{
                            width: `${Math.max(count > 0 ? 3 : 0, (count / maxStageCount) * 100)}%`,
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </EngagementSurface>

          <EngagementSurface
            id="lc-growth"
            title="Acquisition sources"
            description="New subscribers grouped by recorded consent source and platform for the server-reported window."
          >
            {growth.isPending ? (
              <EngagementLoading label="Loading acquisition sources" rows={4} />
            ) : growth.isError ? (
              <EngagementQueryError
                title="Acquisition sources could not be loaded"
                description="A failed source summary is not presented as zero growth."
                retrying={growth.isFetching}
                onRetry={() => void growth.refetch()}
              />
            ) : growthSummary ? (
              <>
                <EngagementMetric
                  label={`New in ${growthSummary.window_days || "the selected"} days`}
                  value={growthSummary.total_new_subs.toLocaleString()}
                  tone={
                    growthSummary.total_new_subs > 0 ? "positive" : "default"
                  }
                />
                {growthSummary.sources.length === 0 ? (
                  <div className="mt-3">
                    <EngagementEmpty
                      title="No new subscribers in this window"
                      description="The source query completed successfully and returned no acquisition rows."
                    />
                  </div>
                ) : (
                  <ul className="mt-3 divide-y rounded-lg border">
                    {growthSummary.sources.map((source, index) => (
                      <li
                        key={`${source.consent_source}-${source.source_platform ?? index}`}
                        className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
                        <span className="min-w-0 break-words text-sm capitalize">
                          {source.consent_source.replace(/_/gu, " ")}
                          {source.source_platform ? (
                            <span className="ml-2 text-xs normal-case text-muted-foreground">
                              via {source.source_platform}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                          {source.count.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </EngagementSurface>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="lc-goals"
            title="Goals & pacing"
            description="Live server-computed current values, targets, period windows, and ahead/on-track/behind pacing, with concurrency-safe administration."
            className="lg:col-span-2"
          >
            {meQuery.data ? <GoalsManager identity={meQuery.data} /> : null}
          </EngagementSurface>

          <EngagementSurface
            id="lc-isp"
            title="Mailbox providers"
            description={
              ispCampaignId
                ? "Delivery-event outcomes by provider for the selected campaign; rates share each provider's observed recipients of that campaign."
                : "Delivery-event outcomes by provider; rates share each provider's observed sent volume."
            }
          >
            {meQuery.data ? (
              <IspCampaignSelect
                tenantId={meQuery.data.tenant_id}
                role={meQuery.data.role ?? null}
                value={ispCampaignId}
                onChange={setIspCampaignId}
                disabled={isp.isFetching}
              />
            ) : null}
            {isp.isPending ? (
              <EngagementLoading label="Loading mailbox-provider breakdown" />
            ) : isp.isError ? (
              <EngagementQueryError
                title="Mailbox providers could not be loaded"
                description={`${apiErrorMessage(isp.error, "Provider performance is unavailable.")} No provider is being reported as healthy by omission.`}
                retrying={isp.isFetching}
                onRetry={() => void isp.refetch()}
              />
            ) : ispRows.length === 0 ? (
              ispCampaignId ? (
                <EngagementEmpty
                  title="No provider events for this campaign"
                  description="Provider rows are derived from the campaign's delivery events; this campaign has not produced any yet."
                />
              ) : (
                <EngagementEmpty
                  title="No provider breakdown yet"
                  description="Provider rows are derived from delivery events and appear after sends have produced evidence."
                />
              )
            ) : (
              <ul className="space-y-3">
                {ispRows.map((bucket) => (
                  <li
                    key={bucket.isp}
                    className="rounded-lg border bg-background/60 p-3"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium capitalize">
                        {bucket.isp.replace(/_/gu, " ")}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {bucket.sent.toLocaleString()} sent
                      </span>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div>
                        <dt className="text-xs text-muted-foreground">Open</dt>
                        <dd className="text-sm font-medium tabular-nums">
                          {percent.format(bucket.open_rate)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Click</dt>
                        <dd className="text-sm font-medium tabular-nums">
                          {percent.format(bucket.click_rate)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          Bounce
                        </dt>
                        <dd className="text-sm font-medium tabular-nums">
                          {percent.format(bucket.bounce_rate)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          Complaint
                        </dt>
                        <dd className="text-sm font-medium tabular-nums">
                          {percent.format(bucket.complaint_rate)}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </EngagementSurface>
        </div>
      </EngagementIdentityGate>
    </PageShell>
  );
}
